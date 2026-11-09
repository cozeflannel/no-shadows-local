// Run owner and locks (review findings H7 and R3's locking notes, Main.gs): a run that went past the script lock's
// reach let the next minute's run start beside it, and both handled the same alert. poll() now also claims the script
// property RUN_OWNER right after taking the lock; a run that finds another run's claim younger than 25 minutes returns
// without doing anything, and the run checks its claim again before each message (Bot.gs) and before each email send or
// draft (Drafts.gs). A LockService error skips the minute quietly; setup() waits up to 5 minutes for a run, then says
// so; setup() also removes the orphaned checkSourceSpaceForNewMessages trigger.
'use strict';

module.exports = H => {
  const { test, eq, assert, F, NOW, e2e, makeGoogle, TEST_FEED, TRIAGED } = H;
  const SAM_ID = '2109952063492993159';  // F.P0_OK's post
  const AIO_ID = '1845000000000000001';  // F.AIO's post
  const forwarded = (t, id) => t.chat.botPosts(TRIAGED).some(m => !m.threadReply && m.text.includes(id));
  const logRows = t => {
    const log = t.sheet().getSheetByName('Alert log');
    const h = log.rows[0];
    return log.rows.slice(1).map(r => Object.fromEntries(h.map((c, i) => [c, r[i]])));
  };
  const claim = (id, started) => JSON.stringify({ id, started });
  /** setup(), with the stand-in at testing.test (the e2e world builds its runs with Main.gs buildCtx_). */
  const ready = () => {
    const t = e2e();
    t.bot.setup();
    t.bot.ev('GEN').email.stand_in = 'tester@testing.test';
    return t;
  };

  test('run owner: a run that finds another run\'s claim younger than 25 minutes does nothing (no Chat call, no write); an older claim is a run that died: taken over; the claim is cleared at the end of the run', () => {
    const t = ready();
    t.chat.say(TEST_FEED, F.P0_OK, { sender: 'users/bot' });
    const other = claim('other-run', t.g.clock.now - 7 * 60e3);  // a run that started 7 minutes ago is still going
    t.g.props.set('RUN_OWNER', other);
    const before = { props: JSON.stringify(Array.from(t.g.props)), sheets: JSON.stringify(t.sheet().sheets.map(s => s.rows)),
      chat: t.chat.calls.length, vertex: t.g.vertex.calls.length };
    t.poll();
    eq([JSON.stringify(Array.from(t.g.props)), JSON.stringify(t.sheet().sheets.map(s => s.rows)), t.chat.calls.length,
      t.g.vertex.calls.length], [before.props, before.sheets, before.chat, before.vertex]);
    assert.ok(t.g.logs.some(l => /^run skipped: the run that started at 2026-10-14T\d\d:\d\d:\d\d\.\d{3}Z is still going$/.test(l)), t.g.logs.join('\n'));
    assert.ok(!forwarded(t, SAM_ID));
    // 26 minutes after that claim: this run takes over, handles the alert and clears its own claim at the end
    t.g.props.set('RUN_OWNER', claim('other-run', t.g.clock.now - 26 * 60e3));
    t.poll();
    assert.ok(forwarded(t, SAM_ID));
    eq([t.g.props.has('RUN_OWNER'), t.g.gmail.sentMessages().length], [false, 1]);
    // A claim from the clock's far future (a broken value) or one that isn't JSON is taken over too
    t.g.props.set('RUN_OWNER', claim('broken', t.g.clock.now + 3 * 3600e3));
    t.chat.say(TEST_FEED, F.AIO, { sender: 'users/bot' });
    t.poll();
    assert.ok(forwarded(t, AIO_ID));
    t.g.props.set('RUN_OWNER', '{not json');
    t.poll();
    assert.ok(!t.g.props.has('RUN_OWNER'));
  });

  test('run owner: another run taking over mid-run stops this one before its email and before the next message; the other run\'s claim stays; once it\'s gone, the next run sends both, once each', () => {
    const t = ready();
    t.chat.say(TEST_FEED, F.P0_OK, { sender: 'users/bot' });
    t.chat.say(TEST_FEED, F.AIO, { sender: 'users/bot' });
    let reviews = 0;
    const assess = t.g.vertex.assess;
    t.g.vertex.assess = p => {  // while the first alert is reviewed, a newer run claims the run
      if (++reviews === 1) t.g.props.set('RUN_OWNER', claim('newer-run', t.g.clock.now));
      return assess(p);
    };
    t.poll();
    eq([reviews, t.g.gmail.sentMessages().length, t.g.gmail.calls.filter(c => c.path === 'messages/send').length], [1, 0, 0]);
    eq(logRows(t).map(r => [r.record_key, r.email_status]), [['x.com/status/' + SAM_ID, 'pending']]);  // left for the owner
    assert.ok(!forwarded(t, AIO_ID));
    eq(JSON.parse(t.g.props.get('RUN_OWNER')).id, 'newer-run');
    assert.ok(t.g.logs.some(l => /^another run \(started 2026-10-14T.*\) took over: this one handles and sends nothing more$/.test(l)), t.g.logs.join('\n'));
    // The newer run ends (its claim cleared): the next run handles the second alert and sends the first one's email
    t.g.props.delete('RUN_OWNER');
    t.poll();
    eq([reviews, t.g.gmail.sentMessages().length], [2, 2]);
    eq(logRows(t).map(r => r.email_status), ['sent', 'sent']);
    t.poll();
    eq(t.g.gmail.sentMessages().length, 2);
  });

  test('run owner: a run that fails still clears its claim; a claim that can\'t be written leaves the run handling no message (the next minute does)', () => {
    const t = ready();
    t.set('B3', '');  // the run fails: the Burson space is blank
    t.poll();
    assert.match(t.get('B5'), /The Burson space is blank/);
    assert.ok(!t.g.props.has('RUN_OWNER'));
    t.set('B3', 'SLRR Test Feed (Burson Sim)');
    const PS = t.g.services.PropertiesService;
    const real = PS.getScriptProperties;
    PS.getScriptProperties = () => {  // RUN_OWNER can't be written this minute
      const p = real();
      const set = p.setProperty;
      p.setProperty = function (k, v) {
        if (k === 'RUN_OWNER') throw new Error('Service invoked too many times: properties');
        return set.call(this, k, v);
      };
      return p;
    };
    t.chat.say(TEST_FEED, F.P0_OK, { sender: 'users/bot' });
    t.poll();
    assert.ok(!forwarded(t, SAM_ID));
    assert.ok(t.g.logs.some(l => /^ERROR could not claim the run, so it handles no alert this time: Service invoked too many times/.test(l)), t.g.logs.join('\n'));
    PS.getScriptProperties = real;
    t.poll();
    assert.ok(forwarded(t, SAM_ID));
    eq(t.g.gmail.sentMessages().length, 1);
  });

  test('run owner: outside poll() (setup, the editor, a run built by hand) there is no claim to check: runs and sends as before', () => {
    const t = ready();
    eq(t.bot.ev('runId_'), '');
    eq(t.bot.runOwned_(), true);
    t.g.props.set('RUN_OWNER', claim('someone', t.g.clock.now));  // even with another run's claim around
    eq(t.bot.runOwned_(), true);
  });

  test('locks: a LockService error (the quota error seen live) skips poll()\'s minute quietly; setup() waits up to 5 minutes for a run, then says a run is in progress and changes nothing', () => {
    const t = ready();
    t.chat.say(TEST_FEED, F.P0_OK, { sender: 'users/bot' });
    const LS = t.g.services.LockService;
    const real = LS.getScriptLock;
    LS.getScriptLock = () => ({
      tryLock() { throw new Error('There are too many LockService operations against the same script.'); },
      releaseLock() { throw new Error('not held'); },
    });
    const logs = t.g.logs.length;
    t.poll();  // doesn't throw
    eq(t.g.logs.slice(logs), ['run skipped: the script lock couldn\'t be checked (There are too many LockService operations against the same script.)']);
    assert.ok(!forwarded(t, SAM_ID));
    // setup() while a run holds the lock: it waits 5 minutes for it, then stops before touching anything
    const waits = [];
    LS.getScriptLock = () => ({ tryLock(ms) { waits.push(ms); return false; }, releaseLock() { throw new Error('not held'); } });
    const before = JSON.stringify([t.g.triggers, Array.from(t.g.props), t.sheet().sheets.map(s => s.rows), t.chat.calls.length]);
    assert.throws(() => t.bot.setup(), /^Error: A run is in progress, try again in a few minutes \(setup\(\) didn't change anything\)\.$/);
    eq([waits, JSON.stringify([t.g.triggers, Array.from(t.g.props), t.sheet().sheets.map(s => s.rows), t.chat.calls.length])],
      [[5 * 60 * 1000], before]);
    // The lock free again: the next minute runs as usual
    LS.getScriptLock = real;
    t.poll();
    assert.ok(forwarded(t, SAM_ID));
  });

  test('setup() removes the orphaned checkSourceSpaceForNewMessages trigger (it failed every minute) with the prototype\'s others; anything else is kept, and poll\'s stays one', () => {
    const g = makeGoogle(NOW);
    g.triggers.push({ handler: 'checkSourceSpaceForNewMessages', minutes: 1 }, { handler: 'pollAlerts', minutes: 1 },
      { handler: 'someoneElses', minutes: 5 });
    const t = e2e(g);
    t.bot.setup();
    eq(g.triggers, [{ handler: 'someoneElses', minutes: 5 }, { handler: 'poll', minutes: 1 }]);
    t.bot.setup();
    eq(g.triggers, [{ handler: 'someoneElses', minutes: 5 }, { handler: 'poll', minutes: 1 }]);
  });
};
