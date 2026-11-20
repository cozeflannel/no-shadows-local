'use strict';
// The page's charts and post overlay: the parts that touch nothing on the page (public/visuals.js), and the server's
// rule for what the page may frame.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.TEMPCHECK_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tempcheck-test-'));  // never the real data folder
const v = require('../public/visuals.js');
const { CSP, FRAMES } = require('../server');

const LINKS = {
  X: ['https://twitter.com/someone/status/2123437339213283712', 'https://x.com/Someone/status/2123437339213283712?s=20', 'http://twitter.com/someone/statuses/2123437339213283712'],
  YouTube: ['https://www.youtube.com/watch?v=qRim0t4Y4rs', 'https://youtu.be/qRim0t4Y4rs?si=abc', 'https://www.youtube.com/shorts/qRim0t4Y4rs', 'https://m.youtube.com/watch?feature=share&v=qRim0t4Y4rs'],
  Instagram: ['https://www.instagram.com/reel/Df7FYF2gCDw/', 'https://www.instagram.com/p/Df7FYF2gCDw/?igsh=x', 'https://www.instagram.com/someone/p/Df7FYF2gCDw/'],
  TikTok: ['https://www.tiktok.com/@some.one/video/7301234567890123456'],
  Bluesky: ['https://bsky.app/profile/did:plc:l4odhrpr4yumghdoqv3qhz5y/post/3n2owdfmirk2z'],
  Reddit: ['https://www.reddit.com/r/GeminiAI/comments/1abcd2e/a_title_here/', 'https://old.reddit.com/r/GeminiAI/comments/1abcd2e'],
};

test('a post is framed on its own platform\'s embed address, put together from its id alone', () => {
  assert.strictEqual(v.embedFor(LINKS.X[0]).src, 'https://platform.twitter.com/embed/Tweet.html?id=2123437339213283712&dnt=true&theme=light');
  assert.strictEqual(v.embedFor(LINKS.YouTube[1]).src, 'https://www.youtube-nocookie.com/embed/qRim0t4Y4rs');
  assert.strictEqual(v.embedFor(LINKS.Instagram[0]).src, 'https://www.instagram.com/reel/Df7FYF2gCDw/embed/');
  assert.strictEqual(v.embedFor(LINKS.Instagram[2]).src, 'https://www.instagram.com/p/Df7FYF2gCDw/embed/');
  assert.strictEqual(v.embedFor(LINKS.TikTok[0]).src, 'https://www.tiktok.com/embed/v2/7301234567890123456');
  assert.strictEqual(v.embedFor(LINKS.Bluesky[0]).src, 'https://embed.bsky.app/embed/did:plc:l4odhrpr4yumghdoqv3qhz5y/app.bsky.feed.post/3n2owdfmirk2z');
  assert.strictEqual(v.embedFor(LINKS.Reddit[0]).src, 'https://embed.reddit.com/r/GeminiAI/comments/1abcd2e/?embed=true&theme=light');
  Object.keys(LINKS).forEach(site => LINKS[site].forEach(link => assert.strictEqual((v.embedFor(link) || {}).site, site, link)));
});

test('a link that is not a post on one of those platforms is never framed', () => {
  ['', null, 'javascript:alert(1)', 'https://example.test/x/status/123456', 'https://twitter.com.evil.test/a/status/2123437339213283712',
    'https://evil.test/?u=https://twitter.com/a/status/2123437339213283712', 'https://x.com/a/status/12', 'https://www.youtube.com/watch?v=short',
    'https://bsky.app/profile/someone.bsky.social/post/3n2owdfmirk2z',  // by handle: the frame's address needs the account's id
    'https://www.facebook.com/107799854043159/posts/1782459837223', 'https://x.com/a/status/2123437339213283712"><script>', 'https://x.com/a/status/2123437339213283712 onload=x',
    `https://x.com/a/status/2123437339213283712?${'a'.repeat(2100)}`].forEach(link => assert.strictEqual(v.embedFor(link), null, String(link).slice(0, 80)));
});

test('every address a post can be framed on is one the server lets the page frame, and it lets it frame nothing else', () => {
  const made = new Set([].concat(...Object.keys(LINKS).map(site => LINKS[site].map(link => new URL(v.embedFor(link).src).origin))));
  assert.deepStrictEqual(Array.from(made).sort(), FRAMES.slice().sort());
  assert.match(CSP, new RegExp(`frame-src ${FRAMES.join(' ').replace(/[.]/g, '\\.')};`));
  assert.ok(/default-src 'self'/.test(CSP) && /frame-ancestors 'none'/.test(CSP));
  FRAMES.forEach(f => assert.match(f, /^https:\/\/[a-z0-9.-]+$/));
});

test('the biggest few and the rest as "Other"; two counts\' sources as shares of each', () => {
  const list = [{ label: 'News', n: 60 }, { label: 'X', n: 30 }, { label: 'Reddit', n: 6 }, { label: 'Blogs', n: 4 }, { label: 'None', n: 0 }];
  assert.deepStrictEqual(v.topWithOther(list, 2), [{ label: 'News', n: 60 }, { label: 'X', n: 30 }, { label: 'Other', n: 10 }]);
  assert.deepStrictEqual(v.topWithOther(list, 9).map(x => x.label), ['News', 'X', 'Reddit', 'Blogs']);
  assert.deepStrictEqual(v.topWithOther([], 3), []);
  const rows = v.shareRows(list, [{ label: 'X', n: 6 }, { label: 'Bluesky', n: 3 }, { label: 'News', n: 1 }], 2);
  assert.deepStrictEqual(rows.map(r => r.label), ['News', 'X', 'Other']);  // the source either side leans on most comes first
  assert.deepStrictEqual(rows.map(r => [Math.round(r.a), Math.round(r.b)]), [[60, 10], [30, 60], [10, 30]]);
  assert.deepStrictEqual(rows.map(r => [r.an, r.bn]), [[60, 1], [30, 6], [10, 3]]);
  assert.deepStrictEqual(v.shareRows([], [], 5), []);
});

test('two hourly counts are set on one row of hours, with a gap where one of them has no such hour', () => {
  const a = [{ at: 1000, n: 5 }, { at: 2000, n: 7 }];
  const b = [{ at: 2000, n: 1 }, { at: 3000, n: 0 }];
  assert.deepStrictEqual(v.alignHours([a, b]), { at: [1000, 2000, 3000], series: [[5, 7, null], [null, 1, 0]] });
  assert.deepStrictEqual(v.alignHours([[], null]), { at: [], series: [[], []] });
});

test('a post\'s engagement line: X\'s own likes and replies when known, one of a thing is not "1 things"', () => {
  assert.deepStrictEqual(v.engagementOf({ likes: 1200, replies: 1, eng: 5 }), { n: 1201, text: '1,200 likes · 1 reply' });
  assert.deepStrictEqual(v.engagementOf({ eng: 22665 }), { n: 22665, text: '22,665 engagements' });
  assert.deepStrictEqual(v.engagementOf({ eng: 1 }), { n: 1, text: '1 engagement' });
  assert.deepStrictEqual(v.engagementOf({ eng: null }), { n: null, text: 'engagement not known' });
  assert.deepStrictEqual(v.engagementOf(null), { n: null, text: 'engagement not known' });
});
