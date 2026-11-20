/**
 * store.js — where temp checks and the benchmark are kept: plain JSON files in tempcheck-app/data/.
 *
 * That folder is ignored by git (the repository's .gitignore ignores every folder named data), so nothing kept here
 * can be committed by accident. Each temp check is one file (data/checks/<id>.json) with everything gathered for it:
 * the hourly counts, the breakdowns, the posts read, the converted query and the write-up. data/index.json lists them.
 * data/benchmark.json holds one hourly curve per past issue (benchmark.js).
 *
 * A file is written whole to a temporary name and then renamed, so a crash never leaves half a file.
 * This is the test app's store. A BigQuery table can replace it without changing anything above it: the functions
 * here (save, read, list, and the benchmark pair) are all a store needs to offer. No BigQuery table exists for it yet.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = process.env.TEMPCHECK_DATA_DIR || path.join(__dirname, '..', 'data');
const CHECKS = path.join(DIR, 'checks');
const INDEX = path.join(DIR, 'index.json');
const BENCH = path.join(DIR, 'benchmark.json');
const ID_RX = /^tc_\d{14}_[a-f0-9]{6}$/;

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}

function newId(now) {
  const d = new Date(now || Date.now()).toISOString().replace(/\D/g, '').slice(0, 14);
  return `tc_${d}_${crypto.randomBytes(3).toString('hex')}`;
}

/** A temp check's line in the list: enough to show it and pick it, without its posts. */
function summaryOf(rec) {
  return { id: rec.id, at: rec.at, trigger: rec.trigger, issue: rec.issue, title: rec.title, basis: rec.basis,
    queryId: rec.query ? rec.query.id : null, queryName: rec.query ? rec.query.name : '', total: rec.total,
    from: rec.window ? rec.window.from : null, to: rec.window ? rec.window.to : null, why: rec.window ? rec.window.why : '',
    level: rec.level && rec.level.label ? rec.level.label : '', ownPosts: rec.own && rec.own.posts ? rec.own.posts.length : 0,
    ownFrom: rec.own && rec.own.window ? rec.own.window.from : null, updateOf: rec.updateOf || '' };
}

/** Keeps temp check `rec` (giving it an id when it has none) and returns it. */
function save(rec) {
  if (!rec.id) rec.id = newId(rec.at);
  if (!ID_RX.test(rec.id)) throw new Error('not a temp check id');
  writeJson(path.join(CHECKS, `${rec.id}.json`), rec);
  const index = readJson(INDEX, []).filter(x => x && x.id !== rec.id);
  index.push(summaryOf(rec));
  index.sort((a, b) => Number(b.at) - Number(a.at));
  writeJson(INDEX, index);
  return rec;
}

/** Temp check `id`, or null. An id that isn't one (anything with a slash or dots in it) is never read. */
function read(id) {
  if (!ID_RX.test(String(id || ''))) return null;
  return readJson(path.join(CHECKS, `${id}.json`), null);
}

/** Every temp check's summary, newest first. */
function list() { return readJson(INDEX, []); }

function readBenchmark() {
  const b = readJson(BENCH, null);
  return b && b.issues && typeof b.issues === 'object' ? b : { issues: {}, updatedAt: 0 };
}

function writeBenchmark(b) { writeJson(BENCH, b); }

/** Another of the app's own files in the data folder (a plain lowercase name ending .json), or `fallback`. */
function readFile(name, fallback) {
  if (!/^[a-z_]+\.json$/.test(String(name))) throw new Error('not one of the app\'s files');
  return readJson(path.join(DIR, name), fallback);
}

function writeFile(name, value) {
  if (!/^[a-z_]+\.json$/.test(String(name))) throw new Error('not one of the app\'s files');
  writeJson(path.join(DIR, name), value);
}

module.exports = { DIR, ID_RX, newId, save, read, list, summaryOf, readBenchmark, writeBenchmark, readFile, writeFile };
