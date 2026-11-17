// Control C19's ending while a new source is ON and failing (step 2d of the new sources): BigQuery.gs noteEarlyWave_ asks
// NewSources.gs nsrcFailingEnd_ for " · ⚠️ a new source is failing (row N)", which edDayNoteText_ puts after everything
// else, within the note's 200 characters and never by cutting a number. With rows 48 to 50 OFF there is no ending, and
// C19 is byte for byte what it was. Everything here is made up.
'use strict';

module.exports = H => {
  const { test, eq, assert, makeGoogle, loadBot, NOW } = H;
  const MIN = 60 * 1000;
  const HOUR = 60 * MIN;
  const END = n => ` · ⚠️ a new source is failing (row ${n})`;
  const nums = (f, c, u, l, n, w) => ({ found: f, cards: c, under: u, letgo: l, never: n, waiting: w });
  const AT = 'Oct 14, 12:35 PM EDT';  // as long as a time gets
  const STOPS = ['', 'today\'s limit of 150 reviews is reached, more after midnight ET', 'daily cap of 40 reached, more tomorrow'];
  const PROBLEMS = ['', 'BigQuery refused the US job (HTTP 403: Access Denied: Table brand-social-central-data:reporting_data.sprinklr_inbound_comments: User does not have permission)'];

  test('C19 new sources (2d): edDayNoteText_ with the ending puts it after everything else, within 200 characters and with no number cut; with no ending every line is byte for byte what it was', () => {
    const b = loadBot(makeGoogle(NOW).services);
    const text = (s, n, o) => b.edDayNoteText_(s, n, o);
    [nums(12, 3, 0, 6, 1, 2), nums(999, 999, 999, 999, 999, 999), nums(99999, 99999, 99999, 99999, 99999, 99999)].forEach(n => {
      STOPS.forEach(stop => PROBLEMS.forEach(problem => [true, false].forEach(tab => {
        const base = text({ at: AT, problem }, n, { stop, tab });
        eq(text({ at: AT, problem }, n, { stop, tab, end: '' }), base);
        [48, 49].forEach(row => {
          const got = text({ at: AT, problem }, n, { stop, tab, end: END(row) });
          assert.ok(got.length <= 200, `${got.length}: ${got}`);
          assert.ok(got.endsWith(END(row)), got);
          // every number whole, in the order they were
          const counts = got.match(/today: (\d+) found, (\d+) cards?, (\d+) under another alert, (\d+) let go, (\d+) never reviewed, (\d+) waiting/);
          eq(counts && counts.slice(1).map(Number), [n.found, n.cards, n.under, n.letgo, n.never, n.waiting]);
          eq((got.match(/⚠️/g) || []).length, 1);
        });
      })));
    });
    // a short day keeps all of it: the line as it was, then the ending
    eq(text({ at: AT, problem: '' }, nums(12, 3, 0, 6, 1, 2), { tab: true, end: END(49) }),
      `last check ${AT} · today: 12 found, 3 cards, 0 under another alert, 6 let go, 1 never reviewed, 2 waiting · the Early Detection tab lists each one${END(49)}`);
  });

  test('C19 new sources (2d): the ending names the lowest failing row while its row is ON: the AMIE table stopped, paused or failing (row 48); Brandwatch live stopped, failing, or paused because Brandwatch refused the key or the read (row 49); never for a pause on the shared login, a 429, a quiet source or a lost parcel, and never while rows 48 to 50 are OFF', () => {
    const g = makeGoogle(NOW);
    const b = loadBot(g.services, g.clock);
    const amie = q => g.props.set('EWS_STATE', JSON.stringify({ v: 1, marks: { amiq: q }, day: {}, jobs: {} }));
    const bwl = st => g.props.set('BWL_STATE', JSON.stringify(st));
    const end = () => b.nsrcFailingEnd_();
    b.ewsRunSwitches_({ edAmie: true, edBwLive: true, earlyWave: true });
    eq(end(), '');  // nothing read yet: nothing failing
    // the AMIE table: a failed read pauses it an hour (paused), a stop for the day (stopped), a problem past its pause (failing)
    const prob = { k: 'failed', w: 'BigQuery refused the AMIE read (HTTP 500: Backend error)', at: NOW - 10 * MIN };
    amie({ prob, pu: NOW + HOUR });
    eq(end(), END(48));
    amie({ prob: { k: 'access', w: 'access denied', at: NOW - 10 * MIN }, sd: new Date(NOW).toISOString().slice(0, 10) });
    eq(end(), END(48));
    amie({ prob, pu: NOW - MIN });
    eq(end(), END(48));
    // Brandwatch refused as well: still the lowest row, 48; the AMIE table reads again: 49
    bwl({ pause: { kind: 'refused', until: NOW + HOUR, since: NOW - MIN }, fail: { kind: 'refused', why: 'Brandwatch refused the read (HTTP 403: Forbidden)', since: NOW - MIN } });
    eq(end(), END(48));
    amie({ rd: NOW - MIN, chg: NOW - MIN });
    eq(end(), END(49));
    // each state of Brandwatch live
    [[{ stop: { kind: 'x', why: 'Brandwatch sent 1 X post although the bot asked for none', since: NOW } }, END(49)],
      [{ fail: { kind: 'down', why: 'Brandwatch could not answer (HTTP 503: unavailable)', since: NOW - MIN } }, END(49)],
      [{ fail: { kind: 'secret', why: 'the bot can\'t read the shared Brandwatch key', since: NOW - MIN } }, END(49)],
      [{ pause: { kind: 'key', until: NOW + HOUR, since: NOW - 3 * HOUR } }, END(49)],
      [{ pause: { kind: 'refused', until: NOW - MIN, since: NOW - 2 * HOUR } }, ''],  // its hour is over: it reads again
      [{ pause: { kind: 'login', until: NOW + 5 * MIN, used: 470, limit: 600, since: NOW } }, ''],
      [{ pause: { kind: '429', until: NOW + 5 * MIN, since: NOW } }, ''],
      [{ last: NOW - MIN, lm: NOW - 5 * HOUR, lr: { at: NOW - MIN, n: 0 } }, ''],
      [{ dropped: { n: 40, at: NOW - MIN, why: 'HTTP 500' } }, ''],
      [{ last: NOW - MIN, lr: { at: NOW - MIN, n: 12 } }, '']].forEach(([st, want]) => { bwl(st); eq([JSON.stringify(st).slice(0, 60), end()], [JSON.stringify(st).slice(0, 60), want]); });
    // the rows: only an ON row's source counts; with rows 48 to 50 OFF there is never an ending
    amie({ prob, pu: NOW + HOUR });
    bwl({ stop: { kind: 'x', why: 'x', since: NOW } });
    b.ewsRunSwitches_({ edBwLive: true, earlyWave: true });
    eq(end(), END(49));
    b.ewsRunSwitches_({ edAmie: true, earlyWave: true });
    eq(end(), END(48));
    b.ewsRunSwitches_({ earlyWave: true });
    eq(end(), '');
    b.ewsRunSwitches_({});
    eq(end(), '');
    // a state that can't be read: no ending, no throw
    b.ewsRunSwitches_({ edAmie: true, edBwLive: true, earlyWave: true });
    g.props.set('EWS_STATE', '{not json');
    g.props.set('BWL_STATE', '{not json');
    eq(end(), '');
  });

  test('C19 new sources (2d): the note an Early Detection count writes (noteEarlyWave_) ends with it while Brandwatch live is refused and loses it once it reads again; with rows 48 to 50 OFF, and the same failing state stored, it is byte for byte the note with no new source', () => {
    const note = (sw, st) => {
      const g = makeGoogle(NOW);
      const b = loadBot(g.services, g.clock);
      if (st) g.props.set('BWL_STATE', JSON.stringify(st));
      b.ewsRunSwitches_(sw);
      b.noteEarlyWave_(b.PropertiesService.getScriptProperties(), 2, 1, '', {});
      return JSON.parse(g.props.get(b.ev('SWITCH_NOTES_PROP_')) || '{}').earlyWave.text;
    };
    const refused = { pause: { kind: 'refused', until: NOW + HOUR, since: NOW - MIN }, fail: { kind: 'refused', why: 'Brandwatch refused the read (HTTP 403: Forbidden)', since: NOW - MIN } };
    const plain = note({ earlyWave: true }, null);
    assert.match(plain, /^last check .* · today: \d+ found/);
    eq(note({ earlyWave: true }, refused), plain);
    eq(note({}, refused), plain);
    eq(note({ edBwLive: true, earlyWave: true }, refused), plain + END(49));
    eq(note({ edBwLive: true, earlyWave: true }, { last: NOW - MIN, lr: { at: NOW - MIN, n: 12 } }), plain);
  });
};
