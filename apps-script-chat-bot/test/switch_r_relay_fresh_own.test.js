// Relay with S-F Burson (row 22) with the Burson outbox: M10 (after a gap or a failing period the relay starts afresh:
// nothing the analysts wrote meanwhile is queued) and M11 (what the bot posts or reacts itself is never queued for
// S-F Burson, even done under another account, e.g. poll() run from the editor). Also: relay rows are queued only while
// both the relay and Post in S-F Burson are ON, and go out only through the outbox (Relay.gs, Outbox.gs, Chat.gs).
'use strict';

module.exports = H => {
  const { test, eq, assert, F, e2e, REAL } = H;
  const MIRROR = 'spaces/AAQAmirror1';
  const ZAP = { sender: 'users/zapier', type: 'BOT', displayName: 'Zapier' };
  const ALICE = { sender: 'users/burson7', displayName: 'Alice Smith' };
  const DANA = { sender: 'users/analyst9', displayName: 'Dana Lee' };

  /**
   * setup(), the Mirror space on, the relay and Post in S-F Burson as asked; a Zapier alert in S-F Burson, copied. LIVE
   * (B25 set, the Mirror copies it, B26 blank, the Safety valve OFF): the analysts' side is queued only then. Auto-send
   * (row 11) ON: the bot sends the Social Alert itself, so its team emojis go on the copy.
   */
  const relayWorld = (relay, post) => {
    const t = e2e();
    t.bot.setup();
    t.set('B25', REAL);  // S-F Burson (Control tab B25): the space the Mirror and the relay work with
    t.chat.addSpace(MIRROR, 'SLRR Zapier Training Mirror');
    t.bot.startMirror('SLRR Zapier Training Mirror');
    t.control().getRange(11, 2).setValue('ON');
    t.control().getRange(22, 2).setValue(relay ? 'ON' : 'OFF');
    t.control().getRange(24, 2).setValue(post ? 'ON' : 'OFF');
    t.poll();
    const zap = t.chat.say(REAL, F.P0_OK, ZAP);
    t.poll();
    const copy = t.chat.botPosts(MIRROR).find(m => !m.threadReply && m.text === F.P0_OK);
    return { t, zap, copy };
  };
  const writes = t => t.chat.calls.filter(c => c.method !== 'get' && String(c.path).indexOf(REAL) === 0);
  const allRows = t => {
    const tab = t.sheet().getSheetByName('Burson outbox');
    return (tab ? tab.rows.slice(1) : []).map(r => ({ kind: r[1], text: r[3], from: r[4], status: r[5] }));
  };
  // the relay's rows (the analysts' side); the bot's own (row 24: its Burson replies and emojis, LIVE) are ownRows
  const outbox = t => allRows(t).filter(r => r.from !== 'bot');
  const ownRows = t => allRows(t).filter(r => r.from === 'bot');
  const texts = t => outbox(t).map(r => r.text);
  const notes = t => t.chat.spaces.get(MIRROR).messages.filter(m => m.viaApi && /^The relay with S-F Burson/.test(m.text)).map(m => m.text);

  test('relay rows are queued only while the relay and Post in S-F Burson are both ON: with Post in S-F Burson OFF, Burson\'s side still comes over, but nothing the analysts write or react is queued (then or later), and nothing is written in S-F Burson', () => {
    const { t, zap, copy } = relayWorld(true, false);
    H.markAs(t, ALICE.sender, 'Burson');  // her org on the Relay names tab: she shows as "Alice Smith (Burson)"
    t.chat.say(REAL, 'Why is this one P0?', Object.assign({ thread: zap.thread.name }, ALICE));
    t.chat.say(MIRROR, 'Because of the exposure tag', Object.assign({ thread: copy.thread.name }, DANA));
    t.chat.say(MIRROR, 'Morning all', DANA);
    t.chat.addReaction(copy.name, '👍', DANA.sender, DANA.displayName);
    t.poll();
    t.poll();
    assert.ok(t.chat.spaces.get(MIRROR).messages.some(m => m.text === 'Alice Smith (Burson): Why is this one P0?'));  // inbound unchanged
    eq([writes(t), outbox(t), t.sheet().getSheetByName('Burson outbox')], [[], [], null]);
    assert.match(t.control().cell(22, 3), /stay there \(Post in S-F Burson is OFF\)/);
    assert.match(notes(t)[0], /nothing you write here goes to S-F Burson \(Post in S-F Burson, Control tab row 24, is OFF\)/);
    // Post in S-F Burson turned ON: only what's written from then on is queued
    t.control().getRange(24, 2).setValue('ON');
    t.poll();
    t.chat.say(MIRROR, 'Now it can go', DANA);
    t.poll();
    eq(outbox(t).map(r => [r.kind, r.text, r.from, r.status]), [['post', 'Dana Lee: Now it can go', 'relay: Dana Lee', 'Pending']]);
    eq(writes(t), []);
  });

  test('relay (M10): runs that fail before the relay runs (B3, B4 and B9 cleared) make it start afresh when they work again, even within minutes: nothing the analysts wrote meanwhile is queued, and the Mirror space is told', () => {
    const { t, copy } = relayWorld(true, true);
    t.chat.say(MIRROR, 'Before the problem', DANA);
    t.poll();
    eq(texts(t), ['Dana Lee: Before the problem']);
    const saved = [3, 4, 9].map(r => t.control().cell(r, 2));
    [3, 4, 9].forEach(r => t.control().getRange(r, 2).setValue(''));
    t.poll();
    assert.match(t.get('B5'), /^⚠️ The Burson space is blank/);
    t.chat.say(MIRROR, 'During the problem: just between us', DANA);
    t.chat.say(MIRROR, 'During the problem, under the alert', Object.assign({ thread: copy.thread.name }, DANA));
    t.chat.addReaction(copy.name, '🎉', DANA.sender, DANA.displayName);
    t.poll();
    t.poll();
    eq(t.g.props.get('RELAY_CURSORS'), undefined);
    const gap = JSON.parse(t.g.props.get('RELAY_GAP'));
    eq(gap.to, t.g.clock.now);  // the gap goes on to the last failing run
    [3, 4, 9].forEach((r, i) => t.control().getRange(r, 2).setValue(saved[i]));
    t.poll();
    t.poll();
    eq(t.get('B5'), '🔴 LIVE · ✅ Working');
    eq(texts(t), ['Dana Lee: Before the problem']);
    assert.ok(notes(t).some(x => /^The relay with S-F Burson didn't run from \d\d:\d\d UTC to \d\d:\d\d UTC, so it started again at \d\d:\d\d UTC\. Anything written here in between wasn't queued for S-F Burson/.test(x)), notes(t).join('\n'));
    t.chat.say(MIRROR, 'After the problem', DANA);
    t.poll();
    eq(texts(t), ['Dana Lee: Before the problem', 'Dana Lee: After the problem']);
    eq(writes(t), []);
  });

  test('relay (M10): ON but not relaying for longer than 10 minutes (runs from another account) also starts afresh: nothing from then is queued', () => {
    const { t } = relayWorld(true, true);
    t.control().getRange(8, 2).setValue('relay-bot@runner.test');  // "Runs as" isn't this run's account
    t.chat.say(MIRROR, 'Written while it could not relay', DANA);
    for (let i = 0; i < 11; i++) t.poll();
    assert.match(t.control().cell(22, 3), /not relaying: this run is from bot@runner\.test/);
    t.control().getRange(8, 2).setValue('bot@runner.test');
    t.poll();
    t.poll();
    eq(texts(t), []);
    assert.ok(notes(t).some(x => /didn't run from .* so it started again/.test(x)), notes(t).join('\n'));
    t.chat.say(MIRROR, 'Back to normal', DANA);
    t.poll();
    eq(texts(t), ['Dana Lee: Back to normal']);
  });

  test('relay (M11): what the bot posts or reacts itself is never queued by the Relay as an analyst\'s, even done under another account (poll() run from the editor): it notes each message and emoji it makes; its own Burson emojis go on the outbox as the bot\'s (row 24, LIVE), once; an analyst\'s own emoji still is queued for them', () => {
    const { t, zap, copy } = relayWorld(true, true);
    // Someone runs poll() from the editor: the bot's work in that run shows as that person
    const session = t.g.services.Session.getEffectiveUser;
    t.g.services.Session.getEffectiveUser = () => ({ getEmail: () => 'dana.editor@ops.test' });
    t.chat.botUser = 'users/editor-dana';
    const maps = t.chat.say(REAL, F.MAPS, ZAP);
    t.poll();
    const mapsCopy = t.chat.spaces.get(MIRROR).messages.find(m => !m.threadReply && m.text === F.MAPS);
    assert.ok(mapsCopy, 'copied in the editor run');
    const theirs = t.chat.reactionsOn(mapsCopy.name).filter(([u]) => u === 'users/editor-dana').map(([, e]) => e);
    assert.ok(theirs.includes('📦'), JSON.stringify(theirs));  // the bot's team emoji, as that person (LIVE: no 📰 for press with no address)
    // The bot's own runs again: the relay runs; none of that is queued as an analyst's, ever
    t.g.services.Session.getEffectiveUser = session;
    t.chat.botUser = 'users/bot';
    t.poll();
    t.poll();
    eq([outbox(t), writes(t)], [[], []]);
    // ...but its 📦 on the alert waits on the outbox as the bot's (row 24 ON, LIVE), once, for S-F Burson's alert
    const own = ownRows(t).filter(r => r.kind === 'reaction' && r.text === '📦');
    eq(own.length, 2);  // one for each alert (the first one's and MAPS')
    eq([t.bot.botReacted_(mapsCopy.name, '📦'), t.bot.botReacted_(mapsCopy.name, '👍'), t.bot.botPosted_(mapsCopy.name)], [true, false, true]);
    // An analyst's own emoji on it still is (queued, for a person to Send)
    t.chat.addReaction(mapsCopy.name, '👍', DANA.sender, DANA.displayName);
    t.poll();
    eq(outbox(t).map(r => [r.kind, r.text, r.from, r.status]), [['reaction', '👍', 'relay: Dana Lee', 'Pending']]);
    assert.ok(maps && zap && copy);
  });
};
