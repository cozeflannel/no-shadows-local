'use strict';
// Temp checks in Chat: what counts as a request, where the app may reply, and the whole flow (story cards, typed
// requests, by hand from the page) run on stand-ins for the feed, the temp check, Docs and Chat. No network.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.TEMPCHECK_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tempcheck-test-'));  // never the real data folder
const chat = require('../lib/chat');
const docs = require('../lib/docs');
const inchat = require('../lib/inchat');
const gemini = require('../lib/gemini');
const tc = require('../lib/tempcheck');

const H = tc.HOUR;
const T0 = Date.UTC(2026, 10, 20, 6);  // 10pm PT on 11/19
const SPACE = 'spaces/AAAAspace001';
const BURSON = 'spaces/AAAAspace002';
const ME = 'users/111';
const thread = t => `${SPACE}/threads/${t}`;
// What Gemini's draft for an alert comes back as (gemini.tightFrom's shape)
const DRAFT = { subject: 'YouTube', specifics: '"Russell Brand"', angle: 'ban* OR censor*', boolean: '(YouTube) AND ("Russell Brand") AND (ban* OR censor*)',
  wide: '(YouTube) AND ("Russell Brand")', why: 'the row over Brand' };

function recOf(id, input, total) {
  return { id, at: T0, issue: input.issue || 'Alleged Gmail Outage', basis: 'brandwatch', query: input.query ? { id: 1, name: '[G EVENT] NOV26 Alleged Gmail Outage' } : null,
    standing: input.query ? null : { queries: 27, total, search: (input.own || {}).boolean || '' }, total, window: { from: T0 - 24 * H, to: T0, why: 'look' },
    own: { total: 39, boolean: (input.own || {}).boolean || '', tables: {} }, gem: { summary: 'People say [one thing](#1).' }, readPosts: [{ url: 'https://x.com/a/status/55555' }],
    level: { label: '', why: 'not ranked' }, writeup: { html: `<p>write-up</p>${tc.CHART_MARK}` }, chart: { title: 'A chart', unit: 'Mentions', points: [{ label: '(11/19) 8AM', n: 3 }, { label: '(11/19) 9AM', n: 9 }] } };
}

/** The app on stand-ins: what it ran, made and posted is kept to look at; `s` changes what the stand-ins answer. */
function rig() {
  const files = {};
  const recs = {};
  const seen = { runs: [], docs: [], posts: [], drafts: [], checks: [], narrows: [] };
  const s = { now: T0, alerts: [], messages: [], total: 128, totals: [], needs: null, fail: null, who: { signedIn: true, canRead: true, canPost: true, me: ME, why: '' },
    control: { autocorrect: SPACE, checked: true, never: [BURSON] }, draft: DRAFT, draftFail: null, checks: [], narrowed: null };
  const d = {
    now: () => s.now,
    store: { readFile: (n, f) => (files[n] ? JSON.parse(files[n]) : f), writeFile: (n, v) => { files[n] = JSON.stringify(v); }, read: id => recs[id] || null },
    feed: { newest: async () => s.alerts.slice(), control: async () => s.control },
    service: { run: async input => {
      seen.runs.push(input);
      if (s.fail) throw s.fail;
      if (s.needs && input.query) return s.needs;
      const rec = recOf(`tc_${seen.runs.length}`, input, s.totals.length ? s.totals.shift() : s.total);
      recs[rec.id] = rec;
      return rec;
    } },
    draft: { query: async about => { seen.drafts.push(about); if (s.draftFail) throw s.draftFail; return s.draft; },
      check: async (about, posts) => { seen.checks.push(posts); return s.checks.length ? s.checks.shift() : { read: 25, about: 23, share: 0.92, off: [], others: '' }; },
      narrow: async (about, draft, check, off) => { seen.narrows.push({ draft, check, off }); if (!s.narrowed) throw new Error('no narrower one'); return s.narrowed; } },
    docs: { create: async (rec, about) => { seen.docs.push({ rec: rec.id, about }); return { id: `d${seen.docs.length}`, url: `https://docs.google.com/document/d/d${seen.docs.length}/edit`, folderUrl: 'https://drive.google.com/drive/folders/f1' }; } },
    chat: { status: async () => s.who, mayReply: chat.mayReply, ask: chat.ask, list: async (space, since) => { assert.strictEqual(space, SPACE); return s.messages.filter(m => m.at > since); },
      reply: async o => {
        assert.ok(o.text.indexOf(chat.HEAD) === 0);
        if (seen.posts.some(p => p.key === o.key)) return { name: 'there', sender: ME, already: true };
        seen.posts.push(o);
        return { name: `${SPACE}/messages/r${seen.posts.length}`, sender: ME, already: false };
      } },
  };
  return { app: inchat.make(d), s, seen, state: () => JSON.parse(files['inchat.json'] || '{}') };
}

const card = (id, t, o) => Object.assign({ id, at: T0, issue: 'Gemini retention', url: 'https://x.com/a/status/55555', text: 'summary', thread: thread(t), threads: [thread(t)],
  story: { title: 'Accounts warn Gemini keeps chats', narrative: 'Users warn.', query: '("Gemini") AND retention', posts: 3, updateOf: '' } }, o || {});
