// The Early Detection tab (EarlyDetectionTab.gs; setting early_detection_tab): every story signal Early Detection found
// and what became of it, one row each, newest first. Its rows are the run's record (EarlyDetectionNotes.gs edNote_);
// the tab only lays them out. poll() writes them in its last block, beside the Head start tab, with 30 seconds of the
// run left and never in a run still catching up on alerts; else they wait in one script-cache value. A tab of that
// name the bot didn't make is left alone, and the Control tab's Status says so.
'use strict';

module.exports = H => {
  const { test, eq, assert, world, e2e, NOW } = H;
  const golden = require('./golden_flows')(H);
  const ends = require('./ed_endings')(H);
  const DAY15 = require('./ed_tab_15nov.json');
  const MIN = 60 * 1000;
  const HOUR = 60 * MIN;
  const TAB = 'Early Detection';
  const TITLE = 'Early Detection: every story it found and what happened to each (written by the Burson QA bot)';
  const ABOUT = 'What\'s listed: each story Early Detection (Control row 19) found in posts from small accounts: several ' +
    'accounts saying the same thing, or a jump in how many accounts post on one topic. Newest first, the last 2,000. Outcome ' +
    'says what the bot did and Why gives the reason. Only rows that start "Card posted", "Update added" or "Added under" are ' +
    'in the space; the others were not posted, and Why says why ("Never reviewed": the bot did not get to review it).';
  const HEADER = ['When (ET)', 'Outcome', 'Story', 'Why', 'Card', 'Kind', 'Accounts', 'Platforms', 'Exposure Tag (first guess)', 'Id'];
  const NOTE = '⚠️ The Early Detection tab isn\'t being updated: a tab named "Early Detection" that the bot didn\'t make is in the way ' +
    '(or its title in A1 or a column name was changed). Rename that tab, and the bot makes its own.';
  const SPACE = 'spaces/AAQAedTabAc1';
  const link = n => `https://x.com/user${n}/status/${80000 + n}`;
  const msg = n => `${SPACE}/messages/card${n}.card${n}`;     // a card's Chat message name ("T.M": it can be linked)
  const msgUrl = n => `https://chat.google.com/room/AAQAedTabAc1/card${n}/card${n}`;

  /** A signal as the producer hands it over: story `n`, its posts' words, its main post's link. */
  const sig = (n, o) => Object.assign({
    alert_id: `ED-CLU-CLU-tab${String(n).padStart(4, '0')}-202611150800`, signal_type: 'CLUSTER_EMERGENCE',
    unique_low_tier_authors: 5, platforms_csv: 'X, Reddit', primary_url: link(n),
    headline: `Low-tier claim cluster (5 accounts): Pixel owners say the camera fails, story ${n}`,
  }, o || {});
  const sheetOf = w => w.g.services.SpreadsheetApp.create('bot');
  const tabOf = ss => ss.getSheetByName(TAB);
  const cache = w => w.g.services.CacheService.getScriptCache();
  const waiting = w => JSON.parse(cache(w).get('ed_tab_waiting') || 'null');
  /** The tab's data rows (row 5 on), each as {column name: cell}. */
  const data = tab => tab.rows.slice(4).map(r => Object.fromEntries(HEADER.map((h, i) => [h, r[i] === undefined ? '' : r[i]])));
  /** The run's record, as edNote_ makes it (the clock at `at`), for signal `row`. */
  const note = (w, at, row, outcome, why, extra) => {
    w.g.clock.now = at;
    return w.bot.edNote_({ now: () => at, log: () => {} }, row, outcome, why, extra);
  };
  const ctxAt = (w, at) => ({ now: () => at });
  /** Counts the calls the bot makes on a spreadsheet and on every sheet and range it is handed from it. */
  const counted = (obj, log) => new Proxy(obj, {
    get(target, k) {
      const v = target[k];
      if (typeof v !== 'function') return v;
      return (...args) => {
        log.push(String(k));
        const r = v.apply(target, args);
        return r && typeof r === 'object' && !Array.isArray(r) && (typeof r.getRange === 'function' || typeof r.setValues === 'function')
          ? counted(r, log) : r;
      };
    },
  });

  // ---------------------------------------------------------------------------------------------------------------
  // The tab and its rows
  // ---------------------------------------------------------------------------------------------------------------

  test('early detection tab: its title in A1, what\'s listed in row 2, today\'s numbers in row 3, the column names in row 4 (frozen), the rows newest first from row 5; made after the report tabs (Head start included) the first time there is a row, protected with a warning', () => {
    const w = world();
    const ss = sheetOf(w);
    ['Resources', 'Results', 'Follow-up', 'Head start', 'Alert log', 'Relay'].forEach(n => ss.insertSheet(n));
    const T = NOW;
    note(w, T, sig(1), 'Card posted: Monitor build-up', 'Early reports worth watching', { title: 'Pixel camera fails after the update',
      tag: 'Product - Product failures - general software/service issues', card: { id: 'QA-1001', message: msg(1) } });
    note(w, T + MIN, sig(2, { primary_url: '' }), 'Reviewed and dismissed', 'benign chatter, nothing for Google to act on',
      { title: 'People like the new wallpaper' });
    note(w, T + 2 * MIN, sig(3, { platforms_csv: 'TikTok' }), 'Its main post already has an alert', 'QA-0906 (BigQuery · BSIP, 8:01 AM ET)',
      { card: { id: 'QA-0906', message: `${SPACE}/messages/plainid` } });
    const out = w.bot.maybeWriteEdTab_(ss, ctxAt(w, T + 3 * MIN), { deadline: T + 4 * MIN });
    const tab = tabOf(ss);
    eq([out, ss.getSheets().map(s => s.getName())],
      [{ written: 3, waiting: 0, blocked: false }, ['Sheet1', 'Resources', 'Results', 'Follow-up', 'Head start', TAB, 'Alert log', 'Relay']]);
    eq([tab.cell(1, 1), tab.cell(2, 1), tab.rows[3], tab.frozenRows, tab.protections.length, tab.protections[0].warningOnly, w.bot.isEdTab_(tab)],
      [TITLE, ABOUT, HEADER, 4, 1, true, true]);
    eq(tab.cell(3, 1), 'Today (2026-10-14): 3 found · 1 card · 0 under another alert · 2 let go · 0 never reviewed · 0 waiting. Updated 8:03 AM ET.');
    eq(data(tab), [
      { 'When (ET)': '2026-10-14 08:02', Outcome: 'Its main post already has an alert', Story: `=HYPERLINK("${link(3)}","5 accounts posting “Pixel owners say the camera fails, story 3”")`,
        Why: 'QA-0906 (BigQuery · BSIP, 8:01 AM ET).', Card: 'QA-0906', Kind: 'Story', Accounts: 5, Platforms: 'TikTok', 'Exposure Tag (first guess)': '-',
        Id: 'ED-CLU-CLU-tab0003-202611150800' },
      { 'When (ET)': '2026-10-14 08:01', Outcome: 'Reviewed and dismissed', Story: 'People like the new wallpaper',
        Why: 'Benign chatter, nothing for Google to act on.', Card: '', Kind: 'Story', Accounts: 5, Platforms: 'X, Reddit',
        'Exposure Tag (first guess)': '-', Id: 'ED-CLU-CLU-tab0002-202611150800' },
      { 'When (ET)': '2026-10-14 08:00', Outcome: 'Card posted: Monitor build-up', Story: `=HYPERLINK("${link(1)}","Pixel camera fails after the update")`,
        Why: 'Early reports worth watching.', Card: `=HYPERLINK("${msgUrl(1)}","QA-1001")`, Kind: 'Story', Accounts: 5, Platforms: 'X, Reddit',
        'Exposure Tag (first guess)': 'Product - Product failures - general software/service issues', Id: 'ED-CLU-CLU-tab0001-202611150800' },
    ]);
    eq([tab.merges, waiting(w)], [['2,1,1,10'], null]);
    // the next run's rows go in above these, in one write; the rows already there are never changed
    const before = JSON.stringify(tab.rows.slice(4));
    note(w, T + HOUR, sig(4), 'Never reviewed', 'the review queue was full', { waited: true });
    eq(w.bot.maybeWriteEdTab_(ss, ctxAt(w, T + HOUR), { deadline: T + HOUR + MIN }).written, 4);  // this run's record still holds the first three
    w.bot.edNotesStart_();
    note(w, T + 2 * HOUR, sig(5), 'Not English', 'Most of its posts are not in English');
    eq(w.bot.maybeWriteEdTab_(ss, ctxAt(w, T + 2 * HOUR), { deadline: T + 2 * HOUR + MIN }).written, 1);
    eq(data(tab).map(r => [r['When (ET)'], r.Outcome]).slice(0, 2), [['2026-10-14 10:00', 'Not English'], ['2026-10-14 09:00', 'Never reviewed']]);
    eq([ss.getSheets().filter(s => s.getName() === TAB).length, tab.cell(1, 1), tab.rows[3]], [1, TITLE, HEADER]);
    eq(JSON.stringify(tab.rows.slice(-3)), before);
  });

  test('early detection tab: a run with no row makes no Sheets call at all; a run with rows makes a fixed few (the ownership check, one insert, one write, row 3, the new rows\' formats, the trim\'s count), and the first one makes the tab', () => {
    const w = world();
    const real = sheetOf(w);
    const log = [];
    const ss = counted(real, log);
    w.bot.edNotesStart_();
    eq([w.bot.maybeWriteEdTab_(ss, ctxAt(w, NOW), { deadline: NOW + 4 * MIN }), log], [{ written: 0, waiting: 0, blocked: false }, []]);
    // the first rows: the tab is made
    note(w, NOW, sig(1), 'Reviewed and dismissed', 'Nothing for Google to act on');
    w.bot.maybeWriteEdTab_(ss, ctxAt(w, NOW), { deadline: NOW + 4 * MIN });
    const making = log.splice(0);
    assert.ok(making.includes('insertSheet'), making.join(' '));
    // a run with rows on the tab the bot made
    w.bot.edNotesStart_();
    note(w, NOW + MIN, sig(2), 'Reviewed and dismissed', 'Nothing for Google to act on');
    note(w, NOW + MIN, sig(3), 'Reviewed and dismissed', 'Nothing for Google to act on');
    eq(w.bot.maybeWriteEdTab_(ss, ctxAt(w, NOW + MIN), { deadline: NOW + 4 * MIN }).written, 2);
    eq(log.splice(0), ['getSheetByName', 'getLastRow', 'getRange', 'getDisplayValue', 'getRange', 'getDisplayValues', 'insertRowsBefore', 'getRange', 'setValues',
      'getRange', 'setValue', 'getRange', 'setFontWeight', 'setFontStyle', 'setBackground', 'setFontColor', 'setWrap', 'setVerticalAlignment',
      'getRange', 'setNumberFormat', 'getLastRow']);
    // and once more without a row: none
    w.bot.edNotesStart_();
    w.bot.maybeWriteEdTab_(ss, ctxAt(w, NOW + 2 * MIN), { deadline: NOW + 4 * MIN });
    eq(log, []);
    eq(data(tabOf(real)).map(r => r.Id), [sig(3).alert_id, sig(2).alert_id, sig(1).alert_id]);
  });

  test('early detection tab: rows of one write are sorted newest first (the same time: the one noted later first), and rows a person sorted are left as they are: new rows still go in under row 4', () => {
    const w = world();
    const ss = sheetOf(w);
    const rows = [[NOW + 2 * MIN, 1], [NOW, 2], [NOW + 5 * MIN, 3], [NOW + 2 * MIN, 4]]
      .map(([at, n]) => w.bot.edNoteRow_(sig(n), 'Reviewed and dismissed', 'Nothing for Google to act on', {}, at));
    w.bot.writeEdTab_(ss, rows, null, NOW + 6 * MIN);
    const tab = tabOf(ss);
    eq(data(tab).map(r => r.Id.slice(11, 18)), ['tab0003', 'tab0004', 'tab0001', 'tab0002']);
    // a person sorts the data rows by Id (Sheets' sort leaves the frozen rows where they are)
    const sorted = tab.rows.slice(4).sort((a, b) => String(a[9]).localeCompare(String(b[9])));
    tab.rows.splice(4, sorted.length, ...sorted);
    const theirs = JSON.stringify(tab.rows.slice(4));
    w.bot.writeEdTab_(ss, [w.bot.edNoteRow_(sig(9), 'Not English', 'Most of its posts are not in English', {}, NOW + HOUR)], null, NOW + HOUR);
    eq([data(tab)[0].Id.slice(11, 18), JSON.stringify(tab.rows.slice(5)), tab.rows[3], tab.cell(1, 1)], ['tab0009', theirs, HEADER, TITLE]);
  });

  test('early detection tab: past 2,000 data rows the bottom rows are deleted, the header and the newest 2,000 stay; a new row\'s cells set their own formats and its time is text, so nothing rests on what it inherits from the row next to it', () => {
    const w = world();
    const ss = sheetOf(w);
    const many = (from, n) => Array.from({ length: n }, (_, i) =>
      w.bot.edNoteRow_(sig(from + i), 'Never reviewed', 'The review queue was full', {}, NOW + (from + i) * MIN));
    w.bot.writeEdTab_(ss, many(0, 1990), null, NOW + 2000 * MIN);
    const tab = tabOf(ss);
    eq([tab.rows.length, tab.rows[3], tab.cell(5, 10), tab.cell(1994, 10)], [1994, HEADER, sig(1989).alert_id, sig(0).alert_id]);
    // the formats of the new rows, set in the same write: the font, the background, the colour, and Accounts as a number
    const set = [];
    const real = tab.getRange.bind(tab);
    tab.getRange = (r, c, nr, nc) => {
      const range = real(r, c, nr, nc);
      ['setFontWeight', 'setFontStyle', 'setBackground', 'setFontColor', 'setNumberFormat'].forEach(f => {
        const was = range[f];
        range[f] = v => { set.push([f, r, c, nr || 1, nc || 1, v]); return was.call(range, v); };
      });
      return range;
    };
    w.bot.writeEdTab_(ss, many(1990, 15), null, NOW + 3000 * MIN);
    tab.getRange = real;
    eq(set, [['setFontWeight', 5, 1, 15, 10, 'normal'], ['setFontStyle', 5, 1, 15, 10, 'normal'], ['setBackground', 5, 1, 15, 10, null],
      ['setFontColor', 5, 1, 15, 10, null], ['setNumberFormat', 5, 7, 15, 1, '0']]);
    eq([tab.rows.length, tab.rows[3], tab.cell(1, 1), tab.cell(5, 10), tab.cell(2004, 10), tab.rows.slice(4).filter(r => r[9]).length],
      [2004, HEADER, TITLE, sig(2004).alert_id, sig(5).alert_id, 2000]);
    // the time is written as text (a leading apostrophe): Sheets keeps it as it is, whatever the cell's format
    const cells = w.bot.edTabRow_(many(7, 1)[0]);
    eq(cells[0], '\'2026-10-14 08:07');
  });

  test('early detection tab: text from outside is never read as a formula: a headline, a reason, a tag or a platform that starts with = + - @ is written as text (the Why too), the only formulas are the quoted links, a quote can\'t end them, and every cell stays at or under 49,000 characters', () => {
    const w = world();
    const row = w.bot.edNoteRow_(sig(1, { platforms_csv: '@X' }), 'Reviewed and dismissed',
      '=IMPORTXML("https://evil.test","//a")', { title: '=HYPERLINK("https://evil.test","x")&"', tag: '+cmd|\' /C calc\'!A0' }, NOW);
    const cells = w.bot.edTabRow_(row);
    eq([cells[2], cells[3], cells[7], cells[8]], [
      `=HYPERLINK("${link(1)}","=HYPERLINK(""https://evil.test"",""x"")&""")`,
      '\'=IMPORTXML("https://evil.test","//a").', '\'@X', '\'+cmd|\' /C calc\'!A0']);
    const plain = w.bot.edTabRow_(w.bot.edNoteRow_(sig(2, { primary_url: '' }), 'Reviewed and dismissed', '-1 accounts', { title: '=1+1' }, NOW));
    eq([plain[2], plain[3]], ['\'=1+1', '\'-1 accounts.']);
    // a card whose message name gives no link is its id, as text; an id that starts like a formula too
    const odd = w.bot.edTabRow_(w.bot.edNoteRow_(sig(3), 'Its main post already has an alert', 'Covered', { card: { id: '=QA-9', message: `${SPACE}/messages/nodot` } }, NOW));
    eq(odd[4], '\'=QA-9');
    const LINK = /^=HYPERLINK\("https?:\/\/(?:[^"]|"")*","(?:[^"]|"")*"\)$/;
    const all = [].concat(cells, plain, odd).filter(v => typeof v === 'string' && /^[=+\-@]/.test(v));
    eq(all.filter(v => !LINK.test(v)), []);
    // written: the same; the cell cap holds for a row of any length (the record row is at most 448 characters anyway)
    const ss = sheetOf(w);
    w.bot.writeEdTab_(ss, [row], { lost: 0 }, NOW);
    const tab = tabOf(ss);
    tab.rows.forEach((x, i) => x.forEach((v, j) => assert.ok(String(v).length <= 49000, `row ${i + 1} column ${j + 1}`)));
    eq(w.bot.speedText_('A'.repeat(60000)).length, 49000);
  });

  // ---------------------------------------------------------------------------------------------------------------
  // A tab the bot didn't make
  // ---------------------------------------------------------------------------------------------------------------

  test('early detection tab: a tab named "Early Detection" the bot didn\'t make (another title in A1, an empty tab, or the bot\'s own with a column name changed) is never read beyond its first four rows, cleared, written or protected; the rows wait, and once it is renamed the bot makes its own and writes them', () => {
    const w = world();
    const ss = sheetOf(w);
    const theirs = ss.insertSheet(TAB);
    theirs.getRange(1, 1, 2, 2).setValues([['Early Detection: my own notes', 'Owner'], ['keep', 'this']]);
    const kept = JSON.stringify(theirs.rows);
    const untouched = () => [JSON.stringify(theirs.rows), theirs.protections.length, theirs.cleared || [], theirs.merges || [],
      theirs.formatsCleared || 0, theirs.frozenRows, ss.getSheets().filter(s => s.getName() === TAB).length];
    note(w, NOW, sig(1), 'Reviewed and dismissed', 'Nothing for Google to act on');
    eq([w.bot.maybeWriteEdTab_(ss, ctxAt(w, NOW), { deadline: NOW + 4 * MIN }), untouched()],
      [{ written: 0, waiting: 1, blocked: true }, [kept, 0, [], [], 0, undefined, 1]]);
    eq([w.g.props.get('ED_TAB_BLOCKED'), w.bot.edTabBlockedNote_(), w.bot.ensureEdTab_(ss), waiting(w).r.length], [
      'true', NOTE.slice(3), null, 1]);
    // an empty tab with the name isn't the bot's either
    const ss2 = sheetOf(w);
    const blank = ss2.insertSheet(TAB);
    eq([w.bot.isEdTab_(blank), w.bot.writeEdTab_(ss2, w.bot.edNotesOfRun_(), null, NOW), blank.rows, blank.protections.length],
      [false, { blocked: true, written: 0 }, [], 0]);
    // renamed: the waiting row and this run's go on the bot's own tab, and the note goes
    theirs.setName('My early detection notes');
    w.bot.edNotesStart_();
    note(w, NOW + MIN, sig(2), 'Not English', 'Most of its posts are not in English');
    eq(w.bot.maybeWriteEdTab_(ss, ctxAt(w, NOW + MIN), { deadline: NOW + 4 * MIN }), { written: 2, waiting: 0, blocked: false });
    eq([data(tabOf(ss)).map(r => r.Outcome), JSON.stringify(theirs.rows), w.g.props.has('ED_TAB_BLOCKED'), w.bot.edTabBlockedNote_(), waiting(w)],
      [['Not English', 'Reviewed and dismissed'], kept, false, '', null]);
    // the bot's own tab with a column name changed (or its title) is no longer known as the bot's: left as it is
    const own = tabOf(ss);
    own.getRange(4, 4).setValue('Reason');
    const edited = JSON.stringify(own.rows);
    w.bot.edNotesStart_();
    note(w, NOW + 2 * MIN, sig(3), 'Not English', 'Most of its posts are not in English');
    eq([w.bot.maybeWriteEdTab_(ss, ctxAt(w, NOW + 2 * MIN), { deadline: NOW + 4 * MIN }).blocked, JSON.stringify(own.rows)], [true, edited]);
    own.getRange(4, 4).setValue('Why');
    own.getRange(1, 1).setValue('Early Detection');
    eq([w.bot.isEdTab_(own), w.bot.maybeWriteEdTab_(ss, ctxAt(w, NOW + 3 * MIN), { deadline: NOW + 4 * MIN }).blocked], [false, true]);
  });

  test('early detection tab: a tab in the way shows where people look, the Control tab\'s Status (B5), after the Head start tab\'s note: from the run after the write that found it, until it is renamed. In the main status and in the one-space setup\'s', () => {
    const OK = '✅ Working';
    const HEAD_NOTE = '⚠️ The Head start tab isn\'t being updated: a tab named "Head start" that the bot didn\'t make is in the way (or its title in A1 ' +
      'was changed). Rename that tab, and the bot makes its own.';
    const pollWorld = () => {
      const t = e2e();
      t.bot.setup();
      t.set('B30', 'tester@testing.test');
      return t;
    };
    const oneSpace = () => {
      const t = pollWorld();
      t.chat.addSpace(SPACE, 'SLRR One Space (tab)');
      t.set('B25', H.REAL);
      ['B3', 'B4', 'B9'].forEach(c => t.set(c, ''));
      t.set('B10', 'SLRR One Space (tab)');
      return t;
    };
    [['the main status', pollWorld], ['the one-space setup', oneSpace]].forEach(([where, make]) => {
      const t = make();
      const rows = [t.bot.edNoteRow_(sig(1), 'Reviewed and dismissed', 'Nothing for Google to act on', {}, NOW)];
      t.bot.edNotesOfRun_ = () => rows.map(r => r.slice());  // this run's record (Early Detection ended one signal)
      const theirs = t.sheet().insertSheet(TAB);
      theirs.getRange(1, 1).setValue('Early Detection notes');
      const kept = JSON.stringify(theirs.rows);
      t.poll();  // the write at the run's end finds the tab in the way
      eq([t.get('B5'), t.g.props.get('ED_TAB_BLOCKED'), JSON.stringify(theirs.rows)], [OK, 'true', kept], where);
      t.poll();
      eq([t.get('B5'), JSON.stringify(theirs.rows), theirs.protections.length], [NOTE, kept, 0], where);
      t.g.props.set('HEAD_START_BLOCKED', 'true');  // the Head start tab's note comes first
      t.poll();
      eq(t.get('B5'), HEAD_NOTE, where);
      t.g.props.delete('HEAD_START_BLOCKED');
      theirs.setName('My notes');
      t.poll();  // this run's write makes the bot's own tab
      eq([tabOf(t.sheet()).cell(1, 1), t.g.props.has('ED_TAB_BLOCKED'), data(tabOf(t.sheet())).map(r => r.Id)], [TITLE, false, [sig(1).alert_id]], where);
      t.poll();
      eq(t.get('B5'), OK, where);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  // Rows that wait
  // ---------------------------------------------------------------------------------------------------------------

  test('early detection tab: a run with under 30 seconds left, or still catching up on alerts, writes nothing: its rows wait in one cache value (6 hours) and the next run with time writes them with its own; after a cache loss the next run writes its own rows and nothing breaks', () => {
    const w = world();
    const ss = sheetOf(w);
    const puts = [];
    const c = cache(w);
    const put = c.put;
    w.g.services.CacheService.getScriptCache = () => Object.assign({}, c, { put: (k, v, s) => { puts.push([k, s]); return put(k, v, s); } });
    note(w, NOW, sig(1), 'Reviewed and dismissed', 'Nothing for Google to act on');
    eq([w.bot.maybeWriteEdTab_(ss, ctxAt(w, NOW), { deadline: NOW + 29999 }), tabOf(ss), puts], [{ written: 0, waiting: 1, blocked: false }, null,
      [['ed_tab_run', 21600], ['ed_tab_waiting', 21600]]]);  // the row was handed over as it was noted, then left waiting
    // a run catching up on alerts (a flow held an alert for the next run): the same
    w.bot.edNotesStart_();
    note(w, NOW + MIN, sig(2), 'Not English', 'Most of its posts are not in English');
    eq(w.bot.maybeWriteEdTab_(ss, ctxAt(w, NOW + MIN), { deadline: NOW + 4 * MIN, flows: [{ ctx: {}, report: { held: 1 } }] }),
      { written: 0, waiting: 2, blocked: false });
    eq([tabOf(ss), waiting(w).r.map(r => r[1])], [null, [sig(1).alert_id, sig(2).alert_id]]);
    w.bot.edNotesStart_();
    note(w, NOW + 2 * MIN, sig(3), 'Not English', 'Most of its posts are not in English');
    eq(w.bot.maybeWriteEdTab_(ss, ctxAt(w, NOW + 2 * MIN), { deadline: NOW + 4 * MIN }), { written: 3, waiting: 0, blocked: false });
    eq([data(tabOf(ss)).map(r => r.Id), waiting(w)], [[sig(3).alert_id, sig(2).alert_id, sig(1).alert_id], null]);
    // rows wait, then the cache is lost: they are gone, and the next run writes its own
    w.bot.edNotesStart_();
    note(w, NOW + 3 * MIN, sig(4), 'Not English', 'Most of its posts are not in English');
    w.bot.maybeWriteEdTab_(ss, ctxAt(w, NOW + 3 * MIN), { deadline: NOW + 3 * MIN });
    c.remove('ed_tab_waiting');
    w.bot.edNotesStart_();
    note(w, NOW + 4 * MIN, sig(5), 'Not English', 'Most of its posts are not in English');
    eq(w.bot.maybeWriteEdTab_(ss, ctxAt(w, NOW + 4 * MIN), { deadline: NOW + 8 * MIN }), { written: 1, waiting: 0, blocked: false });
    eq(data(tabOf(ss)).map(r => r.Id), [sig(5).alert_id, sig(3).alert_id, sig(2).alert_id, sig(1).alert_id]);
  });

  test('early detection tab: a write that fails loses no row and doesn\'t break the run: the rows put in for it are taken out again, the rows wait, the log says so, and the next run writes them all', () => {
    const w = world();
    const ss = sheetOf(w);
    note(w, NOW, sig(1), 'Reviewed and dismissed', 'Nothing for Google to act on');
    w.bot.maybeWriteEdTab_(ss, ctxAt(w, NOW), { deadline: NOW + 4 * MIN });
    const tab = tabOf(ss);
    const before = JSON.stringify(tab.rows);
    const real = tab.getRange.bind(tab);
    tab.getRange = (r, c, nr, nc) => {
      const range = real(r, c, nr, nc);
      range.setValues = () => { throw new Error('Sheets is down'); };
      return range;
    };
    w.bot.edNotesStart_();
    note(w, NOW + MIN, sig(2), 'Not English', 'Most of its posts are not in English');
    note(w, NOW + MIN, sig(3), 'Not English', 'Most of its posts are not in English');
    let out;
    assert.doesNotThrow(() => { out = w.bot.maybeWriteEdTab_(ss, ctxAt(w, NOW + MIN), { deadline: NOW + 4 * MIN }); });
    eq([out, JSON.stringify(tab.rows) === before, waiting(w).r.length, w.g.logs.slice(-1)], [{ written: 0, waiting: 2, blocked: false }, true, 2,
      ['ERROR Early Detection tab not written (its rows wait for the next run): Sheets is down']]);
    // the insert fails: the same
    tab.getRange = real;
    const insert = tab.insertRowsBefore;
    tab.insertRowsBefore = () => { throw new Error('Service unavailable'); };
    eq([w.bot.maybeWriteEdTab_(ss, ctxAt(w, NOW + MIN), { deadline: NOW + 4 * MIN }).waiting, JSON.stringify(tab.rows) === before], [2, true]);
    tab.insertRowsBefore = insert;
    w.bot.edNotesStart_();
    note(w, NOW + 2 * MIN, sig(4), 'Not English', 'Most of its posts are not in English');
    eq(w.bot.maybeWriteEdTab_(ss, ctxAt(w, NOW + 2 * MIN), { deadline: NOW + 4 * MIN }).written, 3);
    eq(data(tab).map(r => r.Id), [sig(4).alert_id, sig(3).alert_id, sig(2).alert_id, sig(1).alert_id]);
    // from poll(): a tab whose write throws never stops the run (the rest of the run's last block and the Control tab)
    const t = e2e();
    t.bot.setup();
    t.set('B30', 'tester@testing.test');
    t.bot.edNotesOfRun_ = () => [t.bot.edNoteRow_(sig(7), 'Not English', 'Most of its posts are not in English', {}, NOW)];
    t.bot.writeEdTab_ = () => { throw new Error('Sheets is down'); };
    t.poll();
    t.poll();
    eq([t.get('B5'), JSON.parse(t.g.services.CacheService.getScriptCache().get('ed_tab_waiting')).r.length], ['✅ Working', 1]);
  });

  test('early detection tab: what waits is held to 200 rows and 90,000 characters and bytes (the worst case of 200 full rows of non-Latin text); the rows that had to go are counted, the newest stay, and the next write says "N outcomes were not recorded (the runs were full)" in one row under them', () => {
    const w = world();
    const words = 'Камера Pixel вылетает после обновления 相机崩溃 📷 '.repeat(20);
    const rows = Array.from({ length: 230 }, (_, i) => w.bot.edNoteRow_(sig(i, { headline: words, platforms_csv: 'X, Reddit, TikTok, YouTube, Instagram' }),
      'Reviewed, but its card could not be posted', words, { title: words, tag: words }, NOW + i * 1000));
    eq(Math.max.apply(null, rows.map(r => JSON.stringify(r).length)), 448);
    const left = w.bot.edTabWait_(rows, 0, 0);
    const raw = cache(w).get('ed_tab_waiting');
    const v = JSON.parse(raw);
    assert.ok(raw.length <= 90000, `${raw.length} characters`);
    assert.ok(Buffer.byteLength(raw, 'utf8') <= 90000, `${Buffer.byteLength(raw, 'utf8')} bytes`);
    eq([left, v.r.length, v.n, v.r.length + v.n, v.la], [v.r.length, left, 230 - left, 230, NOW + (229 - left) * 1000]);
    assert.ok(left <= 200 && left >= 100, String(left));
    eq(v.r[v.r.length - 1][1], sig(229).alert_id);  // the newest stay
    eq(w.bot.edTabBytes_(raw), Buffer.byteLength(raw, 'utf8'));
    // 200 short rows fit as they are; a row more and the oldest goes, counted
    const short = Array.from({ length: 201 }, (_, i) => w.bot.edNoteRow_(sig(i), 'Not English', 'No', {}, NOW + i * 1000));
    eq(w.bot.edTabWait_(short, 0, 0), 200);
    eq([waiting(w).n, waiting(w).r[0][1]], [1, sig(1).alert_id]);
    // the next write: the 200 rows, then the row that says what had to go
    const ss = sheetOf(w);
    w.bot.edNotesStart_();
    eq(w.bot.maybeWriteEdTab_(ss, ctxAt(w, NOW + HOUR), { deadline: NOW + HOUR + MIN }).written, 201);
    const tab = tabOf(ss);
    eq([tab.cell(5, 10), tab.cell(204, 10), tab.rows[204], waiting(w)],
      [sig(200).alert_id, sig(1).alert_id, ['2026-10-14 08:00', '1 outcome was not recorded (the runs were full)', '', '', '', '', '', '', '', ''], null]);
    eq(w.bot.edTabLostRow_(12, NOW)[1], '\'12 outcomes were not recorded (the runs were full)');  // written as text
  });

  // ---------------------------------------------------------------------------------------------------------------
  // The setting, the real signals, the flows
  // ---------------------------------------------------------------------------------------------------------------

  test('early detection tab: with the setting early_detection_tab off no tab is made, read or written, nothing waits (what waited is let go), no Sheets call is made and Status says nothing of the tab', () => {
    const w = world();
    const real = sheetOf(w);
    const theirs = real.insertSheet(TAB);
    theirs.getRange(1, 1).setValue('their notes');
    note(w, NOW, sig(1), 'Reviewed and dismissed', 'Nothing for Google to act on');
    w.bot.maybeWriteEdTab_(real, ctxAt(w, NOW), { deadline: NOW + 4 * MIN });
    eq([waiting(w).r.length, w.bot.edTabBlockedNote_() !== ''], [1, true]);
    w.bot.ev('GEN').settings.early_detection_tab = false;
    const log = [];
    const ss = counted(real, log);
    note(w, NOW + MIN, sig(2), 'Not English', 'Most of its posts are not in English');
    eq([w.bot.maybeWriteEdTab_(ss, ctxAt(w, NOW + MIN), { deadline: NOW + 4 * MIN }), log, waiting(w), w.bot.edTabBlockedNote_(),
      w.g.props.has('ED_TAB_BLOCKED'), theirs.cell(1, 1)], [{ written: 0, waiting: 0, blocked: false }, [], null, '', false, 'their notes']);
    // and through poll() in the one-space setup with every new setting off: no tab
    const { t } = golden.oneSpaceRun(golden.SETTINGS_OFF);
    eq([tabOf(t.sheet()), t.g.services.CacheService.getScriptCache().get('ed_tab_waiting')], [null, null]);
  });

  test('early detection tab: the five real signals of 15 November (their headlines and the fast triage\'s answers as the bot read them) read in plain words: never the producer\'s label, the first-guess tag with how sure and the severity, the topic count in words, and the reason without decimals', () => {
    const w = world();
    const ss = sheetOf(w);
    const at = Date.UTC(2026, 10, 15, 20, 51);  // 3:51 PM ET, when the first two were read
    const rows = DAY15.signals.map(s => Object.assign({ alert_id: s.alert_id, signal_type: s.signal_type, unique_low_tier_authors: s.accounts,
      headline: s.headline }, s.velocity_grain ? { velocity_grain: s.velocity_grain, signal_key: s.signal_key, velocity_ratio: s.velocity_ratio } : {}));
    // What became of them, as the fast triage and the old daily cap would have it that afternoon: the first held back as
    // routine noise (its hold_back), the topic count let go as a topic busier than usual, the other three never reviewed
    note(w, at, rows[0], 'Held back as noise (no review)', w.bot.edNoiseWhy_(DAY15.signals[0].answers, DAY15.signals[0].hold_back),
      { dec: DAY15.signals[0].answers });
    note(w, at, rows[1], 'Never reviewed', w.bot.edNeverWhy_('day'), { dec: DAY15.signals[1].answers });
    note(w, at + 16 * MIN, rows[2], 'Topic busier than usual, not a story', 'A topic count under 3x the usual', { dec: DAY15.signals[2].answers });
    note(w, at + 32 * MIN, rows[3], 'Never reviewed', w.bot.edNeverWhy_('day'), { dec: DAY15.signals[3].answers });
    note(w, at + 32 * MIN, rows[4], 'Never reviewed', w.bot.edNeverWhy_('day'), { dec: DAY15.signals[4].answers });
    w.bot.maybeWriteEdTab_(ss, ctxAt(w, at + 33 * MIN), { deadline: at + 40 * MIN });
    const shown = data(tabOf(ss)).map(r => [r['When (ET)'], r.Outcome, r.Story, r.Why, r.Kind, r.Accounts, r['Exposure Tag (first guess)'], r.Id]);
    eq(shown, [
      ['2026-11-15 16:23', 'Never reviewed', '5 accounts posting “A close-up, high-contrast image showing white text on a dark gray bac…”',
        'Today\'s limit of 40 was reached.', 'Story', 5, 'Product - Product failures - general software/service issues (22% sure) · severity low', DAY15.signals[4].alert_id],
      ['2026-11-15 16:23', 'Never reviewed', '4 accounts posting “i can’t even find the site when googling it”', 'Today\'s limit of 40 was reached.', 'Story', 4,
        'None: not a brand-safety issue (81% sure) · severity none', DAY15.signals[3].alert_id],
      ['2026-11-15 16:07', 'Topic busier than usual, not a story', 'Topic: Search & Shopping, 36 accounts in an hour (1.9x the usual)',
        'A topic count under 3x the usual.', 'Pace jump (topic)', 36, 'None: not a brand-safety issue (86% sure) · severity none', DAY15.signals[2].alert_id],
      ['2026-11-15 15:51', 'Never reviewed', '5 accounts posting “A screenshot of an e-commerce product page for a \'Gemini Ultra\' accou…”',
        'Today\'s limit of 40 was reached.', 'Story', 5, 'Product - Scams involving Google products (46% sure) · severity none', DAY15.signals[1].alert_id],
      ['2026-11-15 15:51', 'Held back as noise (no review)', '5 accounts posting “They didn\'t even invited 😢 Who wants techno gamerz 👇”',
        'Looks like routine chatter (90% likely), severity low (57% sure).', 'Story', 5,
        'Content - Negative reaction to owned social post (32% sure) · severity low', DAY15.signals[0].alert_id],
    ]);
    const text = JSON.stringify(tabOf(ss).rows.map(r => r.slice(0, 9)));  // all but the Id (a topic count's id names its grain)
    eq([text.match(/Low-tier|PRIORITY_TOPIC|\bP[012]\b|\d\.\d\d/), /@|spaces\//.test(text)], [null, false]);
    eq(tabOf(ss).cell(3, 1), 'Today (2026-11-15): 5 found · 0 cards · 0 under another alert · 2 let go · 3 never reviewed · 0 waiting. Updated 4:24 PM ET.');
  });

  test('early detection tab: the long mixed day of the one-space setup, through poll(): every row the runs recorded is on the tab once, newest first, and row 3 is the day\'s numbers as Control C19 has them', () => {
    const w = ends.world({ flow: 'one-space' });
    const recorded = [];
    const props = () => w.t.g.services.PropertiesService.getScriptProperties();
    let shown = null;  // the day's numbers at the last run that wrote the tab, and C19 then
    ends.day(w, () => {
      recorded.push(...w.t.bot.edNotesOfRun_());
      const tab = tabOf(w.t.sheet());
      if (tab && !w.t.g.services.CacheService.getScriptCache().get('ed_tab_waiting')) {
        shown = { n: w.t.bot.edDayNumbers_(props()), row3: tab.cell(3, 1), c19: String(w.sh.cell(19, 3)) };
      }
    });
    eq(w.t.g.services.CacheService.getScriptCache().get('ed_tab_waiting'), null);  // nothing left waiting at the day's end
    const tab = tabOf(w.t.sheet());
    const want = w.t.bot.edTabSorted_(recorded).map(r => [r[1], r[2]]);
    eq([recorded.length > 30, data(tab).map(r => [r.Id, r.Outcome])], [true, want]);
    const n = shown.n;
    assert.match(shown.row3, new RegExp(`^Today \\(\\d{4}-\\d\\d-\\d\\d\\): ${n.found} found · ${n.cards} cards? · ${n.under} under another alert · ` +
      `${n.letgo} let go · ${n.never} never reviewed · ${n.waiting} waiting\\. Updated \\d{1,2}:\\d\\d [AP]M ET\\.$`));
    assert.ok(shown.c19.includes(`${n.found} found, ${n.cards} card`), shown.c19);
    eq(w.t.g.props.has('ED_TAB_BLOCKED'), false);
  });

  test('early detection tab: the golden scenarios put out exactly what they recorded with the default settings (the tab is made, and nothing posted moves) and with every new setting off (no tab)', () => {
    const def = golden.oneSpaceRun();
    eq(golden.differences(def.out, JSON.parse(require('fs').readFileSync(require('path').join(__dirname, 'golden_flows_defaults.json'), 'utf8')).one_space), []);
    const tab = tabOf(def.t.sheet());
    eq([tab && tab.cell(1, 1), tab && tab.rows[3]], [TITLE, HEADER]);
    eq(golden.differences(golden.oneSpace(golden.SETTINGS_OFF), golden.recorded.one_space), []);
    eq(golden.differences(golden.mirror(golden.SETTINGS_OFF), golden.recorded.mirror), []);
    eq(golden.differences(golden.mirror(), golden.recorded.mirror), []);
  });
};
