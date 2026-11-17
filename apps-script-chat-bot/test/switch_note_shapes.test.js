// The bot knows a note under a card as its own only by the very shape it posts (Voice.gs isThreadNoteText_): the
// watch's cover note ("🔭 *Also flagged by the watch “…"), a story note ("🔗 *Part of a story:* 5 small accounts …"), a
// requirement line ("*Alert requirements:* met for a Social Alert …" and its "final" form) and the watch's reply under
// its own alert ("🔗 *Same story: 2 more posts*"), with Chat's marks or without them. A message from the account the
// bot runs as that merely starts with the same words is a person's, in every flow: relayed, copied and answered as
// before the notes.
'use strict';

module.exports = H => {
  const { test, eq, assert, F, REAL } = H;
  const golden = require('./golden_flows')(H);
  const { AC, MIRROR } = golden.spaces;
  const ZAPIER = { sender: 'users/zapier', type: 'BOT', displayName: 'Zapier' };
  const ME = { sender: 'users/bot', displayName: 'Lucas Hammonds' };  // the person the bot runs as
  const MIN = 60 * 1000;
  const SAID = ['Same story, different account: please hold this one.', 'Part of a story we already sent, FYI.',
    'Alert requirements look met here, can you confirm the link?'];
  const ASK = 'Same story as yesterday? Why is the product wrong?';

  const step = (t, minutes, before) => { t.g.clock.now += Math.max(0, minutes * MIN - MIN); if (before) before(); t.poll(); };
  const sendAll = t => {
    const tab = t.sheet().getSheetByName('Burson outbox');
    if (!tab) return;
    tab.rows.slice(1).forEach((r, i) => { if (r[5] === 'Pending') tab.getRange(i + 2, 6).setValue('Send'); });
  };

  /** The Mirror flow, LIVE with the Relay: the person the bot runs as writes in the Mirror space and asks in S-F Burson. */
  const mirrorWords = overrides => {
    const { t } = golden.world.mirrorWorld(overrides);
    const top = text => t.chat.botPosts(MIRROR).find(m => !m.threadReply && m.text === text);
    let first;
    step(t, 1, () => { t.set('B26', ''); });
    step(t, 1, () => { first = t.chat.say(REAL, F.MISTAKES, ZAPIER); });
    step(t, 1, () => {
      const th = top(F.MISTAKES).thread.name;
      SAID.forEach(text => t.chat.say(MIRROR, text, Object.assign({ thread: th }, ME)));
    });
    step(t, 1);
    step(t, 1, () => { t.chat.say(REAL, ASK, Object.assign({ thread: first.thread.name }, ME)); });
    step(t, 1);
    step(t, 1, () => sendAll(t));
    step(t, 1);
    const texts = space => t.chat.spaces.get(space).messages.map(m => m.text);
    return { t, burson: texts(REAL), mirror: texts(MIRROR) };
  };

  test('note shapes: in the Mirror flow (LIVE, the Relay on) the messages of the person the bot runs as that start "Same story", "Part of a story" or "Alert requirements" go to S-F Burson as before the notes, and their question in S-F Burson that starts "Same story" is copied into the Mirror space and answered; the same with every new setting off', () => {
    [null, golden.SETTINGS_OFF].forEach(overrides => {
      const { burson, mirror } = mirrorWords(overrides);
      const label = overrides ? 'every setting off' : 'defaults';
      SAID.forEach(text => assert.ok(burson.some(x => x.endsWith(`: ${text}`)), `${label}: ${text} not relayed: ${JSON.stringify(burson)}`));
      assert.ok(mirror.some(x => x.indexOf(ASK.slice(0, 24)) >= 0 && x.indexOf('Lucas Hammonds') === 0), `${label}: question not copied: ${JSON.stringify(mirror)}`);
      eq([burson.filter(x => x === 'Happy to help with that.').length, mirror.filter(x => x === 'Happy to help with that.').length], [1, 1], label);
    });
  });

  test('note shapes: in the one-space setup a question from the bot\'s own account under a card that starts "Same story" or "Part of a story" is answered, as a person\'s', () => {
    ['Same story as yesterday?', 'Part of a story we sent on Monday, is it the same?'].forEach(question => {
      const { t, rec } = golden.world.oneSpaceWorld(null);
      rec.step('Burson alert', 1, () => { t.chat.say(REAL, F.P0_OK, ZAPIER); });
      const card = t.chat.botPosts(AC).filter(m => !m.threadReply)[0];
      const answers = () => t.g.vertex.calls.filter(c => c.payload.generationConfig.responseSchema.properties.answer).length;
      const before = answers();
      t.chat.say(AC, question, { thread: card.thread.name, sender: 'users/bot' });
      ['bot_posts', 'bot_post_ids', 'bot_reactions', 'recent:AC:' + REAL].forEach(k => t.g.cache.delete(k));
      t.bot.ev('BOT_MARKS_ = null');
      rec.step('the owner\'s question', 1);
      rec.step('quiet run', 1);
      const under = t.chat.spaces.get(AC).messages.filter(m => m.threadReply && m.thread.name === card.thread.name).map(m => m.text);
      eq([answers() - before, under.slice(-2)], [1, [question, 'Happy to help with that.']], question);
    });
  });
};