// An alert from the Burson chat, as the bot keeps it: where it came from, and its copy's thread in the Auto-correct space
const burson = (id, t, o) => Object.assign({ id, at: T0 - H, issue: 'YouTube pressed to drop Russell Brand', text: 'A host praised YouTube for refusing.', url: 'https://x.com/a/status/66666',
  thread: `${BURSON}/threads/s`, threads: [`${BURSON}/threads/s`, thread(t)], story: null }, o || {});
const typed = (name, t, text, o) => Object.assign({ name: `${SPACE}/messages/${name}`, text, at: T0 + 60000, sender: ME, senderType: 'HUMAN', thread: thread(t), threadReply: true, clientId: '' }, o || {});

// --- the words ---------------------------------------------------------------------------------------------------

test('"temp check" typed in a message: alone, with a Brandwatch query named, or with a Boolean', () => {
  assert.deepStrictEqual(chat.ask('temp check'), { bare: true });
  assert.deepStrictEqual(chat.ask('  Temp-Check.  '), { bare: true });
  assert.deepStrictEqual(chat.ask('tempcheck'), { bare: true });
  assert.deepStrictEqual(chat.ask('temperature check on [G EVENT] NOV26 Alleged Gmail Outage'), { ref: '[G EVENT] NOV26 Alleged Gmail Outage' });
  assert.deepStrictEqual(chat.ask('temp check https://app.brandwatch.com/project/1998344909/queries/2004194405'), { ref: 'https://app.brandwatch.com/project/1998344909/queries/2004194405' });
  assert.deepStrictEqual(chat.ask('temp check: “google calendar” AND (scam OR phish*)'), { boolean: '"google calendar" AND (scam OR phish*)' });
  assert.deepStrictEqual(chat.ask('temp check gmail NEAR/5 outage'), { boolean: 'gmail NEAR/5 outage' });
  ['temp checks are due at 3', 'please run a temp check', 'tempchecking', '', null, `temp check ${'a'.repeat(1300)}`].forEach(t => assert.strictEqual(chat.ask(t), null, String(t).slice(0, 40)));
});

test('every reply starts as the bot\'s own temp check posts do, and carries an id the bot takes for its own', () => {
  const rec = recOf('tc_1', {}, 128);
  const texts = [inchat.replyText({ rec, docUrl: 'https://docs.google.com/document/d/x/edit' }), inchat.needsQueryText(), inchat.noMatchText('gmail', { near: [{ name: '[G EVENT] A' }] }),
    inchat.emptyText(rec), inchat.failedText('Brandwatch is busy')];
  texts.forEach(t => assert.match(t, /^\uD83C\uDF21\uFE0F \*Temp check/));  // the bot's own rule: 🌡️, a space, "*Temp check" (Voice.gs isBotFormattedText_)
  const id = chat.messageId('card:QA-9');
  assert.match(id, /^client-bqa-tc-[a-f0-9]{32}$/);  // "client-bqa-" is the prefix the bot knows its own posts by (Bot.gs isOwnMessage_)
  assert.ok(id.length <= 63);
  assert.strictEqual(id, chat.messageId('card:QA-9'));
  assert.notStrictEqual(id, chat.messageId('card:QA-10'));
});

test('the reply says what was counted and where, and never calls our posts mentions', () => {
  const rec = recOf('tc_1', {}, 128);
  const t = inchat.replyText({ rec, docUrl: 'https://docs.google.com/document/d/x/edit' }).split('\n');
  assert.strictEqual(t[0], '\uD83C\uDF21\uFE0F *Temp check draft:* <https://docs.google.com/document/d/x/edit|open the Google Doc>');
  assert.strictEqual(t[1], '128 mentions in Brandwatch since 10pm PT on 11/18, counted in its standing Google queries; 39 posts in our own tables.');
  assert.strictEqual(t[2], 'People say one thing.');  // Gemini's summary, its post marks taken out
  assert.strictEqual(t[3], 'No concern level until the issue has a Brandwatch query of its own. A first look made automatically: check it before it is used.');
  const own = inchat.replyText({ rec: Object.assign({}, rec, { basis: 'own', standing: null, total: 1 }), docUrl: 'https://docs.google.com/document/d/x/edit', update: true });
  assert.match(own, /^\uD83C\uDF21\uFE0F \*Temp check draft \(update\):\*/);
  assert.match(own, /\n1 matching post in our own tables since 10pm PT on 11\/18 \(posts, not Brandwatch mentions\)\.\n/);
  const q = inchat.replyText({ rec: recOf('tc_2', { query: 'x' }, 20713), docUrl: 'https://docs.google.com/document/d/x/edit' });
  assert.match(q, /\n20,713 mentions in Brandwatch since 10pm PT on 11\/18 \(\[G EVENT\] NOV26 Alleged Gmail Outage\); 39 posts in our own tables\.\n/);
  assert.ok(!/No concern level/.test(q));
});

