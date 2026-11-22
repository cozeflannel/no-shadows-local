/**
 * Writes tests/parity/tempcheck_writeup.json: the temp check app's own write-up, Gemini prompt and chart labels
 * (tempcheck-app/lib/tempcheck.js, service.js) for the inputs below. tests/test_tempcheck_writeup.py feeds the same
 * inputs to the Console's port and expects the same words. Run again after the app's template changes:
 *
 *   node tests/parity/make_tempcheck_writeup.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const tc = require('../../tempcheck-app/lib/tempcheck');
const service = require('../../tempcheck-app/lib/service');

const at = s => Date.parse(s);
const now = at('2026-11-22T10:20:00Z');
const posts = [
  { key: 'x1', x: true, id: '1845123456789012345', source: 'X', author: '@techwatcher', text: 'Gmail is down again & nobody at "Google" is saying why <sigh>',
    url: 'https://x.com/techwatcher/status/1845123456789012345', eng: 2450, negative: true, likes: 2000, replies: 300 },
  { key: 'ig1', x: false, id: '', source: 'Instagram', author: 'newsdesk', text: 'Outage  hits   Gmail users worldwide', url: 'https://www.instagram.com/p/abc/', eng: 15300, negative: false },
  { key: 'r1', x: false, id: '', source: 'Reddit', author: '', text: 'Anyone else locked out? ' + 'It keeps looping. '.repeat(40), url: '', eng: 1, negative: true },
  { key: 'n1', x: false, id: '', source: 'News', author: 'instagram.com', text: 'Google confirms the outage', url: 'https://news.example.test/a?b=1&c=2', eng: null, negative: false },
];
const hours = [];
for (let h = at('2026-11-21T18:00:00Z'); h < now; h += tc.HOUR) hours.push({ at: h, n: h === at('2026-11-21T20:00:00Z') ? 3200 : h === at('2026-11-22T09:00:00Z') ? 768 : 100 });

const cases = {
  query: {
    basis: 'brandwatch', issue: 'Alleged Gmail Outage', query: { id: 2004162030, name: '[G EVENT] NOV26 Alleged Gmail Outage' },
    bwUrl: 'https://app.brandwatch.com/project/77/dashboards/905', now, start: { at: at('2026-11-21T18:00:00Z'), why: 'spike' }, total: 12345, hours,
    velocity: { peak: { at: at('2026-11-21T20:00:00Z'), n: 3200 }, last: { at: at('2026-11-22T09:00:00Z'), n: 768 }, pct: -76 },
    sentiment: { negative: 5800, neutral: 3800, positive: 400 },
    sources: [{ label: 'X', n: 8400 }, { label: 'Bluesky', n: 700 }, { label: 'Reddit', n: 500 }, { label: 'News', n: 300 }, { label: 'Forums', n: 100 }],
    mentionTypes: [{ label: 'reposts', n: 5800 }, { label: 'comments', n: 2800 }, { label: 'original posts', n: 1400 }],
    engSources: [{ label: 'X', n: 90000 }, { label: 'Reddit', n: 5000 }], posts, linkPosts: posts, update: null,
    gem: { summary: 'Most posts report being locked out; [one outlet](#4) says a fix is coming.',
      drivers: 'People blame [the silence](#1) and <slow> updates; some cite [nothing](#9).', themes: 'Others share workarounds and [press coverage](#post-2).' },
    level: { label: 'HIGH', side: 'top', pct: 12, n: 147, known: 313, fullYear: false },
  },
  own_since: {
    basis: 'own', issue: 'Gmail calendar scam', query: null, bwUrl: '', now, start: { at: at('2026-11-21T23:00:00Z'), why: 'since' }, total: 640, hours: [],
    velocity: { peak: { at: at('2026-11-22T07:00:00Z'), n: 90 }, last: { at: at('2026-11-22T09:00:00Z'), n: 90 }, pct: 0 },
    sentiment: { negative: 0, neutral: 0, positive: 0 }, sources: [{ label: 'X', n: 640 }], mentionTypes: [], engSources: [], posts: [], linkPosts: [],
    update: null, gem: { why: 'the write-up lines were not asked for' }, level: { label: '', why: 'x' },
  },
  standing_update: {
    basis: 'brandwatch', issue: 'Pixel battery drain', query: null, standing: { queries: 2 }, bwUrl: '', now, start: { at: at('2026-11-21T10:00:00Z'), why: 'look' }, total: 23456, hours: [],
    velocity: null, sentiment: { negative: 10, neutral: 30, positive: 60 }, sources: [{ label: 'Reddit', n: 20 }, { label: 'X', n: 10 }],
    mentionTypes: [{ label: 'original posts', n: 70 }, { label: 'comments', n: 30 }], engSources: [{ label: 'Reddit', n: 7 }, { label: 'X', n: 2 }, { label: 'Bluesky', n: 1 }],
    posts: posts.slice(1, 2), linkPosts: posts.slice(1, 2), update: { at: at('2026-11-21T06:10:00Z'), tot: 20000 },
    gem: { summary: 'Calm.', drivers: '', themes: 'Jokes.' }, level: { label: 'LOW', side: 'bottom', pct: 9, n: 300, known: 313, fullYear: true },
  },
  empty: {
    basis: 'brandwatch', issue: 'Quiet issue', query: { id: 1, name: 'q' }, bwUrl: 'https://app.brandwatch.com/project/77/queries', now,
    start: { at: at('2026-11-21T10:00:00Z'), why: 'query' }, total: 0, hours: [], velocity: null, sentiment: {}, sources: [], mentionTypes: [], engSources: [], posts: [], linkPosts: [],
  },
};

const out = { made_by: 'tests/parity/make_tempcheck_writeup.js from tempcheck-app/lib/tempcheck.js', cases: {} };
Object.keys(cases).forEach(name => {
  const d = cases[name];
  const w = tc.writeup(d);
  out.cases[name] = { input: d, title: w.title, text: w.text, html: w.html,
    prompt: d.linkPosts.length ? tc.prompt(d, d.linkPosts) : '', chart: d.hours.length ? service.chartOf(d) : null };
});
fs.writeFileSync(path.join(__dirname, 'tempcheck_writeup.json'), JSON.stringify(out, null, 1) + '\n');
console.log(Object.keys(out.cases).join(', '));
