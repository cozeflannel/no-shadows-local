#!/usr/bin/env node
/**
 * repo_safety_scan.js — keeps real email addresses, keys, tokens and personal paths out of the repository.
 *
 *   node scripts/repo_safety_scan.js            every file git tracks (and new ones not ignored)
 *   node scripts/repo_safety_scan.js --staged   only the files staged for the next commit (.githooks/pre-commit)
 *
 * Exits 1 and lists each hit as `file:line: what` when it finds:
 *   - an email address that isn't a made-up test one (only the .test and .invalid domains, which can never be
 *     real, and Google Chat's own system address are allowed): the bot's recipients live on the Control sheet
 *     (B30, the Brand safety groups tab), never in a file;
 *   - something shaped like a credential (API key, OAuth client secret or token, private key, webhook URL with its
 *     key): keys live in Secret Manager or the environment, never in a file;
 *   - a personal home directory path (/Users/<name>/..., /home/<name>/...): it names a person.
 * The matched text itself is never printed, only what kind of thing it is.
 *
 * Also run by apps-script-chat-bot/test/run_tests.js, so the test suite fails on any of these. No dependencies.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BINARY = /\.(png|jpe?g|gif|ico|webp|pdf|woff2?|ttf|eot|zip|gz|sqlite|db|pyc)$/i;
const SKIP_DIRS = new Set(['.git', '.venv', '.local', 'node_modules', 'dist', '__pycache__', 'archive', 'knowledge_docs', 'data']);

const EMAIL = /(?<![a-z0-9._%+-])([a-z0-9._%+-]+@([a-z0-9.-]+\.[a-z]{2,}))/gi;
const ALLOWED_EMAILS = new Set(['chat@system.gserviceaccount.com']);
const ALLOWED_EMAIL_ENDINGS = ['.test', '.invalid'];

// The names are built in pieces so this file never matches its own rules.
const CREDENTIALS = [
  ['a Google API key', new RegExp('AI' + 'za[0-9A-Za-z_-]{35}')],
  ['a Google OAuth client secret', new RegExp('GOC' + 'SPX-[0-9A-Za-z_-]{20,}')],
  ['a Google OAuth access token', new RegExp('ya' + '29\\.[0-9A-Za-z_-]{30,}')],
  ['a Google OAuth refresh token', new RegExp('1//' + '0[0-9A-Za-z_-]{40,}')],
  ['a private key', new RegExp('-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE ' + 'KEY-----')],
  ['a service-account key file', new RegExp('"private_key' + '_id"\\s*:\\s*"[0-9a-f]{20,}"')],
  ['a GitHub token', new RegExp('(?:gh[pousr]_[0-9A-Za-z]{36,}|github' + '_pat_[0-9A-Za-z_]{40,})')],
  ['a Slack token', new RegExp('xox' + '[abprs]-[0-9A-Za-z-]{20,}')],
  ['an AWS access key', new RegExp('AK' + 'IA[0-9A-Z]{16}')],
  ['an API secret key', new RegExp('\\bsk-' + '(?:ant-|proj-)?[A-Za-z0-9_-]{32,}')],
  ['a Google Chat webhook with its key', new RegExp('chat\\.googleapis\\.com/v1/spaces/[^\\s"\']+/messages\\?' + 'key=')],
  ['a Zapier webhook', new RegExp('hooks\\.zapier\\.com/hooks/' + 'catch/\\d+/')],
];
const HOME_PATH = new RegExp('(?:/Users/|/home/|[A-Za-z]:\\\\Users\\\\)(?!user\\b|runner\\b|node\\b|app\\b|root\\b)[A-Za-z][A-Za-z0-9._-]{2,}[/\\\\]');

/** True for an email address a file may hold: a made-up test one, or Google Chat's own. */
function emailAllowed(addr) {
  const low = String(addr || '').trim().toLowerCase();
  if (ALLOWED_EMAILS.has(low)) return true;
  const domain = low.slice(low.indexOf('@') + 1);
  return ALLOWED_EMAIL_ENDINGS.some(end => domain.endsWith(end));
}

/** What `text` holds that a file must not: [{line, what}], the matched text left out. */
function scanText(text) {
  const hits = [];
  String(text || '').split('\n').forEach((line, i) => {
    let m;
    EMAIL.lastIndex = 0;
    while ((m = EMAIL.exec(line))) {
      if (!emailAllowed(m[1])) hits.push({ line: i + 1, what: `an email address at ${m[2].toLowerCase()}` });
    }
    CREDENTIALS.forEach(([what, rx]) => { if (rx.test(line)) hits.push({ line: i + 1, what }); });
    if (HOME_PATH.test(line)) hits.push({ line: i + 1, what: 'a personal home directory path' });
  });
  return hits;
}

/** The files to scan, relative to the repository root. */
function listFiles(staged) {
  const args = staged ? ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']
    : ['ls-files', '--cached', '--others', '--exclude-standard', '-z'];
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0')
    .filter(f => f && !BINARY.test(f) && !f.split('/').some(part => SKIP_DIRS.has(part)));
}

/** Scans the repository (or only the staged files): ['file:line: what', ...]. */
function scanRepo(staged) {
  const out = [];
  listFiles(staged).forEach(f => {
    const full = path.join(ROOT, f);
    let text;
    try {
      if (!fs.statSync(full).isFile()) return;
      text = fs.readFileSync(full, 'utf8');
    } catch (e) {
      return;  // deleted in the working tree
    }
    scanText(text).forEach(h => out.push(`${f}:${h.line}: ${h.what}`));
  });
  return out;
}

module.exports = { scanText, scanRepo, emailAllowed, listFiles };

if (require.main === module) {
  const staged = process.argv.includes('--staged');
  const hits = scanRepo(staged);
  if (hits.length) {
    console.error(`repo safety scan: ${hits.length} problem(s) in ${staged ? 'the staged files' : 'the repository'}:`);
    hits.forEach(h => console.error('  ' + h));
    console.error('Email addresses belong on the Control sheet, keys in Secret Manager or the environment. Nothing was committed.');
    process.exit(1);
  }
  console.log(`repo safety scan: clean (${listFiles(staged).length} files)`);
}