test('the app replies only in a thread of the bot\'s Auto-correct space, as the Control tab names it', () => {
  const control = { autocorrect: SPACE, checked: true, never: [BURSON] };
  assert.strictEqual(chat.mayReply(control, thread('t1')), '');
  assert.match(chat.mayReply(control, `${BURSON}/threads/t1`), /S-F Burson's/);
  assert.match(chat.mayReply(control, 'spaces/AAAAspace009/threads/t1'), /not in the bot's Auto-correct space/);
  assert.match(chat.mayReply(Object.assign({}, control, { checked: false }), thread('t1')), /has not confirmed/);
  assert.match(chat.mayReply({ autocorrect: '', checked: true, never: [] }, thread('t1')), /names no Auto-correct space/);
  assert.match(chat.mayReply({ autocorrect: SPACE, checked: true, never: [SPACE] }, thread('t1')), /S-F Burson's/);  // one space named for both: never
  assert.match(chat.mayReply(control, `${SPACE}/messages/m1`), /not a Chat thread/);
  assert.match(chat.mayReply(null, thread('t1')), /names no Auto-correct space/);
});

test('only what the person running the app typed is heard: not the bot\'s posts, the app\'s own replies or anyone else', () => {
  const hear = m => inchat.heard(m, ME, chat.ask);
  assert.deepStrictEqual(hear(typed('m1', 't1', 'temp check')), { bare: true });
  assert.strictEqual(hear(typed('m1', 't1', 'temp check', { sender: 'users/222' })), null);
  assert.strictEqual(hear(typed('m1', 't1', 'temp check', { clientId: 'client-bqa-abc' })), null);
  assert.strictEqual(hear(typed('m1', 't1', 'temp check', { senderType: 'BOT' })), null);
  assert.strictEqual(hear(typed('m1', 't1', `${chat.HEAD} draft:* a link`)), null);
  assert.strictEqual(hear(typed('m1', 't1', 'what is the status')), null);
  assert.strictEqual(inchat.heard(typed('m1', 't1', 'temp check'), '', chat.ask), null);  // whose account is not known: nobody is heard
});

// --- story cards -------------------------------------------------------------------------------------------------

test('story cards: nothing for the cards already there; each new one gets one temp check, one Doc and one reply', async () => {
  const r = rig();
  r.s.alerts = [card('QA-1', 'a')];
  await r.app.tick();
  assert.strictEqual(r.seen.runs.length, 0);  // off: nothing
  await r.app.configure({ cards: true });
  await r.app.tick();
  assert.deepStrictEqual([r.seen.runs.length, r.seen.posts.length], [0, 0]);  // just switched on: the card already there is left alone
  r.s.alerts.push(card('QA-2', 'b', { at: T0 + H }), { id: 'QA-3', at: T0 + H, issue: 'A Burson alert', thread: thread('c'), threads: [thread('c')], story: null });
  await r.app.tick();
  assert.strictEqual(r.seen.runs.length, 1);
  assert.deepStrictEqual(r.seen.runs[0], { issue: 'Accounts warn Gemini keeps chats', trigger: 'alert', alertAt: T0 + H, alertText: 'Users warn.\nhttps://x.com/a/status/55555', own: { on: true, boolean: '("Gemini") AND retention' } });
  assert.deepStrictEqual(r.seen.docs[0].about, { why: 'card', title: 'Accounts warn Gemini keeps chats', threadUrl: 'https://chat.google.com/room/AAAAspace001/b' });
  assert.deepStrictEqual(r.seen.posts.map(p => [p.thread, p.key]), [[thread('b'), 'card:QA-2']]);
  assert.match(r.seen.posts[0].text, /<https:\/\/docs\.google\.com\/document\/d\/d1\/edit\|open the Google Doc>/);
  await r.app.tick();
  await r.app.tick();
  assert.deepStrictEqual([r.seen.runs.length, r.seen.docs.length, r.seen.posts.length], [1, 1, 1]);  // never twice
  assert.strictEqual(r.state().jobs['card:QA-2'].state, 'replied');
});

test('story cards: no query on the card, or nothing matched, and nothing is posted', async () => {
  const r = rig();
  await r.app.configure({ cards: true });
  await r.app.tick();
  r.s.alerts = [card('QA-4', 'd', { story: { title: 'A velocity signal', narrative: '', query: '', posts: 0, updateOf: '' } })];
  await r.app.tick();
  assert.deepStrictEqual([r.seen.runs.length, r.seen.posts.length, r.state().jobs['card:QA-4'].state], [0, 0, 'skipped']);
  r.s.total = 0;
  r.s.alerts.push(card('QA-5', 'e', { at: T0 + H }));
  await r.app.tick();
  assert.deepStrictEqual([r.seen.runs.length, r.seen.docs.length, r.seen.posts.length, r.state().jobs['card:QA-5'].state], [1, 0, 0, 'empty']);
});

test('it never posts where it may not: another space, a space the bot has not confirmed, or without the Chat sign-in', async () => {
  const cases = [
    s => { s.alerts.push(card('QA-6', 'f', { thread: `${BURSON}/threads/f`, threads: [`${BURSON}/threads/f`] })); },
    s => { s.control = { autocorrect: SPACE, checked: false, never: [BURSON] }; s.alerts.push(card('QA-6', 'f')); },
    s => { s.who = { signedIn: false, canRead: false, canPost: false, me: '', why: 'The app has not been signed in to Chat yet.' }; s.alerts.push(card('QA-6', 'f')); },
  ];
  for (const setUp of cases) {
    const r = rig();
    await r.app.configure({ cards: true });
    await r.app.tick();
    setUp(r.s);
    await r.app.tick();
    const job = r.state().jobs['card:QA-6'];
    assert.strictEqual(r.seen.posts.length, 0);
    assert.strictEqual(job.state, 'ready');  // made and kept, to post by hand once it may
    assert.ok(job.held);
    await assert.rejects(r.app.post('card:QA-6'), e => e.user === true && e.message === job.held);
    assert.strictEqual(r.seen.posts.length, 0);
  }
});

test('at most 30 replies a day', async () => {
  const r = rig();
  await r.app.configure({ cards: true });
  await r.app.tick();
  for (let i = 0; i < inchat.MAX_PER_DAY + 2; i++) r.s.alerts.push(card(`QA-${100 + i}`, `t${i}`, { at: T0 + i }));
  await r.app.tick();
  assert.strictEqual(r.seen.posts.length, inchat.MAX_PER_DAY);
  assert.match(r.state().jobs[`card:QA-${100 + inchat.MAX_PER_DAY}`].held, /30 replies were already posted today/);
});

// --- by hand, from the page --------------------------------------------------------------------------------------

test('by hand: the temp check and Doc are made and the reply shown; it is posted only when asked, and only once', async () => {
  const r = rig();
  r.s.alerts = [card('QA-7', 'g')];
  assert.deepStrictEqual(await r.app.prepare('QA-7'), { id: 'tc_1' });
  assert.deepStrictEqual([r.seen.runs.length, r.seen.docs.length, r.seen.posts.length], [1, 1, 0]);
  const shown = (await r.app.overview()).stories[0];
  assert.deepStrictEqual([shown.id, shown.state, shown.total, shown.docUrl], ['QA-7', 'ready', 128, 'https://docs.google.com/document/d/d1/edit']);
  assert.match(shown.text, /^\uD83C\uDF21\uFE0F \*Temp check draft:\*/);
  await r.app.prepare('QA-7');
  assert.strictEqual(r.seen.docs.length, 1);  // made already: not a second Doc
  await r.app.post('card:QA-7');
  await r.app.post('card:QA-7');
  assert.deepStrictEqual(r.seen.posts.map(p => p.key), ['card:QA-7']);
  await r.app.configure({ cards: true });
  await r.app.tick();
  r.s.alerts.push(card('QA-8', 'h', { at: T0 + H }));
  await r.app.tick();
  assert.deepStrictEqual(r.seen.posts.map(p => p.key), ['card:QA-7', 'card:QA-8']);  // the one done by hand is not answered again
  await assert.rejects(r.app.prepare('QA-999'), /not among the bot's newest alerts/);
  await assert.rejects(r.app.post('card:QA-999'), /Make its temp check first/);
});

// --- typed requests ----------------------------------------------------------------------------------------------

test('typed requests: heard only from when listening was switched on; in a story card\'s thread the card\'s query is used, and again there is an update', async () => {
  const r = rig();
  r.s.alerts = [card('QA-1', 'a')];
  r.s.messages = [typed('old', 'a', 'temp check', { at: T0 - 30000 })];
  await r.app.tick();
  await r.app.configure({ listen: true });
  await r.app.tick();
  assert.strictEqual(r.seen.runs.length, 0);  // typed before it was switched on (inside the look-back): left alone
  r.s.messages.push(typed('m1', 'a', 'temp check'));
  await r.app.tick();
  assert.deepStrictEqual(r.seen.runs[0].own, { on: true, boolean: '("Gemini") AND retention' });
  assert.deepStrictEqual(r.seen.posts.map(p => [p.thread, p.key]), [[thread('a'), `ask:${SPACE}/messages/m1`]]);
  r.s.now += 10 * 60000;
  r.s.messages.push(typed('m2', 'a', 'Temp check', { at: T0 + 9 * 60000 }));
  await r.app.tick();
  assert.deepStrictEqual(r.seen.runs[1], { updateOf: 'tc_1', trigger: 'alert', own: { on: true, reuse: 'tc_1' } });
  assert.match(r.seen.posts[1].text, /^\uD83C\uDF21\uFE0F \*Temp check draft \(update\):\*/);
  await r.app.tick();
  assert.strictEqual(r.seen.posts.length, 2);
});

test('typed requests: a Brandwatch query by name, a Boolean, and a thread with nothing to count with', async () => {
  const r = rig();
  r.s.alerts = [{ id: 'QA-3', at: T0 - H, issue: 'A Burson alert', text: 'what it says', url: 'https://x.com/a/status/66666', thread: `${BURSON}/threads/s`, threads: [`${BURSON}/threads/s`, thread('c')], story: null }];
  await r.app.configure({ listen: true });
  r.s.messages = [typed('m1', 'y', 'temp check'), typed('m2', 'c', 'temp check [G EVENT] NOV26 Alleged Gmail Outage', { at: T0 + 61000 }),
    typed('m3', 'z', 'temp check "google calendar" AND (scam OR phish*)', { at: T0 + 62000, threadReply: false }), typed('m4', 'c', 'temp check gmail', { at: T0 + 63000 })];
  r.s.needs = null;
  await r.app.tick();
  assert.strictEqual(r.seen.posts[0].text, inchat.needsQueryText());  // a thread with no alert in it: there is nothing to draft a query from
  assert.strictEqual(r.seen.drafts.length, 0);
  assert.deepStrictEqual(r.seen.runs[0], { query: '[G EVENT] NOV26 Alleged Gmail Outage', trigger: 'alert', alertAt: T0 - H, alertText: 'what it says\nhttps://x.com/a/status/66666' });
  assert.deepStrictEqual(r.seen.runs[1], { issue: '"google calendar" AND (scam OR phish*)', trigger: 'alert', alertAt: T0, alertText: '', own: { on: true, boolean: '"google calendar" AND (scam OR phish*)' } });
  assert.strictEqual(r.seen.posts[2].thread, thread('z'));  // typed outside any thread: answered under the message itself
  assert.strictEqual(r.seen.runs.length, 3);
  assert.strictEqual(r.seen.docs.length, 3);
  const r2 = rig();
  await r2.app.configure({ listen: true });
  r2.s.needs = { needs: 'query', ref: 'gmail', choices: [], near: [{ name: '[G EVENT] NOV26 Alleged Gmail Outage' }], missing: 0 };
  r2.s.messages = [typed('m1', 'c', 'temp check gmail')];
  await r2.app.tick();
  assert.match(r2.seen.posts[0].text, /no Brandwatch query in the team's project matches "gmail"\. Close ones: \[G EVENT\] NOV26 Alleged Gmail Outage\./);
  assert.strictEqual(r2.seen.docs.length, 0);
});

// --- an alert nobody has written a query for ---------------------------------------------------------------------

test('in an alert\'s thread: a query is drafted from the alert, counted with and checked; the reply names it and says how it fits', async () => {
  const r = rig();
  r.s.alerts = [burson('QA-3', 'c')];
  await r.app.configure({ listen: true });
  r.s.messages = [typed('m1', 'c', 'temp check')];
  await r.app.tick();
  assert.deepStrictEqual(r.seen.drafts, ['YouTube pressed to drop Russell Brand\nA host praised YouTube for refusing.\nhttps://x.com/a/status/66666']);
  assert.deepStrictEqual(r.seen.runs, [{ issue: 'YouTube pressed to drop Russell Brand', trigger: 'alert', alertAt: T0 - H, alertText: 'A host praised YouTube for refusing.\nhttps://x.com/a/status/66666',
    own: { on: true, boolean: DRAFT.boolean, drafted: DRAFT } }]);
  const lines = r.seen.posts[0].text.split('\n');
  assert.match(lines[0], /^\uD83C\uDF21\uFE0F \*Temp check draft:\* <https:\/\/docs\.google\.com\/document\/d\/d1\/edit\|open the Google Doc>$/);
  assert.strictEqual(lines[2], 'Query drafted from the alert: `(YouTube) AND ("Russell Brand") AND (ban* OR censor*)` 23 of the 25 posts read are about this issue.');
  assert.deepStrictEqual(r.seen.docs[0].about.drafted, { query: DRAFT.boolean, check: { read: 25, about: 23, share: 0.92, others: '', why: '' }, note: '23 of the 25 posts read are about this issue.' });
  assert.strictEqual(r.seen.narrows.length, 0);  // it fits: left as it is
  r.s.now += 10 * 60000;
  r.s.messages.push(typed('m2', 'c', 'temp check', { at: T0 + 9 * 60000 }));
  await r.app.tick();
  assert.deepStrictEqual(r.seen.runs[1], { updateOf: 'tc_1', trigger: 'alert', own: { on: true, reuse: 'tc_1' } });  // again there: an update, with the query it used
  assert.strictEqual(r.seen.drafts.length, 1);
});

test('a drafted query that caught other posts too is narrowed once, and the one that fits better is the one used', async () => {
  const narrower = Object.assign({}, DRAFT, { angle: 'deplatform*', boolean: '(YouTube) AND ("Russell Brand") AND (deplatform*)' });
  const r = rig();
  r.s.alerts = [burson('QA-3', 'c')];
  await r.app.configure({ listen: true });
  r.s.checks = [{ read: 20, about: 12, share: 0.6, off: [0], others: 'Brand\'s *trial*' }, { read: 20, about: 19, share: 0.95, off: [], others: '' }];
  r.s.narrowed = narrower;
  r.s.messages = [typed('m1', 'c', 'temp check')];
  await r.app.tick();
  assert.deepStrictEqual(r.seen.runs.map(x => x.own.boolean), [DRAFT.boolean, narrower.boolean]);
  assert.strictEqual(r.seen.docs[0].rec, 'tc_2');
  assert.ok(r.seen.posts[0].text.includes('Query drafted from the alert: `(YouTube) AND ("Russell Brand") AND (deplatform*)` 19 of the 20 posts read are about this issue.'));
  const r2 = rig();  // a narrower one that fits no better: the first stands, and the reply says its count runs high
  r2.s.alerts = [burson('QA-3', 'c')];
  await r2.app.configure({ listen: true });
  r2.s.checks = [{ read: 20, about: 12, share: 0.6, off: [0], others: 'Brand\'s *trial*' }, { read: 20, about: 11, share: 0.55, off: [], others: '' }];
  r2.s.narrowed = narrower;
  r2.s.messages = [typed('m1', 'c', 'temp check')];
  await r2.app.tick();
  assert.strictEqual(r2.seen.runs.length, 2);
  assert.strictEqual(r2.seen.docs[0].rec, 'tc_1');
  assert.ok(r2.seen.posts[0].text.includes('`(YouTube) AND ("Russell Brand") AND (ban* OR censor*)` Only 12 of the 20 posts read are about this issue (the others: Brand\'s trial), so the count runs high.'));
});

test('a drafted query that mostly caught other posts gives no count: the reply says so and names the query that was tried', async () => {
  const r = rig();
  r.s.alerts = [burson('QA-3', 'c')];
  await r.app.configure({ listen: true });
  r.s.checks = [{ read: 25, about: 8, share: 0.32, off: [1, 2], others: 'other news about him' }];
  r.s.messages = [typed('m1', 'c', 'temp check')];
  await r.app.tick();
  assert.deepStrictEqual([r.seen.runs.length, r.seen.docs.length, r.seen.posts.length], [1, 0, 1]);
  assert.strictEqual(r.seen.posts[0].text, inchat.offTopicText(DRAFT.boolean, { read: 25, about: 8, others: 'other news about him' }));
  assert.match(r.seen.posts[0].text, /^\uD83C\uDF21\uFE0F \*Temp check:\* no count for this one\. The query drafted from the alert mostly caught other posts: only 8 of the 25 read were about the issue \(the others: other news about him\)\. The query tried: `/);
  assert.ok(!/mentions in Brandwatch|docs\.google/.test(r.seen.posts[0].text));
  r.s.now += 10 * 60000;
  r.s.messages.push(typed('m2', 'c', 'temp check', { at: T0 + 9 * 60000 }));
  await r.app.tick();
  assert.strictEqual(r.seen.drafts.length, 2);  // asked again: drafted afresh, not an update of a count nobody was given
  assert.strictEqual(r.seen.docs.length, 1);
});

test('a drafted query that matches nothing is counted once more without its words about what happened; nothing again, and the reply names the query', async () => {
  const r = rig();
  r.s.alerts = [burson('QA-3', 'c')];
  await r.app.configure({ listen: true });
  r.s.totals = [0, 64];
  r.s.checks = [{ read: 10, about: 7, share: 0.7, off: [], others: '' }];
  r.s.narrowed = DRAFT;
  r.s.messages = [typed('m1', 'c', 'temp check')];
  await r.app.tick();
  assert.deepStrictEqual(r.seen.runs.map(x => x.own.boolean), [DRAFT.boolean, DRAFT.wide]);
  assert.strictEqual(r.seen.narrows.length, 0);  // two temp checks at most for one request
  assert.ok(r.seen.posts[0].text.includes('`(YouTube) AND ("Russell Brand")` Only 7 of the 10 posts read are about this issue, so the count runs high.'));
  const r2 = rig();
  r2.s.alerts = [burson('QA-3', 'c')];
  await r2.app.configure({ listen: true });
  r2.s.total = 0;
  r2.s.messages = [typed('m1', 'c', 'temp check')];
  await r2.app.tick();
  assert.deepStrictEqual([r2.seen.runs.length, r2.seen.docs.length, r2.seen.checks.length], [2, 0, 0]);
  assert.match(r2.seen.posts[0].text, /nothing matched between .* The query drafted from the alert: `\(YouTube\) AND \("Russell Brand"\)` Send `temp check` followed by a Boolean of your own/);
  const r3 = rig();  // no query could be drafted at all: said in the thread, in plain words
  r3.s.alerts = [burson('QA-3', 'c')];
  await r3.app.configure({ listen: true });
  r3.s.draftFail = new Error('Gemini named a subject and nothing about the issue');
  r3.s.messages = [typed('m1', 'c', 'temp check')];
  await r3.app.tick();
  assert.strictEqual(r3.seen.posts[0].text, inchat.failedText('no query could be drafted from the alert'));
  assert.strictEqual(r3.seen.runs.length, 0);
});

test('the check reads the most-engaged posts and an even spread of our own, each once, 40 at most; and says what it found in a sentence', () => {
  const rec = { readPosts: [{ key: 'a', text: 'one' }, { key: 'b', text: '' }, { key: 'a', text: 'one again' }], own: { posts: Array.from({ length: 300 }, (_, i) => ({ key: `o${i}`, text: `post  ${i}` })) } };
  const got = inchat.sample(rec);
  assert.deepStrictEqual(got.slice(0, 4), [{ text: 'one' }, { text: 'post 0' }, { text: 'post 20' }, { text: 'post 40' }]);
  assert.strictEqual(got.length, 16);
  assert.strictEqual(inchat.sample({ readPosts: Array.from({ length: 60 }, (_, i) => ({ key: `k${i}`, text: `t${i}` })) }).length, inchat.CHECK_POSTS);
  assert.deepStrictEqual(inchat.sample(null), []);
  assert.strictEqual(inchat.checkLine(null), 'It could not be checked against the posts it found.');
  assert.strictEqual(inchat.checkLine({ read: 0, about: 0, share: 0 }), 'It could not be checked against the posts it found.');
  assert.strictEqual(inchat.checkLine({ read: 40, about: 32, share: 0.8 }), '32 of the 40 posts read are about this issue.');
  assert.strictEqual(inchat.checkLine({ read: 40, about: 31, share: 0.775, others: '' }), 'Only 31 of the 40 posts read are about this issue, so the count runs high.');
  assert.match(inchat.offTopicText('a `b`', { read: 2, about: 0 }), /^\uD83C\uDF21\uFE0F \*Temp check:\* no count .* The query tried: `a 'b'` Send/);
  assert.match(docs.docHtml(recOf('tc_1', {}, 5), { why: 'ask', drafted: { note: '23 of the 25 posts read are about this issue.' } }),
    /Where the query came from:<\/b> Gemini drafted it from the alert; nobody chose it\. 23 of the 25 posts read are about this issue\./);
});

test('a tight query is the three lists joined with AND; the company alone is not the subject when something more exact is named', () => {
  const d = gemini.tightFrom({ subject: 'Google OR "Google Calendar" OR gcal OR @Google', specifics: 'invite* OR invitation*', angle: 'scam* OR phish* OR (spam*)', why: ' catches  it ' });
  assert.strictEqual(d.boolean, '("Google Calendar" OR gcal) AND (invite* OR invitation*) AND (scam* OR phish* OR spam*)');
  assert.strictEqual(d.wide, '("Google Calendar" OR gcal) AND (invite* OR invitation*)');
  assert.strictEqual(d.why, 'catches it');
  assert.strictEqual(gemini.tightFrom({ subject: 'Google OR Alphabet', specifics: '"antitrust ruling"', angle: '' }).boolean, '(Google OR Alphabet) AND ("antitrust ruling")');  // the company is the subject: kept
  assert.strictEqual(gemini.tightFrom({ subject: 'Waymo', specifics: '', angle: 'crash*' }).wide, '');  // no angle to drop that would leave anything
  assert.throws(() => gemini.tightFrom({ subject: 'Waymo', specifics: '', angle: '' }), /everything said about the subject/);
  assert.throws(() => gemini.tightFrom({ subject: '', specifics: 'a', angle: 'b' }), /named nothing/);
});

test('the check counts only what Gemini could tell, and is asked for without the model\'s long thinking', () => {
  assert.deepStrictEqual(gemini.aboutFrom({ about: [1, 2, 3, 3, 9], other: [3, 4, 0, 'x'], others_are_about: ' other  news ' }, 5),
    { read: 3, about: 2, share: 2 / 3, off: [3], others: 'other news' });  // 3 is in both lists, 9 and 0 are not on the list: none of them counts
  assert.deepStrictEqual(gemini.aboutFrom({}, 5), { read: 0, about: 0, share: 0, off: [], others: '' });
  assert.deepStrictEqual(gemini.requestBody('s', 'p', { type: 'OBJECT' }, true).generationConfig.thinkingConfig, { thinkingBudget: 0 });
  assert.ok(!('thinkingConfig' in gemini.requestBody('s', 'p', { type: 'OBJECT' }, false).generationConfig));
});

test('typed requests: when it fails the thread is told so, in plain words, and what went wrong stays in the app', async () => {
  const r = rig();
  await r.app.configure({ listen: true });
  r.s.fail = new Error('Google HTTP 403: Access Denied: someone@corp.example.test may not query table x');
  r.s.messages = [typed('m1', 'c', 'temp check "a" AND b')];
  await r.app.tick();
  assert.strictEqual(r.seen.posts[0].text, inchat.failedText('the app\'s page says why'));
  assert.ok(!/corp\.example|Access Denied/.test(r.seen.posts[0].text));
  const kept = r.state().jobs[`ask:${SPACE}/messages/m1`];
  assert.strictEqual(kept.posted, 'failed');
  assert.match(kept.why, /Access Denied: an address may not query/);  // the address is cut out of what the app keeps, too
  const told = new Error('"X" is deactivated in Brandwatch, and Brandwatch only gives numbers for an active query.');
  told.user = true;
  r.s.fail = told;
  r.s.messages.push(typed('m2', 'c', 'temp check X query', { at: T0 + 61000 }));
  await r.app.tick();
  assert.match(r.seen.posts[1].text, /couldn't do it: "X" is deactivated in Brandwatch/);  // a reason that is the asker's to act on is passed on
});

test('typed requests: one typed from another account is never answered; the page says it was left alone, once, without its words', async () => {
  const r = rig();
  await r.app.configure({ listen: true });
  r.s.messages = [typed('m1', 'c', 'temp check "their words" AND b', { sender: 'users/222' }), typed('m2', 'c', 'good morning', { sender: 'users/222', at: T0 + 61000 })];
  await r.app.tick();
  await r.app.tick();  // seen again inside the look-back: not said twice
  assert.deepStrictEqual([r.seen.runs.length, r.seen.docs.length, r.seen.posts.length], [0, 0, 0]);
  const lines = r.state().log.filter(l => l.state === 'left alone');
  assert.strictEqual(lines.length, 1);
  assert.match(lines[0].what, /Only requests typed from the account this app is signed in to Chat as are answered/);
  assert.ok(!/their words/.test(JSON.stringify(r.state())));
});

test('the sign-in: one line with the two Chat permissions and its own folder; the other way names the client file kept outside the repository', () => {
  const line = chat.signInCommand();
  assert.match(line, /^CLOUDSDK_CONFIG="\$HOME\/\.config\/tempcheck-app\/chat" gcloud auth application-default login --scopes=/);
  assert.match(line, /auth\/chat\.messages\.readonly,https:\/\/www\.googleapis\.com\/auth\/chat\.messages\.create$/);
  assert.ok(!/client-id-file/.test(line));
  assert.ok(!/chat\.(spaces|memberships|delete|import)|chat\.messages(,|$)/.test(line));  // nothing wider than read messages and post one
  const other = chat.signInCommand(true);
  assert.ok(other.includes(' --client-id-file="$HOME/.config/tempcheck-app/chat-client.json" --scopes='));
  assert.strictEqual(other.replace(' --client-id-file="$HOME/.config/tempcheck-app/chat-client.json"', ''), line);
});

test('typed requests: nobody is heard until it is known whose account the Chat sign-in is', async () => {
  const r = rig();
  r.s.who = { signedIn: true, canRead: true, canPost: true, me: '', why: '' };
  await r.app.configure({ listen: true });
  r.s.messages = [typed('m1', 'c', 'temp check "a" AND b')];
  await r.app.tick();
  assert.strictEqual(r.seen.runs.length, 0);
  assert.match(r.state().lastError, /cannot tell which messages are yours/);
});

// --- the Doc -----------------------------------------------------------------------------------------------------

test('the Doc: the write-up with its chart as a picture, a line saying how it was made, and everything from outside escaped', () => {
  const rec = recOf('tc_1', { own: { boolean: '("Gemini") AND <b>retention</b>' } }, 128);
  rec.own.tables = { sonar: { matched: 34 }, alerts: { matched: 5 }, tubular: { skip: 'too big' } };
  const html = docs.docHtml(rec, { why: 'card', title: 'A story', threadUrl: 'https://chat.google.com/room/AAAAspace001/b' });
  assert.match(html, /A first look made automatically for an Early Detection story card at 10pm PT on 11\/19\./);
  assert.match(html, /Its numbers are Brandwatch&#39;s, counted in its 27 standing Google queries with the query below/);
  assert.match(html, /<a href="https:\/\/chat\.google\.com\/room\/AAAAspace001\/b">The thread in Chat<\/a>/);
  assert.match(html, /<p>write-up<\/p><p [^>]*><b>A chart<\/b><br><img src="data:image\/png;base64,[A-Za-z0-9+/=]+" width="680" height="280" alt="Mentions by hour"><\/p>/);
  assert.ok(html.includes('(&quot;Gemini&quot;) AND &lt;b&gt;retention&lt;/b&gt;') && !html.includes('<b>retention</b>'));
  assert.match(html, /Our own tables:<\/b> 39 posts and comments \(Sundar all mentions 5, Sonar 34, Tubular videos not searched\)\./);
  assert.match(html, /Concern level:<\/b> none\. not ranked/);
  assert.ok(!docs.docHtml(rec, { why: 'ask', threadUrl: 'javascript:alert(1)' }).includes('javascript:'));
  assert.match(docs.docHtml(rec, { why: 'ask' }), /made automatically when it was asked for in Chat/);
  assert.strictEqual(docs.docName(rec, 'A   story'), 'Temp check draft: A story (11/19 10pm PT)');
  assert.strictEqual(docs.basisLine(Object.assign({}, rec, { basis: 'own' })), 'It is built from our own tables only: its counts are posts, not Brandwatch mentions.');
  assert.strictEqual(docs.basisLine(recOf('tc_2', { query: 'x' }, 5)), 'Its numbers are Brandwatch\'s, from the query "[G EVENT] NOV26 Alleged Gmail Outage".');
  const none = docs.docHtml(Object.assign({}, rec, { total: 0, writeup: { html: '<p>nothing</p>' } }), {});
  assert.ok(!none.includes('<img'));
});
