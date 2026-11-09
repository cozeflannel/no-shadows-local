// Reads a JSON array of alert texts on stdin and prints the bot's parse of each as JSON:
// [{detected, fields, record_key}]. Used by tests/test_apps_script_bot.py to check parity with the Python parser.
'use strict';
const { loadBot } = require('./fakes');

const NOW = Date.UTC(2026, 9, 12, 12, 0);
let input = '';
process.stdin.on('data', d => { input += d; }).on('end', () => {
  const parsed = JSON.parse(input);
  const isObj = parsed && !Array.isArray(parsed) && Array.isArray(parsed.texts);
  const B = loadBot(null, null, isObj && Array.isArray(parsed.bsg_rows) ? { noSyntheticSeed: true } : null);
  if (isObj && Array.isArray(parsed.bsg_rows)) B.applyBrandSafetyGroups_(parsed.bsg_rows);
  const texts = isObj ? parsed.texts : parsed;
  const out = texts.map(text => {
    const p = B.parseAlert_(text);
    const r = B.reviewAlert_(p, { now: NOW, history: [] });
    const esc = B.escalation_(r.fields, { now: NOW });
    const plan = B.planRecipients_(esc, esc.text, []);
    return {
      detected: B.detectAlert_(text, p, ''),
      fields: p.fields,
      record_key: B.recordKey_(p.fields),
      escalated: esc.escalated,
      track: esc.track,
      to: plan.to,
      cc: plan.cc,
    };
  });
  process.stdout.write(JSON.stringify(out));
});
