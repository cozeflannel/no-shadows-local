// Where the groundwork fixes (Outbox.gs: a note's first words are held after any of Chat's marks) meet the Watch's
// "Same story: N more posts" reply (registered by the Watch lane in its own shape only). The two were built apart; the
// merged pattern holds the reply in italics or struck through as well, and still only in its own shape.
'use strict';

module.exports = H => {
  const { test, eq, B, leakDenied } = H;
  const GUARD = { terms: ['SLRR Triaged Alerts', 'AAQAaLn375E'] };
  const held = text => B.outboxGuardHits_(text, GUARD).length > 0;

  test('merged lanes, note patterns: the watch\'s "Same story: N more posts" reply is held and denied in any of Chat\'s marks, alone or after an analyst\'s name; "Same story" in other words is still anyone\'s to say', () => {
    ['Same story: 2 more posts', '_Same story: 2 more posts_', '~Same story: 1 more post~', '*Same story: 12 more posts*',
      'Dana Lee: _Same story: 3 more posts_', 'see below\n_Same story: 1,204 more posts_'].forEach(text => {
      eq([held(text), leakDenied(text)], [true, true], text);
    });
    ['Same story', 'Same story: we saw this yesterday', '_Same story:_ see above', 'This is the same story as yesterday.',
      'Same storyline about maps', 'NotSame story: 2 more posts'].forEach(text => {
      eq([B.outboxGuardHits_(text, GUARD).filter(h => /story/i.test(h)), leakDenied(text)], [[], false], text);
    });
  });
};
