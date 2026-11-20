'use strict';
// When an alert leads to a temp check: the team's occasions as rules, tried the way the watcher uses them.
const test = require('node:test');
const assert = require('node:assert');
const t = require('../lib/triggers');
const feed = require('../lib/feed');
const own = require('../lib/owndata');

const H = t.HOUR;
const T0 = Date.UTC(2026, 10, 19, 12);
const S = t.settings();
const ctx = { s: S, bar: 20000 };
const alert = (id, o) => Object.assign({ id, at: T0, eng: 300, post: `post-${id}` }, o || {});

test('a high-engaging alert starts a temp check; the ordinary "HIGH" label (2,000+) does not', () => {
  const d = t.decide(alert('a', { eng: 53837 }), { alerts: [] }, ctx);
  assert.deepStrictEqual([d.action, d.rule], ['start', 'high']);
  assert.match(d.reasons[0], /A high-engaging alert: 53,837 engagements, at or above 20,000 \(more than 90% of recent alerts\)\./);
  assert.strictEqual(t.decide(alert('b', { eng: 2500 }), { alerts: [] }, ctx).action, 'none');
});

test('"high-engaging" is the top tenth of recent alerts once 100 are known, and 20,000 until then', () => {
  assert.strictEqual(t.highBar([1, 2, 3], S), 20000);
  const hundred = Array.from({ length: 100 }, (_, i) => (i + 1) * 100);  // 100 … 10,000
  assert.strictEqual(t.highBar(hundred, S), 9100);
  assert.strictEqual(t.highBar(hundred, t.settings({ highShare: 0.5 })), 5100);
});

test('multiple alerts: the third different post on an issue within a day; a corrected alert sent again is not another', () => {
  const issue = { alerts: [{ id: '1', at: T0 - 5 * H, eng: 100, post: 'p1' }, { id: '2', at: T0 - 2 * H, eng: 100, post: 'p2' }] };
  const d = t.decide(alert('3', { post: 'p3' }), issue, ctx);
  assert.deepStrictEqual([d.action, d.rule], ['start', 'multiple']);
  assert.match(d.reasons[0], /3 different posts in the last 24 hours/);
  assert.strictEqual(t.decide(alert('3', { post: 'p2' }), issue, ctx).action, 'none');                    // the same post again
  const old = { alerts: [{ id: '1', at: T0 - 30 * H, eng: 100, post: 'p1' }, { id: '2', at: T0 - 2 * H, eng: 100, post: 'p2' }] };
  assert.strictEqual(t.decide(alert('3', { post: 'p3' }), old, ctx).action, 'none');                      // one of them over a day ago
  assert.match(t.decide(alert('3', { post: 'p3' }), old, ctx).reasons[0], /Monitoring: 300 engagements \(the bar is 20,000\), 2 of 3 posts/);
});

test('rising post momentum: the same post, read twice the same way, up by half or more', () => {
  const up = t.rising([{ at: T0, eng: 400, src: 'x' }, { at: T0 + 30 * 60000, eng: 700, src: 'x' }], S);
  assert.deepStrictEqual(up, { from: 400, to: 700, hours: 0.5, src: 'x' });
  assert.strictEqual(t.rising([{ at: T0, eng: 400, src: 'x' }, { at: T0 + 30 * 60000, eng: 500, src: 'x' }], S), null);       // up, but not by half
  assert.strictEqual(t.rising([{ at: T0, eng: 700, src: 'x' }, { at: T0 + 30 * 60000, eng: 400, src: 'x' }], S), null);       // tapering
  assert.strictEqual(t.rising([{ at: T0, eng: 100, src: 'x' }, { at: T0 + 30 * 60000, eng: 300, src: 'x' }], S), null);       // still small
  assert.strictEqual(t.rising([{ at: T0, eng: 400, src: 'alert' }, { at: T0 + 30 * 60000, eng: 900, src: 'x' }], S), null);   // two different counts
  assert.strictEqual(t.rising([{ at: T0, eng: 400, src: 'x' }, { at: T0 + 9 * H, eng: 900, src: 'x' }], S), null);            // too far apart
  assert.strictEqual(t.rising([{ at: T0, eng: 400, src: 'x' }, { at: T0 + 60000, eng: 900, src: 'x' }], S), null);            // a minute apart: a resend
  const issue = { alerts: [], readings: { p1: [{ at: T0 - H, eng: 600, src: 'alert' }] } };
  const d = t.decide(alert('9', { post: 'p1', eng: 1000 }), issue, ctx);
  assert.deepStrictEqual([d.action, d.rule], ['start', 'momentum']);
  assert.match(d.reasons[0], /went from 600 to 1,000 engagements in 1\.0 hours/);
});

