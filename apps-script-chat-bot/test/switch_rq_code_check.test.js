// Step S19a of the requirements-first plan (the code check, counted only; RequirementsFirst.gs): every post Early
// Detection reads, under Control row 51 with the setting open_requirements_first (true), is checked against the alert
// requirements code can decide, through the same rules Burson's alerts go through (escalation_), and counted on the
// Engine tab. Nothing is posted, queued or reviewed because of it. Every post and account here is made up.
'use strict';

module.exports = H => {
  const { test, eq, assert, NOW, makeGoogle, loadBot } = H;

  function bot(on, settings) {
    const g = makeGoogle(NOW);
    const b = loadBot(g.services, g.clock);
    if (settings) Object.assign(b.ev('GEN').settings, settings);
    b.ewsRunSwitches_(on ? { openEngine: true, earlyWave: true } : {});
    return { g, b };
  }
  const TEXT = 'Google Pixel 10 battery drains overnight after the update and support keeps closing my ticket';
  const check = (b, o, facts) => b.rqCheckPost_(Object.assign({ text: TEXT, author: 'someone', platform: 'X', eng: 3 }, o), facts || {});

  test('rq code check (S19a): the plan\'s cases: a KOF-list post at 3 engagements passes; "Google owned channel" is no KOF list; 1,999 is a judgment, 2,000 passes; Google\'s own post passes at 30 comments and 30% negative, not at 29 / 30% or 30 / 29%; spam at 2,500 is a judgment (a topic could lift the exclusion); "Google that" with no product is a judgment; a 36-character post is gated', () => {
    const { b } = bot(true);
    eq(check(b, { kofLists: ['Viral KOFs'] }), { rq: 'm', rr: 'KOF' });
    eq(check(b, { kofLists: ['Google owned channels'] }).rq, 'j');
    eq([check(b, { eng: 1999 }).rq, check(b, { eng: 2000 })], ['j', { rq: 'm', rr: 'HIGH_ENGAGEMENT' }]);
    eq([check(b, { owned: { comments: 30, negPct: 30 } }), check(b, { owned: { comments: 29, negPct: 30 } }).rq, check(b, { owned: { comments: 30, negPct: 29 } }).rq],
      [{ rq: 'm', rr: 'OWNED' }, 'f', 'f']);
    eq(check(b, { text: 'Free iptv giveaway promo code, check my bio for the Google Pixel deal now', eng: 2500 }).rq, 'j');
    eq(check(b, { text: 'just google that next time, it takes five seconds to find the answer', product: '' }).rq, 'j');
    eq(check(b, { text: 'Pixel 10 battery is gone again now' }).rq, 'g');  // 34 characters
    // the source's own official tag or topic counts; a tier HIGH counts as 2,000+; a post already seen is not checked alone
    const p0 = b.ev("(GEN.exposure_tags || []).find(t => t.priority === 'P0').name");
    eq([check(b, { tag: p0 }).rr, check(b, { tag: 'not an official tag' }).rq, check(b, { tier: 'HIGH', eng: null }).rr, check(b, {}, { seen: true })],
      ['SOURCE_P0', 'j', 'HIGH_ENGAGEMENT', { rq: '', rr: 'seen' }]);
  });

  test('rq code check (S19a): the KOF sheet: a profile link counts on its own network only, a bare handle on any; a hit is a code pass (KOF_SHEET) without setting `kof`; an index of 3,000 rows is small enough for two cache items', () => {
    const { b } = bot(true);
    const index = b.rqKofIndex_([['Jane Doe', 'https://x.com/janedoe'], ['@bare_handle'], ['https://www.tiktok.com/@clipmaker'], ['Not a handle at all']]);
    eq(index, { janedoe: ['x'], bare_handle: ['*'], clipmaker: ['tiktok'] });
    eq([b.rqKofSheetHit_(index, 'janedoe', 'X'), b.rqKofSheetHit_(index, 'janedoe', 'Reddit'), b.rqKofSheetHit_(index, '@bare_handle', 'TikTok'),
      b.rqKofSheetHit_(index, 'clipmaker', 'TikTok'), b.rqKofSheetHit_(index, 'nobody', 'X')], [true, false, true, true, false]);
    eq([check(b, { author: 'janedoe', platform: 'X' }, { kofIndex: index }), check(b, { author: 'janedoe', platform: 'Reddit' }, { kofIndex: index }).rq],
      [{ rq: 'm', rr: 'KOF_SHEET' }, 'j']);
    const big = b.rqKofIndex_(Array.from({ length: 3000 }, (_, i) => [`https://x.com/kof_account_${i}`]));
    assert.ok(JSON.stringify(big).length <= 2 * 95000, `${JSON.stringify(big).length}`);
  });

  test('rq code check (S19a): a check\'s posts are counted on the Engine tab (alone read, code pass, gated, failed) under row 51; nothing is counted or kept on the posts with row 51 OFF or the setting false', () => {
    const posts = () => [{ text: TEXT, eng: 2400, author: 'a', platform: 'X' }, { text: TEXT, eng: 5, author: 'b', platform: 'X' },
      { text: 'Pixel 10 battery is gone again now', eng: 1, author: 'c', platform: 'X' }];
    const on = bot(true);
    on.b.engRunStart_();
    const list = posts();
    eq(on.b.rqCountPosts_(list, {}), { alone: 3, codePass: 1, gated: 1, failed: 0, judge: 1 });
    eq(list.map(p => p.rq), ['m', 'j', 'g']);
    const n = on.b.ev('ENG_RUN_').n;
    eq([n.alone, n.codePass, n.gated], [3, 1, 1]);
    const off = bot(false);
    const offList = posts();
    eq([off.b.rqCountPosts_(offList, {}), offList[0].rq], [null, undefined]);
    const unset = bot(true, { open_requirements_first: false });
    eq(unset.b.rqCountPosts_(posts(), {}), null);
  });
};
