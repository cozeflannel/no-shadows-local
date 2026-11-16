// What the row-46 writer (Write early-wave records to BigQuery) is sent over one long mixed day (ed_endings.js), as
// recorded at commit 928724a, before the per-story record of the fix plan (P3a) touched the lines that feed it:
// ed_row46_record.json. The writer's tables take only the columns the code lists, and one unknown column refuses a whole
// batch, so every row must stay what it was: each signal event in full (its insert id, time, signal, story, event,
// reason and detail), and each batch of the signals and triage_verdicts tables by its size and fingerprint.
//
// The day runs with every new setting of the fix plan off (golden.SETTINGS_OFF), in the one-space setup and in the
// Mirror flow, so a later change that is on by default never moves this record. The record is never edited: its
// fingerprint is pinned below. (ED_ROW46_RECORD=1 node apps-script-chat-bot/test/run_tests.js "row-46 record" writes it
// again from the code as it is; the fingerprint below then has to be changed on purpose too.)
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

module.exports = H => {
  const { test, eq, assert } = H;
  const golden = require('./golden_flows')(H);
  const ends = require('./ed_endings')(H);
  const FILE = path.join(__dirname, 'ed_row46_record.json');
  const RECORDED_SHA256 = '44472a14d129f3238e939b28696749ead6c0213bc7eb2a8733b4503bc9b4bec7';  // of ed_row46_record.json
  const FLOWS = ['one-space', 'mirror'];
  const sha = text => crypto.createHash('sha256').update(text).digest('hex');

  /** What the writer was sent over the day in `flow`, batch by batch: [{run, table, rows}] or [{run, table, n, sha256}]. */
  function sent(flow) {
    const w = ends.world({ flow, row46: true, settings: golden.SETTINGS_OFF });
    const out = [];
    ends.day(w, (run, look) => look.writes.forEach(b => out.push(b.table === 'signal_events'
      ? { run: run.at, table: b.table, rows: b.rows }
      : { run: run.at, table: b.table, n: b.rows.length, sha256: sha(JSON.stringify(b.rows)) })));
    return out;
  }
  // one batch a line, so a change shows as the lines it changed
  const fileText = record => `{\n${FLOWS.map(f => ` ${JSON.stringify(f)}: [\n${record[f].map(b => `  ${JSON.stringify(b)}`).join(',\n')}\n ]`).join(',\n')}\n}\n`;

  test('early detection row-46 record: over the long mixed day the writer is sent exactly the rows it was sent before the per-story record was built (every signal event in full; the signals and triage_verdicts batches by size and fingerprint), in the one-space setup and in the Mirror flow; with row 46 OFF nothing is sent', () => {
    const now = {};
    FLOWS.forEach(f => { now[f] = sent(f); });
    if (process.env.ED_ROW46_RECORD === '1') fs.writeFileSync(FILE, fileText(now));
    const text = fs.readFileSync(FILE, 'utf8');
    eq(sha(text), RECORDED_SHA256);
    const recorded = JSON.parse(text);
    FLOWS.forEach(f => {
      const was = recorded[f];
      for (let i = 0; i < Math.max(was.length, now[f].length); i++) eq(now[f][i], was[i], `${f}: batch ${i + 1}`);
      // the day sends every kind of event the writer knows, so the record covers each line that feeds it
      const events = [].concat(...was.filter(b => b.table === 'signal_events').map(b => b.rows.map(r => r.json.event)));
      eq(Array.from(new Set(events)).sort(),
        ['carded', 'dropped_stale', 'filtered_fast_triage', 'held_repeat', 'queued', 'reviewed', 'update_posted']);
      assert.ok(was.some(b => b.table === 'signals') && was.some(b => b.table === 'triage_verdicts'), f);
    });
    FLOWS.forEach(f => {
      const off = ends.world({ flow: f, row46: false, settings: golden.SETTINGS_OFF });
      ends.day(off);
      eq(off.writes, [], `${f}: row 46 OFF`);
    });
  });
};