test('an issue that has a temp check is refreshed by a new alert, hourly at most', () => {
  const issue = { alerts: [], checkId: 'tc_x', checkAt: T0 - 61 * 60000 };
  assert.deepStrictEqual([t.decide(alert('a'), issue, ctx).action, t.decide(alert('a'), issue, ctx).rule], ['refresh', 'refresh']);
  const soon = t.decide(alert('a'), { alerts: [], checkId: 'tc_x', checkAt: T0 - 20 * 60000 }, ctx);
  assert.strictEqual(soon.action, 'none');
  assert.match(soon.reasons[0], /made 20 minutes ago; it is refreshed at most every 60/);
  assert.strictEqual(t.decide(alert('a', { eng: 999999 }), issue, ctx).action, 'refresh');  // never a second temp check for it
});

test('the same issue under different capitals, quotes and punctuation is one issue', () => {
  assert.strictEqual(t.issueKey('"No to Big Tech Bullies in Our Schools" Protest'), t.issueKey('no to big tech bullies in our schools protest'));
  assert.strictEqual(t.issueKey('Google Doodle Omits International Men’s Day'), 'google doodle omits international mens day');
});

test('a replay runs the rules over past alerts and starts nothing; the daily cap holds the rest back', () => {
  const alerts = [
    { id: '1', at: T0, issue: 'Alpha', eng: 50000, post: 'a1' },             // high: start
    { id: '2', at: T0 + 10 * 60000, issue: 'alpha', eng: 10, post: 'a2' },   // has one, 10 minutes old: none
    { id: '3', at: T0 + 2 * H, issue: 'Alpha', eng: 10, post: 'a3' },        // refresh
    { id: '4', at: T0 + 3 * H, issue: 'Beta', eng: 10, post: 'b1' },
    { id: '5', at: T0 + 4 * H, issue: 'Beta', eng: 10, post: 'b2' },
    { id: '6', at: T0 + 5 * H, issue: 'Beta', eng: 10, post: 'b3' },         // multiple: start
    { id: '7', at: T0 + 6 * H, issue: 'Gamma', eng: 60000, post: 'c1' },     // high, but the day's cap of 2 is reached
  ];
  const out = t.replay(alerts.slice().reverse(), { maxStartsPerDay: 2 });
  assert.deepStrictEqual(out.map(o => o.action), ['start', 'none', 'refresh', 'none', 'none', 'start', 'held']);
  assert.deepStrictEqual(out.filter(o => o.action === 'start').map(o => o.rule), ['high', 'multiple']);
  assert.match(out[6].reasons.join(' '), /2 temp checks were already started automatically that day/);
});

test('settings: a missing or bad number falls back to its starting value', () => {
  assert.deepStrictEqual(t.settings({ multiple: 2, highShare: 5, momentumMin: -1, nonsense: 9 }), Object.assign({}, t.DEFAULTS, { multiple: 2, highShare: 0.999 }));
});

test('the feed reads an alert out of the bot\'s row: its id, time, issue name, engagement, link and words', () => {
  const header = ['alert_id', 'created_at', 'forwarded_fields', 'email_input', 'source_at'];
  const fields = { issue_name: ' Gemini Kidnap Joke Response ', total_engagement: 53837, post_url: 'https://x.com/a/status/1', summary: 'What it says.', social_network: 'X', issue_status: 'NEW' };
  const rows = [
    ['QA-2', '', JSON.stringify(fields), '', '1795125000000'],
    ['QA-1', '2026-11-19T10:00:00Z', '', JSON.stringify({ fields: { issue_name: 'From the email input', total_engagement: '12' } }), ''],
    ['QA-3', '', JSON.stringify({ summary: 'no issue name' }), '', '1795125000000'],
    ['', '', JSON.stringify(fields), '', '1795125000000'],
    ['QA-4', '', 'not json', '', '1795125000000'],
  ];
  const got = feed.alertsFromRows(header, rows);
  assert.deepStrictEqual(got.map(a => a.id), ['QA-1', 'QA-2']);  // oldest first; rows with no issue name, id or fields left out
  assert.deepStrictEqual(got[1], { id: 'QA-2', at: 1795125000000, issue: 'Gemini Kidnap Joke Response', eng: 53837, url: 'https://x.com/a/status/1', text: 'What it says.', network: 'X', status: 'NEW',
    source: '', thread: '', message: '', threads: [], story: null });
  assert.strictEqual(got[0].eng, 12);
});

