// Relay with S-F Burson (Control row 22, relay): analysts work in the Mirror space only; everything in S-F Burson comes
// over to it as it is, in S-F Burson's own order (Zapier's alerts, and everyone's replies, messages and emojis: the Relay
// names tab only says how people show), and the analysts' (never the bot's) wait on the Burson outbox (Outbox.gs) with
// their names, going to S-F Burson only once a person sets them to Send there, and only with Post in S-F Burson (row 24)
// ON (Relay.gs).
'use strict';

module.exports = H => {
  const { test, eq, assert, B, F, e2e, REAL, markAs } = H;
  const MIRROR = 'spaces/AAQAmirror1';
  const ALICE = { sender: 'users/burson7', displayName: 'Alice Smith', email: 'alice@agency.test' };
  const DANA = { sender: 'users/analyst9', displayName: 'Dana Lee', email: 'dana@' + ['google', 'com'].join('.') };

  /**
   * setup(), the Mirror space on, the relay switch (and Post in S-F Burson, unless post is false) as asked (a run sees
   * it); then a Zapier alert in S-F Burson, worked once. The bot is LIVE (B25 set, the Mirror copies it, B26 blank, the
   * Safety valve OFF): the analysts' side waits on the Burson outbox only then. Auto-send (row 11) ON: the bot sends the
   * Social Alert itself, so its team emojis go on the copy (LIVE, a draft would wait for a person).
   */
  const relayWorld = (on, post) => {
    const t = e2e();
    t.bot.setup();
    t.set('B25', REAL);  // S-F Burson (Control tab B25): the space the Mirror and the relay work with
    t.chat.addSpace(MIRROR, 'SLRR Zapier Training Mirror');
    t.bot.startMirror('SLRR Zapier Training Mirror');
    t.control().getRange(11, 2).setValue('ON');
    t.control().getRange(22, 2).setValue(on ? 'ON' : 'OFF');
    t.control().getRange(24, 2).setValue(on && post !== false ? 'ON' : 'OFF');
    t.poll();
    const zap = t.chat.say(REAL, F.P0_OK, { sender: 'users/zapier', type: 'BOT', displayName: 'Zapier' });
    t.poll();
    const copy = t.chat.botPosts(MIRROR).find(m => !m.threadReply && m.text === F.P0_OK);
    return { t, zap, copy };
  };
  const tabRows = (t, name) => {
    const tab = t.sheet().getSheetByName(name);
    if (!tab) return [];
    const head = tab.rows[0];
    return tab.rows.slice(1).map(r => Object.fromEntries(head.map((h, i) => [h, r[i]])));
  };
  const relayRows = t => tabRows(t, 'Relay');
  const allRows = t => tabRows(t, 'Burson outbox').map(r => ({ kind: r.Kind, text: r['Text or emoji'], from: r.From, status: r.Status, note: r.Note }));
  // the relay's rows (the analysts' side); the bot's own (row 24: its Burson replies and emojis, LIVE) are ownRows
  const outbox = t => allRows(t).filter(r => r.from !== 'bot');
  const ownRows = t => allRows(t).filter(r => r.from === 'bot');
  /** Sets the relay's Burson outbox rows that are Pending (or those `pick` picks) to Send, as a person would, and runs once. */
  const sendAll = (t, pick) => {
    const tab = t.sheet().getSheetByName('Burson outbox');
    tab.rows.slice(1).forEach((r, i) => {
      if (r[5] === 'Pending' && r[4] !== 'bot' && (!pick || pick(r[3]))) tab.getRange(i + 2, 6).setValue('Send');
    });
    t.poll();
  };
  const texts = (t, space) => t.chat.spaces.get(space).messages.filter(m => m.viaApi).map(m => m.text);
  const notes = (t, thread) => t.chat.spaces.get(MIRROR).messages.filter(m => m.viaApi && m.thread.name === thread && /^Not sent/.test(m.text));
  /** Types a name (and org) next to someone on the Relay names tab, as a person would. */
  const nameThem = (t, user, name, org) => {
    const tab = t.sheet().getSheetByName('Relay names');
    const head = tab.rows[0];
    const r = tab.rows.findIndex(row => row[head.indexOf('user')] === user);
    tab.getRange(r + 1, head.indexOf('name') + 1).setValue(name);
    if (org) tab.getRange(r + 1, head.indexOf('org') + 1).setValue(org);
  };

  test('relay OFF (the default): the Mirror space gets Zapier\'s alerts only, as before; nothing is posted, reacted or queued for S-F Burson and there is no Relay tab', () => {
    const { t, zap, copy } = relayWorld(false);
    assert.ok(copy, 'the alert is copied');
    t.chat.say(REAL, 'Why is this one P0?', Object.assign({ thread: zap.thread.name }, ALICE));
    t.chat.addReaction(zap.name, '👀', ALICE.sender, ALICE.displayName);
    t.chat.say(MIRROR, 'It is P0 because of the tag.', Object.assign({ thread: copy.thread.name }, DANA));
    t.chat.addReaction(copy.name, '👍', DANA.sender, DANA.displayName);
    t.poll();
    t.poll();
    eq([t.chat.botPosts(REAL), t.chat.botReactions(zap.name), relayRows(t), t.sheet().getSheetByName('Relay'),
      t.sheet().getSheetByName('Relay names'), t.sheet().getSheetByName('Burson outbox')], [[], [], [], null, null, null]);
    assert.ok(!texts(t, MIRROR).some(x => /Alice Smith/.test(x)));
    assert.match(t.control().cell(22, 3), /^OFF \(/);
    eq(t.g.props.get('RELAY_CURSORS'), undefined);
  });

  test('relay ON: Burson\'s replies, messages and emojis come into the Mirror space (in the alert\'s thread when they\'re in it); the analysts\' replies, messages and emojis wait on the Burson outbox with their names and go once set to Send; the bot\'s own work never does; nothing twice', () => {
    const { t, zap, copy } = relayWorld(true);
    markAs(t, ALICE.sender, 'Burson');  // her org, set once on the Relay names tab: she shows as "Alice Smith (Burson)"
    // The alert's pair is on the Relay tab; nothing went to S-F Burson (the bot's 📰 📦 stay on the copy)
    eq(relayRows(t).map(r => [r.direction, r.what, r.status, r.burson_message, r.test_message]),
      [['From S-F Burson', 'alert', 'copied', zap.name, copy.name]]);
    eq([t.chat.botPosts(REAL), t.chat.botReactions(zap.name), outbox(t)], [[], [], []]);
    assert.ok(t.chat.botReactions(copy.name).includes('📦'));

    // Burson: a reply under the alert, a message of its own, an emoji on the alert
    t.chat.say(REAL, 'Why is this one P0?', Object.assign({ thread: zap.thread.name }, ALICE));
    t.chat.say(REAL, 'Heads up: the queue is busy today', ALICE);
    t.chat.addReaction(zap.name, '👀', ALICE.sender, ALICE.displayName);
    t.poll();
    const inThread = t.chat.spaces.get(MIRROR).messages.filter(m => m.thread.name === copy.thread.name && m.threadReply &&
      !/^Social Alert sent: /.test(m.text));  // the bot's own note on its send (Auto-send ON)
    eq(inThread.map(m => m.text.split('\n')[0]).slice(0, 2), ['Alice Smith (Burson): Why is this one P0?', 'Happy to help with that.']);
    assert.ok(texts(t, MIRROR).includes('Alice Smith (Burson): Heads up: the queue is busy today'));
    eq(t.chat.reactionsOn(copy.name).filter(([, e]) => e === '👀'), [['users/bot', '👀']]);
    eq([t.chat.botPosts(REAL), outbox(t)], [[], []]);  // the bot's answer to Alice stays in the Mirror space

    // Analysts: a reply under the alert, a message of their own, one kept internal (and a reply under it), one that
    // would leak, and emojis: 👍 is queued, 👎 ("the bot got this wrong") never is
    t.chat.say(MIRROR, 'It is P0 because of the exposure tag. Thanks!', Object.assign({ thread: copy.thread.name }, DANA));
    const hello = t.chat.say(MIRROR, 'Morning Burson team', DANA);
    const internal = t.chat.say(MIRROR, 'internal: the bot got this one right', DANA);
    t.chat.say(MIRROR, 'agreed, nice one', Object.assign({ thread: internal.thread.name }, DANA));
    const leak = t.chat.say(MIRROR, 'see the analyst space for this one', Object.assign({ thread: copy.thread.name }, DANA));
    t.chat.addReaction(copy.name, '👍', DANA.sender, DANA.displayName);
    t.chat.addReaction(copy.name, '👎', DANA.sender, DANA.displayName);
    const asked = t.g.vertex.calls.length;
    t.poll();
    // Nothing is written in S-F Burson: three rows wait on the Burson outbox, Pending
    eq(t.chat.botPosts(REAL), []);
    eq(outbox(t).map(r => [r.kind, r.text, r.from, r.status]), [
      ['reply', 'Dana Lee: It is P0 because of the exposure tag. Thanks!', 'relay: Dana Lee', 'Pending'],
      ['post', 'Dana Lee: Morning Burson team', 'relay: Dana Lee', 'Pending'],
      ['reaction', '👍', 'relay: Dana Lee', 'Pending'],
    ]);
    assert.strictEqual(t.g.vertex.calls.length, asked);  // the bot never answers the analysts as if they were Burson
    eq(notes(t, leak.thread.name).map(m => m.text), ['Not sent to S-F Burson: it mentions "analyst space". Post it again without ' +
      'that, or start it with "internal:" to keep it here.']);
    eq(notes(t, internal.thread.name), []);  // the replies under an "internal:" message stay here without a word
    // A person sets them to Send: each goes once, from the bot's account, the reply under the original Zapier message
    sendAll(t);
    const live = t.chat.botPosts(REAL);
    eq(live.map(m => [m.text, m.threadReply]), [['Dana Lee: It is P0 because of the exposure tag. Thanks!', true],
      ['Dana Lee: Morning Burson team', false]]);
    assert.strictEqual(live[0].thread.name, zap.thread.name);  // under the original Zapier message, not a copy of it
    eq(t.chat.botReactions(zap.name), ['👍']);
    assert.ok(!live.some(m => /internal|agreed|analyst space|🤖/.test(m.text)));
    eq(outbox(t).map(r => r.status), ['Sent', 'Sent', 'Sent']);

    // Burson answers Dana's message in its thread: it comes back under Dana's message in the Mirror space
    t.chat.say(REAL, 'Morning Dana!', Object.assign({ thread: live[1].thread.name }, ALICE));
    t.poll();
    const back = t.chat.spaces.get(MIRROR).messages.find(m => m.text === 'Alice Smith (Burson): Morning Dana!');
    eq([back.thread.name, back.threadReply], [hello.thread.name, true]);

    // More runs: nothing queued or sent twice, nothing bounced back (the 👍 sent to S-F Burson, the 👀 brought over)
    const before = [t.chat.botPosts(REAL).length, t.chat.botPosts(MIRROR).length, relayRows(t).length, outbox(t).length];
    t.poll();
    t.poll();
    eq([t.chat.botPosts(REAL).length, t.chat.botPosts(MIRROR).length, relayRows(t).length, outbox(t).length], before);
    eq([t.chat.botReactions(zap.name), t.chat.reactionsOn(copy.name).filter(([u, e]) => u === 'users/bot' && e === '👍')], [['👍'], []]);

    // The Relay tab: each item, which way, who, and whether it went; the Relay names tab: who the relay has seen
    eq(relayRows(t).map(r => [r.direction, r.what, r.who, r.status]), [
      ['From S-F Burson', 'alert', 'Zapier', 'copied'],
      ['From S-F Burson', 'reply', 'Alice Smith (Burson)', 'sent'],
      ['From S-F Burson', 'message', 'Alice Smith (Burson)', 'sent'],
      ['From S-F Burson', 'emoji', 'Alice Smith (Burson)', 'sent'],
      ['To S-F Burson', 'reply', 'Dana Lee', 'sent'],
      ['To S-F Burson', 'message', 'Dana Lee', 'sent'],
      ['To S-F Burson', 'message', '', 'kept here (internal)'],
      ['To S-F Burson', 'reply', '', 'not sent: it mentions "analyst space". Post it again without that, or start it with "internal:" to keep it here.'],
      ['To S-F Burson', 'emoji', 'Dana Lee', 'sent'],
      ['From S-F Burson', 'reply', 'Alice Smith (Burson)', 'sent'],
    ]);
    eq(tabRows(t, 'Relay names').map(r => [r.user, r.name, r.org, r.seen_in]),
      [['users/burson7', 'Alice Smith', 'Burson', 'S-F Burson'], ['users/analyst9', 'Dana Lee', 'Google', 'the Mirror space']]);
    assert.match(t.control().cell(22, 3), /^✓ ON: .* · last relay \d\d:\d\d UTC · the Relay tab has each one$/);

    // Turned OFF: nothing more goes either way. Turned back ON: what was written while it was OFF is never queued
    t.control().getRange(22, 2).setValue('OFF');
    t.chat.say(MIRROR, 'while off: Burson got this totally wrong lol', DANA);
    t.chat.say(MIRROR, 'while off, under the alert', Object.assign({ thread: copy.thread.name }, DANA));
    t.chat.say(REAL, 'And one more from us', ALICE);
    t.chat.addReaction(copy.name, '🎉', DANA.sender, DANA.displayName);
    const counts = [t.chat.botPosts(REAL).length, t.chat.botPosts(MIRROR).length, relayRows(t).length, outbox(t).length];
    t.poll();
    eq([t.chat.botPosts(REAL).length, t.chat.botPosts(MIRROR).length, relayRows(t).length, outbox(t).length], counts);
    eq(t.g.props.get('RELAY_CURSORS'), undefined);
    t.control().getRange(22, 2).setValue('ON');
    t.poll();
    t.poll();
    assert.ok(!outbox(t).some(r => /while off/.test(r.text) || r.text === '🎉'));
    eq(t.chat.botReactions(zap.name), ['👍']);
    // Burson's last 15 minutes do come over (the relay was OFF for a minute): nothing analysts wrote
    assert.ok(texts(t, MIRROR).includes('Alice Smith (Burson): And one more from us'));
    // From then on, as before
    t.chat.say(MIRROR, 'Back on', DANA);
    t.poll();
    eq(outbox(t).slice(-1).map(r => [r.text, r.status]), [['Dana Lee: Back on', 'Pending']]);
    sendAll(t);
    eq(t.chat.botPosts(REAL).slice(-1).map(m => m.text), ['Dana Lee: Back on']);
  });

  test('relay ON: a reply under an alert copied before the relay was on is still placed both ways (the copy is found by its id, and the alert by the copy\'s), but not its emojis; a reply under an analyst\'s own message still on the outbox goes under it once both are sent; replies in a thread S-F Burson doesn\'t have get one note per thread; an IM\'s reply in S-F Burson comes over too, in its place, shown as Google', () => {
    const { t, zap, copy } = relayWorld(false);
    const maps = t.chat.say(REAL, F.MAPS, { sender: 'users/zapier', type: 'BOT', displayName: 'Zapier' });
    t.poll();
    const mapsCopy = t.chat.botPosts(MIRROR).find(m => !m.threadReply && m.text === F.MAPS);
    assert.ok(mapsCopy, 'copied while the relay was OFF');
    t.control().getRange(22, 2).setValue('ON');
    t.control().getRange(24, 2).setValue('ON');
    t.poll();  // the relay starts: from now on
    markAs(t, ALICE.sender, 'Burson');
    t.chat.say(REAL, 'Looking into this now', Object.assign({ thread: zap.thread.name }, { sender: 'users/im1', displayName: 'Sam IM', email: 'sam@' + ['google', 'com'].join('.') }));
    t.chat.say(REAL, 'We are on it too', Object.assign({ thread: zap.thread.name }, ALICE));
    t.chat.say(MIRROR, 'Is this a known issue?', Object.assign({ thread: mapsCopy.thread.name }, DANA));
    const lone = t.chat.say(MIRROR, 'A thread of our own', DANA);
    t.chat.say(MIRROR, 'And a reply in it', Object.assign({ thread: lone.thread.name }, DANA));
    t.poll();
    const placed = t.chat.spaces.get(MIRROR).messages.find(m => m.text === 'Alice Smith (Burson): We are on it too');
    eq([placed.thread.name, placed.threadReply], [copy.thread.name, true]);
    // Sam's address is @google.com: an IM, shown as Google. His reply comes over too, under the alert, before Alice's (as
    // in S-F Burson), and the Relay tab has it
    const relayedIn = t.chat.spaces.get(MIRROR).messages
      .filter(m => m.thread.name === copy.thread.name && /^client-zrly-/.test(String(m.clientAssignedMessageId || ''))).map(m => m.text);
    eq(relayedIn, ['Sam IM (Google): Looking into this now', 'Alice Smith (Burson): We are on it too']);
    eq(relayRows(t).filter(r => r.user === 'users/im1').map(r => [r.who, r.status]), [['Sam IM (Google)', 'sent']]);
    eq(tabRows(t, 'Relay names').filter(r => r.user === 'users/im1').map(r => r.org), ['Google']);
    eq(outbox(t).map(r => [r.kind, r.text]), [['reply', 'Dana Lee: Is this a known issue?'], ['post', 'Dana Lee: A thread of our own'],
      ['reply', 'Dana Lee: And a reply in it']]);
    // Sending the reply under Dana's own message before that message: it can't go yet (Failed, never tried again)
    sendAll(t, text => text === 'Dana Lee: And a reply in it');
    eq(outbox(t).map(r => r.status), ['Pending', 'Pending', 'Failed']);
    assert.match(outbox(t)[2].note, /^not sent: the first message of its thread hasn't gone to S-F Burson yet/);
    eq(t.chat.botPosts(REAL), []);
    // All of them, in order (the failed one set to Send again): Dana's reply under the alert copied while it was OFF goes
    // under that alert in S-F Burson, and the reply in her own thread under her message there
    const tab = t.sheet().getSheetByName('Burson outbox');
    tab.getRange(4, 6).setValue('Send');
    sendAll(t);
    const live = t.chat.botPosts(REAL);
    eq(live.map(m => [m.text, m.threadReply]), [['Dana Lee: Is this a known issue?', true], ['Dana Lee: A thread of our own', false],
      ['Dana Lee: And a reply in it', true]]);
    eq([live[0].thread.name, live[2].thread.name], [maps.thread.name, live[1].thread.name]);
    // Emojis only go on messages posted since the relay started (an older one's emojis may be from before then): not on
    // the alert copied while it was OFF, but on Dana's message of her own
    t.chat.addReaction(mapsCopy.name, '👍', DANA.sender, DANA.displayName);
    t.chat.addReaction(lone.name, '👍', DANA.sender, DANA.displayName);
    t.poll();
    sendAll(t);
    eq([t.chat.botReactions(maps.name), t.chat.botReactions(live[1].name)], [[], ['👍']]);
    // Replies under one of the bot's own top-level posts (no S-F Burson message behind it) stay here: one note per thread
    const own = t.chat.say(MIRROR, '🤖 a note of the bot\'s', { sender: 'users/bot' });
    t.chat.say(MIRROR, 'Replying to this note', Object.assign({ thread: own.thread.name }, DANA));
    t.chat.say(MIRROR, 'Replying to this note again', Object.assign({ thread: own.thread.name }, DANA));
    t.poll();
    t.poll();
    eq(notes(t, own.thread.name).map(m => m.text), ['Not sent to S-F Burson: replies in this thread stay here: it isn\'t one from ' +
      'S-F Burson. Post a message of its own to send something.']);
    assert.ok(!outbox(t).some(r => /Replying to this note/.test(r.text)));
    eq(relayRows(t).filter(r => /^not sent: replies/.test(r.status)).length, 2);
  });

  test('relay ON: Chat gives the bot no names (it signs in as a person): someone new in S-F Burson goes on the Relay names tab not marked, and what they write comes over at once, in its place, as "Someone" (nothing waits on that tab); marked Burson, as "Someone (Burson)" until a name is typed in there, then by that name; marked Google, by that name as Google. Analysts show as "Google team" until named', () => {
    const { t, zap, copy } = relayWorld(true);
    const BO = { sender: 'users/burson8' };
    const KIM = { sender: 'users/analyst3' };
    t.chat.say(REAL, 'First one from Bo', Object.assign({ thread: zap.thread.name }, BO));
    t.chat.say(MIRROR, 'First one from Kim', Object.assign({ thread: copy.thread.name }, KIM));
    t.poll();
    assert.ok(texts(t, MIRROR).includes('Someone: First one from Bo'), 'not marked: it comes over at once, with no org');
    eq(outbox(t).map(r => [r.text, r.from]), [['Google team: First one from Kim', 'relay: Google team']]);
    eq(tabRows(t, 'Relay names').map(r => [r.user, r.name, r.org, r.example]),
      [['users/burson8', '', '', 'First one from Bo'], ['users/analyst3', '', 'Google', 'First one from Kim']]);
    eq(t.sheet().getSheetByName('Relay names').validations['2,3'].values, ['Burson', 'Google']);  // a dropdown to mark them
    assert.match(t.control().cell(22, 3), / · last relay \d\d:\d\d UTC · the Relay tab has each one$/);  // nothing waits
    nameThem(t, 'users/burson8', '', 'Burson');  // marked Burson, no name yet
    t.chat.say(REAL, 'Second one from Bo', Object.assign({ thread: zap.thread.name }, BO));
    t.poll();
    assert.ok(texts(t, MIRROR).includes('Someone (Burson): Second one from Bo'));
    nameThem(t, 'users/burson8', 'Bo Chen');
    nameThem(t, 'users/analyst3', 'Kim Park');
    t.chat.say(REAL, 'Third one from Bo', Object.assign({ thread: zap.thread.name }, BO));
    t.chat.say(MIRROR, 'Second one from Kim', Object.assign({ thread: copy.thread.name }, KIM));
    t.poll();
    assert.ok(texts(t, MIRROR).includes('Bo Chen (Burson): Third one from Bo'));
    sendAll(t);
    eq(t.chat.botPosts(REAL).map(m => m.text), ['Google team: First one from Kim', 'Kim Park: Second one from Kim']);
    // Marked Google after all (an IM): what Bo writes still comes over, shown as Google
    nameThem(t, 'users/burson8', 'Bo Chen', 'Google');
    t.chat.say(REAL, 'Fourth one from Bo', Object.assign({ thread: zap.thread.name }, BO));
    t.poll();
    assert.ok(texts(t, MIRROR).includes('Bo Chen (Google): Fourth one from Bo'));
    eq(relayRows(t).filter(r => r.user === 'users/burson8').map(r => [r.who, r.text, r.status]), [
      ['Someone', 'First one from Bo', 'sent'],
      ['Someone (Burson)', 'Second one from Bo', 'sent'],
      ['Bo Chen (Burson)', 'Third one from Bo', 'sent'],
      ['Bo Chen (Google)', 'Fourth one from Bo', 'sent'],
    ]);
    eq(tabRows(t, 'Relay names').length, 2);
  });

  test('relay ON: a row that fails when sent is Failed with the reason and never tried again by itself (the next row still goes; Send again retries it); a message that can\'t be queued is tried again each run, then given up on after 5 runs with a note', () => {
    const { t, copy } = relayWorld(true);
    let fails = 0;
    let down = true;
    t.chat.fail = (method, path, query, body) => (down && method === 'post' && path === `${REAL}/messages` && /Stuck/.test(body.text)
      ? (fails++, { code: 500, body: { error: { message: 'backend error' } } }) : null);
    t.chat.say(MIRROR, 'Stuck one', Object.assign({ thread: copy.thread.name }, DANA));
    t.chat.say(MIRROR, 'Next one', DANA);
    t.poll();
    eq(outbox(t).map(r => r.status), ['Pending', 'Pending']);
    sendAll(t);
    eq([outbox(t).map(r => r.status), t.chat.botPosts(REAL).map(m => m.text)], [['Failed', 'Sent'], ['Dana Lee: Next one']]);
    assert.match(outbox(t)[0].note, /^not sent: Chat API 500 on posting to spaces\/AAQAaa_0I9g: backend error$/);
    const failed = fails;
    t.poll();
    t.poll();
    eq([fails, t.chat.botPosts(REAL).length], [failed, 1]);  // never tried again by itself
    down = false;
    const tab0 = t.sheet().getSheetByName('Burson outbox');
    tab0.getRange(tab0.rows.findIndex(r => r[5] === 'Failed') + 1, 6).setValue('Send');  // the bot's own rows may come first
    t.poll();
    eq([outbox(t).map(r => r.status), t.chat.botPosts(REAL).map(m => m.text)], [['Sent', 'Sent'], ['Dana Lee: Next one', 'Dana Lee: Stuck one']]);
    // A tab named "Burson outbox" that the bot didn't make: nothing is queued (or read, or written) there; the message is
    // tried again each run, then given up on with a note
    const ss = t.sheet();
    ss.sheets = ss.sheets.filter(s => s.name !== 'Burson outbox');
    const theirs = ss.insertSheet('Burson outbox');
    theirs.appendRow(['Someone\'s own notes']);
    const stuck = t.chat.say(MIRROR, 'Queued later', DANA);
    const tries = () => (JSON.parse(t.g.props.get('RELAY_CURSORS')).tries || {})[stuck.name] || 0;
    t.poll();
    eq(tries(), 1);
    assert.match(t.control().cell(22, 3), /⚠️ couldn't queue an analyst's message: .*a tab named "Burson outbox" that the bot didn't make.* \(tried again every run\)/);
    for (let i = 0; i < 4; i++) t.poll();
    eq([tries(), theirs.rows], [0, [['Someone\'s own notes']]]);
    assert.match(notes(t, stuck.thread.name)[0].text, /^Not sent to S-F Burson: it couldn't be queued \(.*didn't make.*\)\. Post it again to try again\.$/);
  });

  test('relay ON: an alert that can\'t be copied into the Mirror space holds everything after it in S-F Burson: C9 says why and the run fails, as when the Mirror\'s own copying fails, tried again every run (not given up after 5 runs, as a message is); once it goes, it and everything after it come over in S-F Burson\'s order. Still failing after an hour (the Mirror\'s own window), it\'s given up on, with a Relay tab row and a note, and the rest comes over in order', () => {
    const { t } = relayWorld(true);
    markAs(t, ALICE.sender, 'Burson');
    const ZAP = { sender: 'users/zapier', type: 'BOT', displayName: 'Zapier' };
    const why = `Chat API 503 on mirroring to ${MIRROR}: unavailable`;
    let blocked = F.MAPS;
    t.chat.fail = (method, path, query, body) => (method === 'post' && path === `${MIRROR}/messages` && body.text === blocked
      ? { code: 503, body: { error: { message: 'unavailable' } } } : null);
    // what S-F Burson's copies in the Mirror space say, in the order they landed (the first alert's from before)
    const copied = () => t.chat.spaces.get(MIRROR).messages.filter(m => /^client-(?:zmir|zrly)-/.test(String(m.clientAssignedMessageId || '')))
      .map(m => m.text).filter(x => x !== F.P0_OK);
    const maps = t.chat.say(REAL, F.MAPS, ZAP);
    t.chat.say(REAL, 'We will resend this one', Object.assign({ thread: maps.thread.name }, ALICE));
    t.chat.say(REAL, 'Next shift starts at 9', ALICE);
    t.chat.say(REAL, F.PARIS, ZAP);
    for (let i = 0; i < 6; i++) t.poll();
    eq(copied(), []);  // all of it waits behind the alert
    eq(t.control().cell(9, 3), `⚠️ ${why}`);
    assert.ok(t.get('B5').includes(why), t.get('B5'));
    blocked = '';
    t.poll();
    eq(copied(), [F.MAPS, 'Alice Smith (Burson): We will resend this one', 'Alice Smith (Burson): Next shift starts at 9', F.PARIS]);
    const copy = t.chat.botPosts(MIRROR).find(m => !m.threadReply && m.text === F.MAPS);
    const reply = t.chat.spaces.get(MIRROR).messages.find(m => m.text === 'Alice Smith (Burson): We will resend this one');
    eq([reply.thread.name, reply.threadReply], [copy.thread.name, true]);
    eq(t.control().cell(9, 3), '✓ SLRR Zapier Training Mirror (S-F Burson copied here in its own order by the Relay · outbounds blocked)');
    assert.ok(!t.get('B5').includes(why), t.get('B5'));  // the run works again

    // Still failing after an hour: given up on (a row and a note say so), and what came after it comes over
    blocked = F.MISTAKES;
    t.chat.say(REAL, F.MISTAKES, ZAP);
    t.chat.say(REAL, 'After the stuck one', ALICE);
    for (let i = 0; i < 55; i++) t.poll();
    assert.ok(!copied().includes('Alice Smith (Burson): After the stuck one'), 'held for the hour');
    for (let i = 0; i < 10; i++) t.poll();
    eq(copied().slice(-1), ['Alice Smith (Burson): After the stuck one']);
    assert.ok(!copied().includes(F.MISTAKES));
    eq(relayRows(t).filter(r => /^not brought over/.test(String(r.status))).map(r => [r.what, r.who, r.status]),
      [['alert', 'Zapier', `not brought over: ${why}`]]);
    assert.ok(texts(t, MIRROR).includes(`An alert from S-F Burson couldn't be brought over (${why}). It's still in S-F Burson, and on the Relay tab.`));
    assert.ok(!t.get('B5').includes(why), t.get('B5'));
  });

  test('relay ON: a Burson reply in a thread whose first message was deleted comes over once, as a message of its own (no loop)', () => {
    const { t, copy } = relayWorld(true);
    markAs(t, ALICE.sender, 'Burson');
    const head = t.chat.say(REAL, 'Heads up on this one', ALICE);
    t.poll();
    t.chat.spaces.get(REAL).messages = t.chat.spaces.get(REAL).messages.filter(m => m.name !== head.name);  // deleted
    t.chat.say(REAL, 'Ignore that, posted by mistake', Object.assign({ thread: head.thread.name }, ALICE));
    t.poll();
    t.poll();
    // (its first message came over before it was deleted, so the reply goes under it)
    assert.ok(texts(t, MIRROR).some(x => x === 'Alice Smith (Burson): Ignore that, posted by mistake'));
    // a thread the relay never saw: its first message is gone, so the reply comes over on its own, saying so
    const other = t.chat.say(REAL, 'x', ALICE);
    t.chat.say(REAL, 'A reply with nothing above it', Object.assign({ thread: other.thread.name }, ALICE));
    t.chat.spaces.get(REAL).messages = t.chat.spaces.get(REAL).messages.filter(m => m.name !== other.name);  // deleted
    const calls = t.chat.calls.length;
    t.poll();
    assert.ok(t.chat.calls.length - calls < 200, `${t.chat.calls.length - calls} Chat calls`);
    assert.ok(texts(t, MIRROR).includes('Alice Smith (Burson), replying in a thread the Mirror space doesn\'t have: A reply with nothing above it'));
    assert.ok(copy);
  });

  test('relay: OFF is honored at once: written after a run read the switch, or while runs were failing, or while no run saw it, or by someone else running the bot: none of it is queued', () => {
    const { t, copy } = relayWorld(true);
    // 1. In the middle of a run: the switch goes OFF and Dana writes, while the run is reading S-F Burson
    let hook = null;
    t.chat.fail = (method, path) => { if (hook && method === 'get' && path === `${REAL}/messages`) { const h = hook; hook = null; h(); } return null; };
    hook = () => {
      t.control().getRange(22, 2).setValue('OFF');
      t.chat.say(MIRROR, 'mid-run: between us, Burson missed this', Object.assign({ thread: copy.thread.name }, DANA));
      t.chat.addReaction(copy.name, '👍', DANA.sender, DANA.displayName);
    };
    t.poll();
    t.control().getRange(22, 2).setValue('ON');
    t.poll();
    t.poll();
    eq([outbox(t), t.chat.botPosts(REAL), t.chat.botReactions(t.chat.spaces.get(REAL).messages[0].name)], [[], [], []]);
    // 2. OFF while every run fails reading S-F Burson; Dana writes; back ON once it works again
    t.chat.say(MIRROR, 'on again', DANA);
    t.poll();
    sendAll(t);
    eq(t.chat.botPosts(REAL).map(m => m.text), ['Dana Lee: on again']);
    t.control().getRange(22, 2).setValue('OFF');
    let down = true;
    t.chat.fail = (method, path) => (down && method === 'get' && path === `${REAL}/messages` ? { code: 503, body: { error: { message: 'down' } } } : null);
    t.poll();
    t.chat.say(MIRROR, 'while off and down: just between us', DANA);
    t.poll();
    down = false;
    t.control().getRange(22, 2).setValue('ON');
    t.poll();
    t.poll();
    assert.ok(!outbox(t).some(r => /while off/.test(r.text)));
    // 3. No run for a while (it may have been OFF in between): it starts again from then, and says so
    t.chat.say(MIRROR, 'during the gap', DANA);
    t.g.clock.now += 20 * 60 * 1000;
    t.poll();
    t.poll();
    assert.ok(!outbox(t).some(r => /during the gap/.test(r.text)));
    assert.ok(texts(t, MIRROR).some(x => /^The relay with S-F Burson didn't run from \d\d:\d\d UTC to \d\d:\d\d UTC, so it started again/.test(x)));
    // 4. Someone else runs the bot (B8 is the bot's account): nothing is queued in that run, and nothing is lost
    t.control().getRange(8, 2).setValue('relay-bot@runner.test');
    t.chat.say(MIRROR, 'while someone else ran it', DANA);
    t.poll();
    assert.ok(!outbox(t).some(r => /someone else/.test(r.text)));
    assert.match(t.control().cell(22, 3), /not relaying: this run is from bot@runner\.test, not the bot's account in "Runs as" \(B8\)/);
    t.control().getRange(8, 2).setValue('bot@runner.test');
    t.poll();
    eq(outbox(t).slice(-1).map(r => r.text), ['Dana Lee: while someone else ran it']);
  });

  test('relay ON: what is queued for S-F Burson never names the analyst space or the test space; an alert a Burson person pastes comes over but is never answered', () => {
    const { t, zap, copy } = relayWorld(true);
    markAs(t, ALICE.sender, 'Burson');
    const { ANALYST_NAME } = H;
    t.chat.say(MIRROR, `Also posted in ${ANALYST_NAME}`, DANA);
    t.chat.say(MIRROR, 'We are reviewing these in the mirror space for now', DANA);
    t.chat.say(MIRROR, 'see spaces/AAQAaLn375E for more', DANA);
    t.chat.say(MIRROR, 'Thanks, all good', DANA);
    t.poll();
    eq(outbox(t).map(r => r.text), ['Dana Lee: Thanks, all good']);
    eq(relayRows(t).filter(r => /^not sent: it mentions/.test(r.status)).length, 3);
    const asked = t.g.vertex.calls.length;
    t.chat.say(REAL, F.MAPS, Object.assign({ thread: zap.thread.name }, ALICE));
    t.poll();
    assert.ok(texts(t, MIRROR).some(x => x.indexOf('Alice Smith (Burson): THIS ALERT MEETS P2 CRITERIA') === 0));
    assert.strictEqual(t.g.vertex.calls.length, asked);
    assert.ok(!t.chat.spaces.get(MIRROR).messages.some(m => m.viaApi && m.thread.name === copy.thread.name && /^🤖 Happy to help/.test(m.text) &&
      Date.parse(m.createTime) > t.g.clock.now - 60000));
  });

  test('relay ON: an emoji on a message still on the outbox is queued once that message is sent; a reaction that fails when sent is Failed, never tried again by itself; if the Relay tab can\'t be read, no emoji on a copy is acted on', () => {
    const { t, zap, copy } = relayWorld(true);
    const later = t.chat.say(MIRROR, 'Later one', DANA);
    t.chat.addReaction(later.name, '👍', DANA.sender, DANA.displayName);
    t.poll();
    t.poll();
    eq(outbox(t).map(r => [r.kind, r.text]), [['post', 'Dana Lee: Later one']]);  // the emoji waits for its message
    sendAll(t);
    const sent = t.chat.botPosts(REAL).find(m => m.text === 'Dana Lee: Later one');
    assert.ok(sent, 'sent once set to Send');
    eq(outbox(t).slice(-1).map(r => [r.kind, r.text, r.status]), [['reaction', '👍', 'Pending']]);  // its emoji, queued now
    sendAll(t);
    eq(t.chat.botReactions(sent.name), ['👍']);
    // a reaction whose S-F Burson message is gone: Failed when sent, with the reason; never tried again by itself
    let tried = 0;
    t.chat.fail = (method, path) => (method === 'post' && path === `${zap.name}/reactions` ? (tried++, { code: 404, body: { error: { message: 'gone' } } }) : null);
    t.chat.addReaction(copy.name, '👍', DANA.sender, DANA.displayName);
    t.poll();
    sendAll(t);
    eq(outbox(t).slice(-1).map(r => [r.kind, r.text, r.status]), [['reaction', '👍', 'Failed']]);
    assert.match(outbox(t).slice(-1)[0].note, /^not sent: Chat API 404 on reacting 👍 on .*: gone$/);
    const n = tried;
    t.poll();
    t.poll();
    eq(tried, n);
    assert.match(t.control().cell(22, 3), /last relay/);
    // fail closed: the Relay tab can't be read
    const ctx = { outboundBlocked: true, spaces: { burson: { id: MIRROR } }, relayAdded: () => { throw new Error('Service Spreadsheets timed out'); } };
    eq(t.bot.relayAddedEmojis_(ctx), null);
    // an older thread pair is found on the Relay tab (beyond the rows read each run)
    const tab = t.sheet().getSheetByName('Relay');
    eq(t.bot.relayOlderThread_(tab, tab.rows[0], MIRROR, 'test_thread', copy.thread.name), zap.thread.name);
  });

  test('relay: it never writes in S-F Burson (Chat.gs refuses any write there but a Burson outbox row set to Send); it queues only while the relay is on (the switch, the Mirror space with outbounds blocked, the bot\'s account known, no dry run), Post in S-F Burson is ON and the run is LIVE; its posts are the bot\'s own there, never relayed back or taken for an alert', () => {
    const { t } = relayWorld(true);
    const ctx = (on, post) => ({ switches: { relay: on, postBurson: post !== false }, outboundBlocked: true, botUser: 'users/bot',
      spaces: { burson: { id: MIRROR } }, sfBurson: { id: REAL }, settings: {}, live: true, outbox: { add: () => ({ queued: true }) } });
    const w = { kind: 'post', text: 'x', key: 'k' };
    eq([t.bot.relayQueue_(ctx(false), w), t.bot.relayQueue_(ctx(true, false), w), t.bot.relayQueue_(Object.assign(ctx(true), { settings: { dry_run: true } }), w),
      t.bot.relayQueue_(Object.assign(ctx(true), { outboundBlocked: false }), w), t.bot.relayQueue_(Object.assign(ctx(true), { botUser: null }), w),
      t.bot.relayQueue_(Object.assign(ctx(true), { relayOff: 'x' }), w), t.bot.relayQueue_(Object.assign(ctx(true), { relayCanQueue: () => false }), w),
      t.bot.relayQueue_(Object.assign(ctx(true), { sfBurson: null }), w),  // S-F Burson (B25) blank or not found
      t.bot.relayQueue_(Object.assign(ctx(true), { live: false }), w), t.bot.relayQueue_(Object.assign(ctx(true), { live: undefined }), w)],  // Testing
    [null, null, null, null, null, null, null, null, null, null]);
    eq(t.bot.relayWhyOff_(Object.assign(ctx(true), { sfBurson: null })), 'not relaying: it needs the S-F Burson space (B25)');
    eq(t.bot.relayQueue_(ctx(true), w), { queued: true });
    assert.throws(() => t.bot.relayQueue_(Object.assign(ctx(true), { outbox: { add: () => ({ queued: false, why: 'a tab in the way' }) } }), w),
      /couldn't be queued on the Burson outbox: a tab in the way/);
    assert.throws(() => t.bot.chatPostMessage_(REAL, 'x', { key: 'k' }), /Refusing to write in S-F Burson/);
    assert.throws(() => t.bot.chatReact_(`${REAL}/messages/m1`, '👍'), /Refusing to write in S-F Burson/);
    assert.throws(() => t.bot.relayPostIn_(REAL, 'x', null, 'k'), /Refusing to relay/);
    eq([B.isOwnMessage_({ botUser: 'users/bot' }, { clientId: 'client-zrlo-abc', senderName: 'users/bot', text: 'Dana Lee: hi' }),
      B.isOwnMessage_({ botUser: 'users/bot' }, { clientId: 'client-zrly-abc', senderName: 'users/bot', text: 'Alice (Burson): hi' })], [true, false]);
    eq(['internal: x', '[internal] x', 'Internal - x', ' internal—x', 'internals are fine', 'not internal: x'].map(s => B.ev('RELAY_INTERNAL_RX_').test(s)),
      [true, true, true, true, false, false]);
    // An analyst is a person writing without one of the bot's ids or its 🤖 (including the Runs-as user typing a human
    // message), and not a message the bot posted itself under any account or a pasted alert: the bot's own work never goes out
    const person = (text, extra) => Object.assign({ senderType: 'HUMAN', senderName: 'users/old-bot', text, name: `${MIRROR}/messages/p${text.length}` }, extra);
    const mine = t.bot.chatPostMessage_(MIRROR, 'a copy the bot posted, as anyone', {});
    eq([person('hi'), person('🤖 processed', {}), person('x', { clientId: 'client-bqa-1' }), person('Alice (Burson): hi', { clientId: 'client-zrly-1' }),
      person('x', { senderName: 'users/bot' }), person(F.P0_OK, { senderName: 'users/bot' }), person('x', { senderType: 'BOT' }), person('a copy', { name: mine.name })]
      .map(m => t.bot.relayAnalyst_({ botUser: 'users/bot' }, m)),
    [true, false, false, false, true, false, false, false]);
    // Only the relay's own posts read as Burson's: never another of the bot's (an alert's copy, its 🤖 posts) or a person's
    const said = (id, text, sender) => ({ name: `${MIRROR}/messages/${Buffer.from(text + id).toString('hex').slice(0, 12)}`, clientId: id,
      senderName: sender || 'users/bot', text });
    eq([said('client-zrly-abc', 'Alice (Burson): hi'), said('client-zmir-abc', 'New alert (Burson): hi'),
      said('', '🤖 Thanks, Alice (Burson): noted'), said('', 'Alice (Burson): hi'), said('', 'Alice (Burson): hi', 'users/dana')]
      .map(m => t.bot.relayedFrom_(ctx(true), m)),
    [{ who: 'Alice', text: 'hi', mentions: [] }, null, null, { who: 'Alice', text: 'hi', mentions: [] }, null]);
    // An analyst's message the relay posted in S-F Burson is never copied back as an alert, whoever's app it looks like
    eq(t.bot.isZapierMirrorCandidate_({ clientId: 'client-zrlo-abc', senderType: 'BOT', senderDisplay: 'Zapier', text: 'x' }, 'users/bot'), false);
    // What goes to S-F Burson never names the Mirror space; what comes in says where the rest is
    const long = { text: 'x'.repeat(5000), attachments: [{ name: 'shot.png' }] };
    const out = t.bot.relayBody_(long, '');
    const inn = t.bot.relayBody_(long, 'S-F Burson');
    assert.ok(out.length < 4000 && /x… \[cut short\]\n\[a file: shot\.png, not attached here\]$/.test(out), out.slice(-60));
    assert.ok(/x… \[cut short: the rest is in S-F Burson\]\n\[a file: shot\.png, open in S-F Burson\]$/.test(inn), inn.slice(-80));
  });

  test('relay: Burson\'s emojis brought over are never taken for an analyst\'s action (❌ would delete the bot\'s draft, ✍️ record T&S), from the Relay tab (no size limit) and while they go on; an analyst adding the same emoji still counts', () => {
    const name = `${MIRROR}/messages/m9`;
    const added = new Map([[name, new Set(['❌'])]]);
    eq(B.withoutRelayedEmojis_(added, { name, reactions: [{ emoji: '❌', count: 1 }, { emoji: '✍️', count: 1 }] }).reactions, [{ emoji: '✍️', count: 1 }]);
    eq(B.withoutRelayedEmojis_(added, { name, reactions: [{ emoji: '❌', count: 2 }] }).reactions, [{ emoji: '❌', count: 1 }]);
    eq(B.withoutRelayedEmojis_(added, { name: `${MIRROR}/messages/m8`, reactions: [{ emoji: '❌', count: 1 }] }).reactions, [{ emoji: '❌', count: 1 }]);
    // Hundreds of them: read from the Relay tab, nothing kept in a script property
    const { t } = relayWorld(true);
    const rows = Array.from({ length: 400 }, (_, i) => ({ direction: 'From S-F Burson', what: 'emoji', text: '❌',
      burson_message: `${REAL}/messages/b${i}`, test_message: `${MIRROR}/messages/c${i}`, key: `in-emoji:${i}` }));
    const table = { load: () => rows, append() {} };
    const st = t.bot.relayRows_(table, MIRROR);
    eq([st.addedIn.size, st.addedIn.get(`${MIRROR}/messages/c399`).has('❌'), st.liveToTest.size], [400, true, 0]);
    // and while one goes on (before its row is written)
    t.bot.relayNoteAdded_(MIRROR, `${MIRROR}/messages/new1`, '✍️');
    const ctx = { outboundBlocked: true, spaces: { burson: { id: MIRROR } }, relayAdded: () => st.addedIn };
    const all = t.bot.relayAddedEmojis_(ctx);
    eq([all.get(`${MIRROR}/messages/new1`).has('✍'), all.get(`${MIRROR}/messages/c0`).has('❌')], [true, true]);
    assert.ok(!Array.from(t.g.props.keys()).some(k => /relay_added/.test(k)));
  });

  test('relay: the bot\'s own Chat account is confirmed for the account it runs as (a moved bot is looked up again); unconfirmed, the relay doesn\'t run', () => {
    const { t } = relayWorld(true);
    t.g.props.set('BOT_USER', 'users/old-account');
    t.g.props.set('RELAY_BOT', JSON.stringify({ email: 'someone-else@ops.test', user: 'users/old-account' }));
    const fresh = () => ({ switches: { relay: true }, outboundBlocked: true, botUser: 'users/old-account', spaces: { burson: { id: MIRROR } },
      sfBurson: { id: REAL }, settings: {}, log: () => {} });
    const ctx = fresh();
    eq([t.bot.relayBotUser_(ctx, 'bot@runner.test'), ctx.botUser, t.g.props.get('BOT_USER')], ['users/bot', 'users/bot', 'users/bot']);
    // A run from someone else (poll() or startMirror() run from the editor) doesn't relay, and changes nothing
    t.g.props.set('BOT_USER', 'users/bot');
    const other = fresh();
    eq([t.bot.relayBotUser_(other, 'relay-bot@runner.test'), t.bot.relayOn_(other), t.g.props.get('BOT_USER')], [null, false, 'users/bot']);
    assert.match(t.bot.relayWhyOff_(other), /^not relaying: this run is from bot@runner\.test, not the bot's account in "Runs as" \(B8\)$/);
    const blank = fresh();
    eq([t.bot.relayBotUser_(blank, ''), t.bot.relayOn_(blank)], [null, false]);
    // The bot's account, but Chat can't confirm it: no relay this run
    const stuck = fresh();
    t.g.props.delete('RELAY_BOT');
    t.chat.fail = (method, path) => (/\/members\//.test(path) ? { code: 403, body: { error: { message: 'no' } } } : null);
    eq([t.bot.relayBotUser_(stuck, 'bot@runner.test'), t.bot.relayOn_(stuck)], [null, false]);
    assert.match(t.bot.relayWhyOff_(stuck), /^not relaying: couldn't confirm the bot's own Chat account/);
  });
};
