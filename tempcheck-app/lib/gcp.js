/**
 * gcp.js — Google sign-in for the temp-check app, with no key files and no dependencies.
 *
 * The app has no credentials of its own. It runs as whoever starts it:
 *   1. on a laptop, the login made by `gcloud auth application-default login` (its refresh token is read from gcloud's
 *      own file and exchanged for a one-hour access token);
 *   2. on Cloud Run or another Google host, the service account the host runs as (the metadata server);
 *   3. else `gcloud auth application-default print-access-token`.
 * Access tokens are kept in memory only, never logged and never written to disk.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const PROJECT = process.env.TEMPCHECK_GCP_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || 'brand-social-central-data';

let cached = { token: '', until: 0 };

function adcPath() {
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) return process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (process.platform === 'win32') return path.join(process.env.APPDATA || '', 'gcloud', 'application_default_credentials.json');
  return path.join(os.homedir(), '.config', 'gcloud', 'application_default_credentials.json');
}

/**
 * An access token from a user login file (the kind `gcloud auth application-default login` writes): {token, ms (how
 * long it lasts)}. `file`: the file's path. The token is not kept here.
 */
async function fromLoginFile(file) {
  const creds = JSON.parse(await fs.promises.readFile(file, 'utf8'));
  if (!creds || creds.type !== 'authorized_user' || !creds.refresh_token) {
    throw new Error('the gcloud login file is not a user login (key files are not supported)');
  }
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: creds.client_id, client_secret: creds.client_secret,
      refresh_token: creds.refresh_token, grant_type: 'refresh_token' }).toString(),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.access_token) throw new Error(`Google refused the login (HTTP ${resp.status})`);
  return { token: data.access_token, ms: (Number(data.expires_in) || 3600) * 1000 };
}

function fromAdcFile() { return fromLoginFile(adcPath()); }

async function fromMetadata() {
  const resp = await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', {
    headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(1500),
  });
  const data = await resp.json();
  if (!resp.ok || !data.access_token) throw new Error('no metadata server token');
  return { token: data.access_token, ms: (Number(data.expires_in) || 3600) * 1000 };
}

function fromGcloud() {
  return new Promise((resolve, reject) => {
    execFile('gcloud', ['auth', 'application-default', 'print-access-token'], { timeout: 15000 }, (err, stdout) => {
      const token = String(stdout || '').trim();
      if (err || !token) return reject(new Error('gcloud gave no token'));
      resolve({ token, ms: 45 * 60 * 1000 });
    });
  });
}

/** A Google access token for whoever runs the app. Throws with what to do when there is no login. */
async function accessToken(force) {
  if (!force && cached.token && Date.now() < cached.until - 5 * 60 * 1000) return cached.token;
  const ways = [fromAdcFile, fromMetadata, fromGcloud];
  for (let i = 0; i < ways.length; i++) {
    try {
      const got = await ways[i]();
      cached = { token: got.token, until: Date.now() + got.ms };
      return cached.token;
    } catch (e) { /* the next way */ }
  }
  throw new Error('No Google login found. Run `gcloud auth application-default login` and start the app again.');
}

/**
 * One call to a Google API, as JSON. opts: {method, body, timeoutMs}. Billed to PROJECT. A 401 is tried once more with
 * a fresh token. Throws an Error with `.status` and Google's own message for anything but a 2xx.
 */
async function gfetch(url, opts) {
  const o = opts || {};
  const method = String(o.method || 'GET').toUpperCase();
  const once = async force => {
    const token = await accessToken(force);
    const headers = { Authorization: `Bearer ${token}`, 'x-goog-user-project': PROJECT };
    if (o.body !== undefined) headers['Content-Type'] = 'application/json';
    return fetch(url, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body),
      signal: AbortSignal.timeout(Number(o.timeoutMs) || 60000) });
  };
  let resp = await once(false);
  if (resp.status === 401) resp = await once(true);
  const text = await resp.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch (e) { json = {}; }
  if (!resp.ok) {
    const why = (json && json.error && json.error.message) || text.slice(0, 300);
    const err = new Error(`Google HTTP ${resp.status}: ${String(why).replace(/\s+/g, ' ').trim()}`);
    err.status = resp.status;
    throw err;
  }
  return json;
}

module.exports = { PROJECT, accessToken, gfetch, fromLoginFile };