test('a story card\'s row carries its story: the title, the card\'s own draft query and the thread it was posted in', () => {
  const header = ['alert_id', 'created_at', 'source_message', 'source_thread', 'forwarded_fields', 'source_at', 'ingested'];
  const ed = { story_title: 'Five accounts now warn  Gemini stores chats', narrative: 'Users warn.', temp_check_query: ' ("Gemini") AND retention ', post_keys: ['a', 'b', 'c'], update_of: 'QA-7' };
  const rows = [
    ['QA-9', '', 'spaces/AAAAspace001/messages/m1.m2', 'spaces/AAAAspace001/threads/m1', JSON.stringify({ issue_name: 'Gemini retention', early_detection: ed }), '1795125000000', 'Early detection'],
    ['QA-8', '', 'spaces/AAAAspace001/messages/x', 'not a thread', JSON.stringify({ issue_name: 'From Burson', early_detection: ed }), '1795124000000', ''],
    ['QA-7', '', '', 'spaces/AAAAspace001/threads/m0', JSON.stringify({ early_detection: { story_title: 'Titled by its story' } }), '1795123000000', 'Early detection'],
  ];
  const got = feed.alertsFromRows(header, rows);
  assert.deepStrictEqual(got.map(a => [a.id, a.source, a.thread, !!a.story]),
    [['QA-7', 'Early detection', 'spaces/AAAAspace001/threads/m0', true], ['QA-8', '', '', false], ['QA-9', 'Early detection', 'spaces/AAAAspace001/threads/m1', true]]);
  assert.deepStrictEqual(got[2].story, { title: 'Five accounts now warn Gemini stores chats', narrative: 'Users warn.', query: '("Gemini") AND retention', posts: 3, updateOf: 'QA-7' });
  assert.strictEqual(got[0].issue, 'Titled by its story');  // a story's row with no issue name goes by its story's title
  assert.strictEqual(got[2].message, 'spaces/AAAAspace001/messages/m1.m2');
  // an alert stands in every thread its row names: where it came from, and where the bot put its corrected copy
  const both = feed.alertsFromRows(['alert_id', 'forwarded_fields', 'source_at', 'source_thread', 'forward_thread', 'live_thread'],
    [['QA-1', JSON.stringify({ issue_name: 'An alert' }), '1795125000000', 'spaces/AAAAspace002/threads/s1', 'spaces/AAAAspace001/threads/f1', 'spaces/AAAAspace002/threads/s1']]);
  assert.deepStrictEqual(both[0].threads, ['spaces/AAAAspace002/threads/s1', 'spaces/AAAAspace001/threads/f1']);
});

test('the Control tab says which space is the bot\'s Auto-correct space, and which are S-F Burson\'s', () => {
  const rows = [['Bot', 'ON'], ['Burson space', '', 'not used'], ['Auto-correct space', 'https://chat.google.com/app/chat/AAAAspace001', '\u2713 The space\'s name'],
    ['S-F Burson space', 'https://chat.google.com/room/AAAAspace002', '\u2713 Its name'], ['Burson test copy', 'spaces/AAAAspace003', '']];
  assert.deepStrictEqual(feed.controlFromRows(rows), { autocorrect: 'spaces/AAAAspace001', checked: true, never: ['spaces/AAAAspace002', 'spaces/AAAAspace003'] });
  assert.deepStrictEqual(feed.controlFromRows([['Auto-correct space', 'A space by its name', 'not found']]), { autocorrect: '', checked: false, never: [] });
  assert.deepStrictEqual(['https://mail.google.com/chat/u/0/#chat/space/AAAAspace001', 'spaces/AAAAspace001', 'AAAAspace01', 'a name', ''].map(feed.spaceId),
    ['spaces/AAAAspace001', 'spaces/AAAAspace001', 'spaces/AAAAspace01', '', '']);
});

test('one post, one identity: a YouTube video by its id, ids keep their capitals, a tracking tail is dropped', () => {
  assert.notStrictEqual(own.postKey('https://www.youtube.com/watch?v=2TmqWbuprvo'), own.postKey('https://www.youtube.com/watch?v=aaaaaaaaaaa'));
  assert.strictEqual(own.postKey('https://www.youtube.com/watch?v=2TmqWbuprvo&t=30s'), 'youtube.com/watch?v=2TmqWbuprvo');
  assert.strictEqual(own.postKey('https://youtu.be/2TmqWbuprvo?si=x'), 'youtube.com/watch?v=2TmqWbuprvo');
  assert.strictEqual(own.postKey('https://m.youtube.com/watch?v=2TmqWbuprvo'), 'youtube.com/watch?v=2TmqWbuprvo');
  assert.notStrictEqual(own.postKey('https://www.instagram.com/reel/Df7BypDNaTk'), own.postKey('https://www.instagram.com/reel/df7bypdnatk'));
  assert.strictEqual(own.postKey('https://www.instagram.com/reel/Df7BypDNaTk/?igsh=abc'), 'instagram.com/reel/Df7BypDNaTk');
  assert.strictEqual(own.postKey('https://www.facebook.com/permalink.php?story_fbid=123&id=456&ref=x'), 'facebook.com/permalink.php?story_fbid=123&id=456');
  assert.strictEqual(own.postKey('https://X.com/Someone/status/99?s=20'), 'x:99');
  assert.strictEqual(own.postKey(''), '');
});
