/**
 * bigquery.js — read-only BigQuery queries for the temp-check app (the REST API, no dependencies).
 *
 * Every query is a SELECT with named parameters (values never go into the SQL text), carries a cap on the bytes it may
 * bill (the query fails instead of costing more), and is labelled so its cost can be found later. `estimate` asks
 * BigQuery how much a query would scan without running it (free).
 */
'use strict';

const { PROJECT, gfetch } = require('./gcp');

const BASE = `https://bigquery.googleapis.com/bigquery/v2/projects/${encodeURIComponent(PROJECT)}`;
const GB = 1024 * 1024 * 1024;
const MAX_GB = Math.max(1, Number(process.env.TEMPCHECK_MAX_GB_PER_QUERY) || 20);
const LABELS = { app: 'tempcheck-app' };

/** {name: value} -> BigQuery's named parameters. Strings, whole numbers, Dates (TIMESTAMP) and arrays of strings. Pure. */
function toParams(params) {
  return Object.keys(params || {}).map(name => {
    const v = params[name];
    if (Array.isArray(v)) {
      return { name, parameterType: { type: 'ARRAY', arrayType: { type: 'STRING' } },
        parameterValue: { arrayValues: v.map(x => ({ value: String(x) })) } };
    }
    if (v instanceof Date) return { name, parameterType: { type: 'TIMESTAMP' }, parameterValue: { value: v.toISOString() } };
    if (typeof v === 'number' && Number.isInteger(v)) return { name, parameterType: { type: 'INT64' }, parameterValue: { value: String(v) } };
    return { name, parameterType: { type: 'STRING' }, parameterValue: { value: String(v) } };
  });
}

function assertSelect(sql) {
  const s = String(sql || '').replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').trim();
  if (!/^(?:select|with)\b/i.test(s) || /;\s*\S/.test(s)) throw new Error('only a single SELECT is allowed');
}

/** A result page's rows as objects (flat columns only: every query here selects plain values). Pure. */
function toRows(res) {
  const fields = ((res && res.schema && res.schema.fields) || []);
  return ((res && res.rows) || []).map(r => {
    const out = {};
    fields.forEach((f, i) => {
      const v = (r.f[i] || {}).v;
      if (v === null || v === undefined) out[f.name] = null;
      else if (f.type === 'INTEGER' || f.type === 'INT64' || f.type === 'FLOAT' || f.type === 'FLOAT64' || f.type === 'NUMERIC') out[f.name] = Number(v);
      else if (f.type === 'TIMESTAMP') out[f.name] = Math.round(Number(v) * 1000);  // ms
      else if (f.type === 'BOOLEAN' || f.type === 'BOOL') out[f.name] = v === true || v === 'true';
      else out[f.name] = v;
    });
    return out;
  });
}

function body(q, extra) {
  assertSelect(q.sql);
  return Object.assign({ query: q.sql, useLegacySql: false, location: q.location || 'US', parameterMode: 'NAMED',
    queryParameters: toParams(q.params), labels: LABELS }, extra);
}

/** How many bytes `q` ({sql, params, location}) would scan. Free: nothing runs. */
async function estimate(q) {
  const res = await gfetch(`${BASE}/queries`, { method: 'POST', body: body(q, { dryRun: true }) });
  return Number(res.totalBytesProcessed) || 0;
}

/**
 * Runs `q` ({sql, params, location, maxGb, maxRows}) and returns {rows, bytes, cached}. Fails rather than bill more
 * than maxGb (MAX_GB unless given). Waits up to two minutes.
 */
async function query(q) {
  const cap = Math.round(Math.min(Number(q.maxGb) || MAX_GB, MAX_GB) * GB);
  const until = Date.now() + 120000;
  let res = await gfetch(`${BASE}/queries`, { method: 'POST', timeoutMs: 70000,
    body: body(q, { maximumBytesBilled: String(cap), timeoutMs: 50000, maxResults: Number(q.maxRows) || 5000 }) });
  const job = res.jobReference || {};
  while (!res.jobComplete && job.jobId && Date.now() < until) {
    res = await gfetch(`${BASE}/queries/${encodeURIComponent(job.jobId)}?location=${encodeURIComponent(job.location || q.location || 'US')}` +
      `&timeoutMs=30000&maxResults=${Number(q.maxRows) || 5000}`, { timeoutMs: 50000 });
  }
  if (!res.jobComplete) throw new Error('BigQuery did not finish within two minutes');
  return { rows: toRows(res), bytes: Number(res.totalBytesProcessed) || 0, cached: !!res.cacheHit };
}

module.exports = { estimate, query, toParams, toRows, assertSelect, MAX_GB, GB };
