// The open-engine plan's O5 (settled by the owner): the SLRR alerts table holds only negative posts, so the absence of
// positive rows in it is never read as a signal, and it is never used to judge sentiment balance. Test: no SQL the bot
// builds from that table selects or counts a sentiment column (today the table is only a leave-out list and an alert
// history). Every SQL text in every file of the bot that reads `slrr_alerts.slrr_alerts` is looked at: the statement
// around each place it is read.
'use strict';

module.exports = H => {
  const { test, eq, assert } = H;
  const fs = require('fs');
  const path = require('path');
  const ROOT = path.join(__dirname, '..');

  test('SLRR sentiment rule (O5): no SQL built from the SLRR alerts table selects or counts a sentiment column; the rule is written beside the table\'s name', () => {
    const files = fs.readdirSync(ROOT).filter(f => f.endsWith('.gs'));
    const reads = [];
    files.forEach(f => {
      const lines = fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (!/slrr_alerts\.slrr_alerts`|BQ_WRITEBACK_ALERTS_TABLE_\}`/.test(line) || /^\s*(\/\/|\*)/.test(line)) return;
        // the statement that reads it: from its SELECT (up to 15 lines above) to the end of its WHERE (up to 8 below)
        let from = i;
        while (from > 0 && i - from < 15 && !/SELECT/i.test(lines[from])) from--;
        const sql = lines.slice(from, Math.min(lines.length, i + 9)).join('\n');
        reads.push({ at: `${f}:${i + 1}`, sql });
      });
    });
    assert.ok(reads.length >= 7, `found ${reads.length} reads of the table`);  // (7 today: a new one is looked at too)
    eq(reads.filter(r => /sentiment/i.test(r.sql)).map(r => r.at), []);
    const bq = fs.readFileSync(path.join(ROOT, 'BigQuery.gs'), 'utf8');
    assert.ok(/the absence of positive rows in it is never read as a signal/.test(bq) && /never used to judge sentiment\n\/\/ balance/.test(bq));
  });
};
