/**
 * Writes tests/parity/tempcheck_own_sql.json: the five tables of posts the temp check app searches and the SQL its own
 * code (tempcheck-app/lib/owndata.js sqlFor) builds for each of them, for the queries below.
 * tests/test_tempcheck_tables.py reads the same tables from config/temp_check_app.yaml, builds the Console's SQL for
 * the same queries and expects the same statements. Run again after the app's tables or reads change:
 *
 *   node tests/parity/make_tempcheck_own_sql.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const q = require('../../tempcheck-app/lib/bwquery');
const own = require('../../tempcheck-app/lib/owndata');
const bw = require('../../tempcheck-app/lib/brandwatch');

const QUERIES = [
  'gmail AND (outage OR down)',
  '(gmail OR "google mail") NEAR/10 (down OR outage*) NOT giveaway',
  'gmail AND authorFollowers:[1000 TO *]',
  'language:en',
];
const from = Date.parse('2026-11-21T10:00:00Z');
const to = Date.parse('2026-11-22T10:20:00Z');

const tables = own.describe().map(t => ({ key: t.key, label: t.label, what: t.what, table: t.table, location: own.SOURCES[t.key].location,
  has: Array.from(own.SOURCES[t.key].has).sort(), keyBy: own.SOURCES[t.key].keyBy || 'url' }));
const queries = {};
QUERIES.forEach(text => {
  const conv = q.convert(text);
  if (!conv.ok) throw new Error(`${text}: ${conv.error}`);
  queries[text] = {};
  Object.keys(own.SOURCES).forEach(key => {
    const s = own.sqlFor(key, conv.plan, from, to);
    queries[text][key] = s.skip ? { skip: s.skip } : { posts: s.posts, counts: s.counts, location: s.location, removed: s.removed, lim: s.params.lim };
  });
});
const out = { madeBy: 'tests/parity/make_tempcheck_own_sql.js', from, to, order: own.ORDER, rowLimit: own.ROW_LIMIT,
  brandwatchProject: bw.BW_PROJECT, tables, queries };
fs.writeFileSync(path.join(__dirname, 'tempcheck_own_sql.json'), JSON.stringify(out, null, 1) + '\n');
console.log(`wrote ${tables.length} tables, ${QUERIES.length} queries`);
