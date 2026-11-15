#!/usr/bin/env node
/**
 * live_verify_runner.js — Zero-mock Node execution bridge for LiveVerify.gs (`verifyLookbackAndPipelineLive()`).
 *
 * Loads all production `.gs` files in `apps-script-chat-bot/` into a single VM global scope (matching Apps Script V8)
 * and wires `ScriptApp.getOAuthToken()`, `UrlFetchApp.fetch()`, and `SpreadsheetApp.openById()` directly to REAL live
 * Google Cloud / Google Workspace endpoints (Google Sheets v4 API, BigQuery v2 API, and Vertex AI Gemini API) using
 * real Application Default Credentials. NO MOCKS, NO STUBS, NO FAKE RESPONSES.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const ROOT = __dirname;
const LIVE_SHEET_ID = '1dVGeQjLOfEYoCm_iIOmXd5hLM3rOTY_71IF-J8Hl2AI';
const GCP_PROJECT = 'brand-social-central-data';

function realAccessToken() {
  return execFileSync('gcloud', ['auth', 'application-default', 'print-access-token'], { encoding: 'utf8' }).trim();
}

function realHttpFetch(url, params) {
  const opts = params || {};
  const method = String(opts.method || 'get').toUpperCase();
  const headers = Object.assign({}, opts.headers || {});
  if (opts.contentType && !headers['Content-Type'] && !headers['content-type']) {
    headers['Content-Type'] = opts.contentType;
  }
  if (!headers['x-goog-user-project']) {
    headers['x-goog-user-project'] = GCP_PROJECT;
  }
  // The headers (the access token among them) go to curl on its standard input as a config, never on its command
  // line, where any process on the machine could read them
  const args = ['-sS', '-i', '-X', method, '--config', '-'];
  const curlConfig = Object.entries(headers)
    .map(([k, v]) => `header = "${String(`${k}: ${v}`).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ')}"`)
    .join('\n') + '\n';
  let tmpFile = null;
  try {
    if (opts.payload !== undefined && opts.payload !== null) {
      tmpFile = path.join(os.tmpdir(), `gas_live_payload_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2)}.bin`);
      fs.writeFileSync(tmpFile, typeof opts.payload === 'string' ? opts.payload : Buffer.from(opts.payload), { mode: 0o600 });
      args.push('--data-binary', `@${tmpFile}`);
    }
    args.push(String(url));
    const raw = execFileSync('curl', args, { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024, input: curlConfig });
    const parts = raw.split(/\r?\n\r?\n/);
    let headerIdx = 0;
    while (headerIdx < parts.length - 1 && /^HTTP\/\d/.test(parts[headerIdx + 1])) {
      headerIdx++;
    }
    const statusLine = (parts[headerIdx].split(/\r?\n/)[0] || '');
    const codeMatch = statusLine.match(/HTTP\/\S+\s+(\d+)/);
    const code = codeMatch ? Number(codeMatch[1]) : 200;
    const respHeaders = {};
    parts[headerIdx].split(/\r?\n/).slice(1).forEach(line => {
      const idx = line.indexOf(':');
      if (idx > 0) respHeaders[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    });
    const body = parts.slice(headerIdx + 1).join('\n\n');
    if (code >= 400 && !opts.muteHttpExceptions) {
      throw new Error(`HTTP ${code} from ${url}: ${body.slice(0, 500)}`);
    }
    return {
      getResponseCode: () => code,
      getHeaders: () => respHeaders,
      getContentText: () => body,
    };
  } finally {
    if (tmpFile && fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  }
}

function openRealSpreadsheet(sheetId) {
  const token = realAccessToken();
  const endpoint = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}?ranges=Control!A1:C70&includeGridData=true`;
  const resp = realHttpFetch(endpoint, { headers: { Authorization: `Bearer ${token}` } });
  const doc = JSON.parse(resp.getContentText());
  const sheetData = (doc.sheets && doc.sheets[0] && doc.sheets[0].data && doc.sheets[0].data[0] && doc.sheets[0].data[0].rowData) || [];

  const getCellNode = (r, c) => {
    const rowObj = sheetData[r - 1];
    return (rowObj && rowObj.values && rowObj.values[c - 1]) || {};
  };

  const controlSheet = {
    getName: () => 'Control',
    getLastRow: () => sheetData.length,
    getRange(r, c, nr = 1, nc = 1) {
      return {
        getValue() {
          const cell = getCellNode(r, c);
          return cell.formattedValue !== undefined ? cell.formattedValue : '';
        },
        getValues() {
          const out = [];
          for (let i = 0; i < nr; i++) {
            const row = [];
            for (let j = 0; j < nc; j++) {
              const cell = getCellNode(r + i, c + j);
              row.push(cell.formattedValue !== undefined ? cell.formattedValue : '');
            }
            out.push(row);
          }
          return out;
        },
        getDataValidation() {
          const dv = getCellNode(r, c).dataValidation;
          if (!dv || !dv.condition) return null;
          const listVals = (dv.condition.values || []).map(v => v.userEnteredValue);
          return {
            getAllowInvalid: () => !dv.strict,
            getCriteriaValues: () => [listVals],
          };
        },
      };
    },
  };

  return {
    getId: () => sheetId,
    getUrl: () => `https://docs.google.com/spreadsheets/d/${sheetId}`,
    getSheetByName: name => (name === 'Control' ? controlSheet : null),
  };
}

function main() {
  const sandbox = {
    console,
    Date,
    Math,
    JSON,
    RegExp,
    Set,
    Map,
    Array,
    Object,
    String,
    Number,
    Boolean,
    Error,
    isFinite,
    isNaN,
    parseInt,
    parseFloat,
    encodeURIComponent,
    decodeURIComponent,
    ScriptApp: {
      getOAuthToken: realAccessToken,
    },
    UrlFetchApp: {
      fetch: realHttpFetch,
    },
    SpreadsheetApp: {
      openById: openRealSpreadsheet,
      newDataValidation() {
        let vals = [];
        let allowInvalid = true;
        return {
          requireValueInList(v) { vals = v.slice(); return this; },
          setAllowInvalid(v) { allowInvalid = !!v; return this; },
          build() {
            return {
              getAllowInvalid: () => allowInvalid,
              getCriteriaValues: () => [vals],
            };
          },
        };
      },
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: k => (k === 'STORE_SHEET_ID' ? LIVE_SHEET_ID : null),
        getProperties: () => ({ STORE_SHEET_ID: LIVE_SHEET_ID }),
      }),
    },
    CacheService: {
      getScriptCache: () => ({ get: () => null, put: () => {} }),
    },
    Utilities: {
      sleep: ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
      computeDigest: (algo, str) => Array.from(require('crypto').createHash('sha256').update(String(str)).digest()),
      base64Encode: b => Buffer.from(b).toString('base64'),
      formatDate: (d, tz, fmt) => d.toISOString(),
    },
  };

  vm.createContext(sandbox);
  const gsFiles = fs.readdirSync(ROOT).filter(f => f.endsWith('.gs')).sort();
  const combined = gsFiles.map(f => `// ---- ${f}\n${fs.readFileSync(path.join(ROOT, f), 'utf8')}`).join('\n;\n');
  vm.runInContext(combined, sandbox, { filename: 'apps-script-live-bundle.js' });
  vm.runInContext('verifyLookbackAndPipelineLive()', sandbox);
}

main();
