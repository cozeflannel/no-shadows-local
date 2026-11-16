// Golden flows: two end-to-end scenarios (golden_flows.js) whose every output was recorded at commit f93e31a, before the
// fix plan's first change, in golden_flows_f93e31a.json. They are the net under two promises of that plan:
//   - the Mirror flow stays byte for byte: whatever the settings, it puts out what it did at f93e31a;
//   - a setting turned off gives what the bot did before: with every new setting off, the one-space setup too.
// What the one-space setup puts out with the DEFAULT settings is recorded apart (golden_flows_defaults.json): a change
// that is meant to show there updates that file on purpose and says so in its commit message
// (GOLDEN_UPDATE_DEFAULTS=1 node apps-script-chat-bot/test/run_tests.js "golden flows: the one-space setup with the default"
// rewrites it from the code as it is). The record of f93e31a is never edited: its fingerprint is pinned below.
//
// Compared: every Chat post (space, thread, text), every Burson test copy post, every emoji the bot put on a message,
// every email (recipients, subject, text and html) and every Burson outbox row, each in order. Not compared: the Control
// tab's notes.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

module.exports = H => {
  const { test, eq, assert, F } = H;
  const golden = require('./golden_flows')(H);
  const DEFAULTS_FILE = path.join(__dirname, 'golden_flows_defaults.json');
  const RECORDED_SHA256 = '82e9200dcb2d3905501edc1abab896693480aa9c6d3a914ccbbbcae7876532b2';  // of golden_flows_f93e31a.json
  const { MIRROR, COPY, AC, REAL } = golden.spaces;
  const { PIXEL, MAPS, GEMINI } = golden.posts;

  test('golden flows: the Mirror flow (B9; rows 15, 19, 22, 24 and 34 ON; Testing with a Burson test copy, then LIVE) puts out exactly what it did at f93e31a, with the default settings and with every new setting off: each Chat post, test copy post, emoji, email and Burson outbox row', () => {
    eq(golden.differences(golden.mirror(), golden.recorded.mirror), []);
    eq(golden.differences(golden.mirror(golden.SETTINGS_OFF), golden.recorded.mirror), []);
  });

  test('golden flows: the one-space setup (B3, B4 and B9 blank; B10; rows 15, 19, 34, 38, 39 and 40 ON; B35 = B10) with every new setting off puts out exactly what it did at f93e31a', () => {
    eq(golden.differences(golden.oneSpace(golden.SETTINGS_OFF), golden.recorded.one_space), []);
  });

  test('golden flows: the one-space setup with the default settings puts out the recorded default set (golden_flows_defaults.json)', () => {
    const out = golden.oneSpace();
    if (process.env.GOLDEN_UPDATE_DEFAULTS === '1') fs.writeFileSync(DEFAULTS_FILE, `${JSON.stringify({ one_space: out }, null, 1)}\n`);
    eq(golden.differences(out, JSON.parse(fs.readFileSync(DEFAULTS_FILE, 'utf8')).one_space), []);
  });

  test('golden flows: the record of f93e31a holds what each scenario is named for (a Burson alert corrected and ending in a Social Alert, a Direct BigQuery card posted and reviewed, a story queued, reviewed and posted, a watch flag posted and triaged; the Mirror\'s test copy posts and Burson outbox rows; in the one-space setup, one card for the post Direct BigQuery and the watch both found, and no card for the story whose main post has a Direct BigQuery card)', () => {
    const tops = (o, rx) => o.chat.filter(c => !c.reply && rx.test(c.text));
    const under = (o, top, rx) => o.chat.filter(c => c.reply && c.thread === top.thread && rx.test(c.text));
    const bqCard = /^THIS ALERT MEETS P\d CRITERIA · \S+ \*\[BigQuery · BSIP\]\*\n/;
    const story = /^🚨 \*EARLY DETECTION\* · New story\n/;
    const watch = /^🔭 \*WATCH\* · Google brand safety \(all\)\n/;
    const reactedOn = (o, emoji) => o.reactions.filter(r => r.emoji.replace(/️/g, '') === emoji).map(r => r.on);

    // (a) the Mirror flow
    const m = golden.recorded.mirror;
    eq(Array.from(new Set(m.chat.map(c => c.space))).sort(), ['spaces/AAQAaLn375E', MIRROR].sort());  // setup's hello, then the Mirror space only
    assert.ok(!m.chat.concat(m.test_copy).some(c => c.space === REAL), 'nothing is posted in S-F Burson');
    const fix = /^Please make the following updates and resend the alert here:\n- Product listed is incorrect\. Please change to Gemini App\./;
    eq([m.chat.filter(c => c.reply && fix.test(c.text)).length, m.test_copy.filter(c => c.reply && fix.test(c.text)).length], [2, 1]);
    eq(m.emails.map(e => [e.run.slice(0, 2), e.kind, e.to, e.cc, /^(?:Re: )?\S+SOCIAL ALERT\S+: Gemini App \| /.test(e.subject)]),
      [['03', 'sent', ['tester@testing.test'], [], true], ['12', 'draft', ['gemini-app@alerts.test'], ['default-cc@alerts.test'], true]]);
    const [mBq] = tops(m, bqCard);
    eq([tops(m, bqCard).length, mBq.text.includes(`[Link]: ${PIXEL}\n`), mBq.run.slice(0, 2)], [1, true, '06']);
    const [mStory] = tops(m, story);
    eq([tops(m, story).length, /Chrome users say the update closed all their open tabs/.test(mStory.text),
      under(m, mStory, /^🤖 \*Early Detection Review: /).length], [1, true, 1]);
    const [mWatch] = tops(m, watch);
    eq([tops(m, watch).length, mWatch.text.includes(GEMINI), under(m, mWatch, /^🤖 \*Triage: /).length], [1, true, 1]);
    eq(m.test_copy.map(c => [c.space, c.reply, c.text.split('\n')[0]]), [
      [COPY, false, F.MISTAKES.split('\n')[0]],
      [COPY, true, 'Please make the following updates and resend the alert here:'],
      [COPY, true, 'Alice Smith: Why is the product wrong?'],
      [COPY, true, 'Dana Lee: Thanks, we are checking this one now.'],
      [COPY, true, 'Happy to help with that.'],
      [COPY, false, F.MISTAKES_FIXED.split('\n')[0]],
    ]);
    eq(m.outbox.map(r => [r[1], String(r[3]).split('\n')[0], r[4], r[5]]), [
      ['reaction', '⬇️', 'bot', 'Pending'],
      ['reply', 'Please make the following updates and resend the alert here:', 'bot', 'Pending'],
      ['reply', 'Dana Lee: Thanks, we are checking this one now.', 'relay: Dana Lee', 'Pending'],
      ['reply', 'Happy to help with that.', 'bot', 'Pending'],
      ['reaction', '👍', 'bot', 'Pending'],
    ]);

    // (b) the one-space setup
    const o = golden.recorded.one_space;
    eq([Array.from(new Set(o.chat.map(c => c.space))).sort(), o.test_copy, o.outbox], [['spaces/AAQAaLn375E', AC].sort(), [], []]);
    const [fixed] = tops(o, /^✅ \*Reviewed and corrected by the agentic assistant\*\n/);
    eq([under(o, fixed, /^The agentic assistant reviewed this alert and made these changes:\n- Product: Gems to Gemini App\n/).length,
      o.emails.map(e => [e.run.slice(0, 2), e.kind, e.to, e.subject.split(' | ')[0]])],
    [1, [['03', 'sent', ['tester@testing.test'], '[Auto-correct test] 🟥SOCIAL ALERT🟥: Gemini App'],
      ['10', 'sent', ['tester@testing.test'], '[Auto-correct test] 🟥SOCIAL ALERT🟥: Google Maps']]]);
    const cards = tops(o, bqCard);
    eq(cards.map(c => [c.run.slice(0, 2), (c.text.match(/\[Link\]: (\S+)/) || [])[1]]), [['04', PIXEL], ['09', MAPS]]);
    cards.forEach(c => eq(under(o, c, /^The agentic assistant reviewed this alert\. The card above was posted before the review; /).length, 1));
    const [oStory] = tops(o, story);
    eq([tops(o, story).length, /Chrome users say the update closed all their open tabs/.test(oStory.text),
      under(o, oStory, /^🤖 \*Early Detection Review: /).length, oStory.run.slice(0, 2)], [1, true, 1, '09']);
    const [oWatch] = tops(o, watch);
    eq([tops(o, watch).length, oWatch.text.includes(GEMINI), under(o, oWatch, /^🤖 \*Triage: /).length], [1, true, 1]);
    // the post Direct BigQuery and the watch both found: its Direct BigQuery card only; the story on the Pixel post: no card
    eq([o.chat.filter(c => !c.reply && c.text.includes(MAPS)).length, o.chat.some(c => /Pixel 10 owners say/.test(c.text))], [1, false]);
    // in the run that had both, the Direct BigQuery card was posted before the story's card (the order at f93e31a)
    assert.ok(o.chat.indexOf(cards[1]) < o.chat.indexOf(oStory), 'the Maps card comes before the story card');
    eq([reactedOn(o, '❌').length, reactedOn(o, '📦').length], [1, 2]);
  });

  test('golden flows: the record of f93e31a is as it was recorded (its fingerprint; it is never edited: what a change is meant to alter goes in golden_flows_defaults.json), and differences() says where two records differ: a changed text, a missing or a new post', () => {
    eq(crypto.createHash('sha256').update(fs.readFileSync(golden.RECORDED_FILE)).digest('hex'), RECORDED_SHA256);
    const base = golden.recorded.one_space;
    const copy = () => JSON.parse(JSON.stringify(base));
    eq(golden.differences(copy(), base), []);
    const reworded = copy();
    reworded.chat[3].text = reworded.chat[3].text.replace('BigQuery', 'Bigquery');
    const said = golden.differences(reworded, base);
    eq([said.length, /^chat\[3\] \(run "04 Direct BigQuery finds the Pixel post"\) differs at character \d+: got ".*Bigquery.*", expected ".*BigQuery.*"$/.test(said[0])],
      [1, true], said[0]);
    const shorter = copy();
    shorter.chat.pop();
    const longer = copy();
    longer.emails.push({ run: 'x', kind: 'sent', to: ['someone@testing.test'], cc: [], bcc: [], subject: 's', text: 't', html: 'h' });
    eq([golden.differences(shorter, base).map(d => d.split(';')[0]), golden.differences(longer, base).map(d => d.split(':')[0])],
      [[`chat[${base.chat.length - 1}] is missing`], [`emails[${base.emails.length}] is new`]]);
    // every list is compared, and one the comparison doesn't know is never passed over
    eq(golden.LISTS.slice().sort(), Object.keys(base).sort());
    eq(golden.differences(Object.assign(copy(), { notes: [] }), base), ['a list this comparison doesn\'t know: notes']);
  });
};
