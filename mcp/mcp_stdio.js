#!/usr/bin/env node
/**
 * mcp_stdio.js — Zero-dependency Model Context Protocol (MCP) JSON-RPC 2.0 Stdio Server & GCP ADC Helper.
 *
 * Implements newline-delimited JSON-RPC 2.0 stdio transport compliant with MCP protocol versions
 * `2024-11-05` and `2025-03-26`, plus cached Google Cloud Application Default Credentials (ADC)
 * token refresh with automatic `x-goog-user-project` attribution for `brand-social-central-data`, and the read-only
 * Google Sheets helpers both servers share (workbook metadata, values, and the newest rows of the bot's append-only tabs).
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { execFileSync } = require('child_process');

const DEFAULT_GCP_PROJECT = process.env.GOOGLE_CLOUD_PROJECT || 'brand-social-central-data';
const DEFAULT_STORE_SHEET_ID = process.env.SLRR_STORE_SHEET_ID || '1dVGeQjLOfEYoCm_iIOmXd5hLM3rOTY_71IF-J8Hl2AI';
const DEFAULT_SCRIPT_ID = process.env.SLRR_SCRIPT_ID || '19HakS6-o8U1qT99Xpnw2TQbJnZMx5FZz_JzVDd93Yd9gopQ9qXaWnGk3';
const DEFAULT_LOGGING_PROJECT_KEY = process.env.SLRR_LOGGING_PROJECT_KEY || 'MT90an4vYnIDfrbDRi1jgSZANzck4hlvJ';

let cachedToken = '';
let cachedTokenExpiresAt = 0;

function adcCredentialsPath() {
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    return process.env.GOOGLE_APPLICATION_CREDENTIALS;
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || '', 'gcloud', 'application_default_credentials.json');
  }
  return path.join(os.homedir(), '.config', 'gcloud', 'application_default_credentials.json');
}

async function refreshAdcTokenDirect() {
  const credPath = adcCredentialsPath();
  const raw = await fs.promises.readFile(credPath, 'utf8');
  const creds = JSON.parse(raw);
  if (!creds || creds.type !== 'authorized_user' || !creds.refresh_token || !creds.client_id || !creds.client_secret) {
    throw new Error('ADC file is not an authorized_user OAuth credential');
  }
  const body = new URLSearchParams({
    client_id: creds.client_id,
    client_secret: creds.client_secret,
    refresh_token: creds.refresh_token,
    grant_type: 'refresh_token',
  }).toString();

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`OAuth token refresh failed (${resp.status}): ${errText}`);
  }
  const data = await resp.json();
  if (!data.access_token) {
    throw new Error('OAuth token response missing access_token');
  }
  return {
    token: data.access_token,
    expiresInMs: (Number(data.expires_in) || 3600) * 1000,
  };
}

async function getAccessToken(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedToken && now < cachedTokenExpiresAt - 5 * 60 * 1000) {
    return cachedToken;
  }
  try {
    const refreshed = await refreshAdcTokenDirect();
    cachedToken = refreshed.token;
    cachedTokenExpiresAt = now + refreshed.expiresInMs;
    return cachedToken;
  } catch (_directErr) {
    const cliToken = execFileSync('gcloud', ['auth', 'application-default', 'print-access-token'], {
      encoding: 'utf8',
      timeout: 15000,
    }).trim();
    if (!cliToken) {
      throw new Error('Unable to obtain GCP access token. Run `gcloud auth application-default login`.');
    }
    cachedToken = cliToken;
    cachedTokenExpiresAt = now + 45 * 60 * 1000;
    return cachedToken;
  }
}

async function gcpFetchJson(url, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  const quotaProject = options.quotaProject || DEFAULT_GCP_PROJECT;
  const makeHeaders = token => {
    const h = Object.assign(
      {
        Authorization: `Bearer ${token}`,
        'x-goog-user-project': quotaProject,
      },
      options.headers || {}
    );
    if (options.body !== undefined && !h['Content-Type']) {
      h['Content-Type'] = 'application/json';
    }
    return h;
  };

  let token = await getAccessToken(false);
  let resp = await fetch(url, {
    method,
    headers: makeHeaders(token),
    body: options.body !== undefined ? (typeof options.body === 'string' ? options.body : JSON.stringify(options.body)) : undefined,
  });

  if (resp.status === 401) {
    token = await getAccessToken(true);
    resp = await fetch(url, {
      method,
      headers: makeHeaders(token),
      body: options.body !== undefined ? (typeof options.body === 'string' ? options.body : JSON.stringify(options.body)) : undefined,
    });
  }

  const text = await resp.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch (_e) {
    parsed = { raw: text };
  }
  if (!resp.ok) {
    const msg = (parsed && parsed.error && parsed.error.message) || text.slice(0, 500);
    const err = new Error(`GCP HTTP ${resp.status} (${method} ${url}): ${msg}`);
    err.status = resp.status;
    err.payload = parsed;
    throw err;
  }
  return parsed;
}

// ---------------------------------------------------------------------------------------------------------------
// Google Sheets, read-only: workbook metadata, values, and the newest rows of tabs the bot appends to.
// `fetchJson` is gcpFetchJson unless a caller passes its own (the tests pass canned responses).
// ---------------------------------------------------------------------------------------------------------------

const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

/** The workbook's title and each tab's properties (title, hidden, the grid's row and column counts); no cell values. */
async function getWorkbookMetadata(sheetId, fetchJson = gcpFetchJson) {
  const url = `${SHEETS_BASE}/${encodeURIComponent(sheetId)}?fields=properties.title,sheets(properties(sheetId,title,index,hidden,gridProperties(rowCount,columnCount)))`;
  return fetchJson(url);
}

/** The formatted values of `ranges` (A1 notation), in the order asked: {valueRanges: [{values}]}. */
async function batchGetValues(sheetId, ranges, fetchJson = gcpFetchJson) {
  const params = ranges.map(r => `ranges=${encodeURIComponent(r)}`).join('&');
  const url = `${SHEETS_BASE}/${encodeURIComponent(sheetId)}/values:batchGet?valueRenderOption=FORMATTED_VALUE&${params}`;
  return fetchJson(url);
}

/** How many rows of `rows` there are up to its last row with a non-empty cell (0 when every row is blank). */
function filledRowCount(rows) {
  for (let i = (rows || []).length - 1; i >= 0; i--) {
    if ((rows[i] || []).some(c => String(c === undefined || c === null ? '' : c).trim() !== '')) return i + 1;
  }
  return 0;
}

/** `rows` as exactly `count` rows: cut, or filled out with blank rows (the API leaves a range's last blank rows out). */
function exactRowCount(rows, count) {
  const out = (rows || []).slice(0, count);
  while (out.length < count) out.push([]);
  return out;
}

function tabRange(tab, firstCol, lastCol, fromRow, toRow) {
  return `'${String(tab).replace(/'/g, "''")}'!${firstCol}${fromRow}:${lastCol}${toRow}`;
}

/**
 * The newest rows of tabs the bot appends to at the bottom (Alert log, Relay, Burson outbox, Watch detections). A fixed
 * range from the top ('Alert log'!A1:AP2000) stops seeing new rows once the tab outgrows it. This reads each tab's first
 * `topRows` rows (its title and header) and its newest `maxRows` rows below them, found with the grid's row count in the
 * workbook metadata (`meta`: getWorkbookMetadata).
 *
 * specs: [{tab, lastCol, topRows, maxRows}], each tab one that exists. Returns {[tab]: {top, rows, firstRow, lastRow,
 * gridRows, truncated, rowsNotRead, fromTop}}:
 *   top          the first topRows rows, as read
 *   rows         the data rows read, oldest first: rows[i] is sheet row firstRow + i (lastRow: the last of them)
 *   truncated    true when rows between the top block and firstRow were left unread (rowsNotRead of them)
 *   fromTop      true only when the metadata has no row count for the tab: then its FIRST rows were read, as before
 *
 * A grid can end in blank rows (a new tab has 1,000 rows), so the grid's last `maxRows` rows aren't always the last rows
 * with data. When that window comes back short, the rows above it are read too; when it comes back blank, column A below
 * the top block is read to find the last row with data (each of these tabs has a value in column A on every row), then
 * the rows up to it. Three batchGet calls at most, for all the tabs together.
 */
async function readTabTails(sheetId, meta, specs, fetchJson = gcpFetchJson) {
  const gridRowsOf = {};
  ((meta && meta.sheets) || []).forEach(s => {
    const p = (s && s.properties) || {};
    gridRowsOf[p.title] = Number(p.gridProperties && p.gridProperties.rowCount) || 0;
  });
  const get = async ranges => {
    if (!ranges.length) return [];
    const batch = await batchGetValues(sheetId, ranges, fetchJson);
    return ranges.map((_r, i) => (((batch && batch.valueRanges) || [])[i] || {}).values || []);
  };

  // 1. A tab that fits is read whole; of the others, the top block and the grid's last maxRows rows
  const first = [];
  const tabs = (specs || []).map(spec => {
    const topRows = Math.max(0, Math.floor(Number(spec.topRows) || 0));
    const maxRows = Math.max(1, Math.floor(Number(spec.maxRows) || 1));
    const known = gridRowsOf[spec.tab] > 0;
    const gridRows = known ? gridRowsOf[spec.tab] : topRows + maxRows;
    const t = { spec, topRows, maxRows, known, gridRows, whole: gridRows <= topRows + maxRows };
    if (t.whole) {
      t.iWhole = first.push(tabRange(spec.tab, 'A', spec.lastCol, 1, gridRows)) - 1;
    } else {
      t.start = gridRows - maxRows + 1;
      if (topRows) t.iTop = first.push(tabRange(spec.tab, 'A', spec.lastCol, 1, topRows)) - 1;
      t.iTail = first.push(tabRange(spec.tab, 'A', spec.lastCol, t.start, gridRows)) - 1;
    }
    return t;
  });
  const got1 = await get(first);

  // 2. A window that came back short: the rows above it. One that came back blank: where column A ends
  const second = [];
  tabs.forEach(t => {
    if (t.whole) {
      const all = got1[t.iWhole];
      t.top = all.slice(0, t.topRows);
      t.rows = all.slice(t.topRows);
      t.firstRow = t.topRows + 1;
      return;
    }
    t.top = t.iTop === undefined ? [] : got1[t.iTop];
    const tail = got1[t.iTail];
    const filled = filledRowCount(tail);
    if (filled >= t.maxRows) {
      t.rows = tail;
      t.firstRow = t.start;
    } else if (filled > 0) {
      t.tail = tail.slice(0, filled);
      t.from = Math.max(t.topRows + 1, t.start - (t.maxRows - filled));
      t.iAbove = second.push(tabRange(t.spec.tab, 'A', t.spec.lastCol, t.from, t.start - 1)) - 1;
    } else {
      t.iProbe = second.push(tabRange(t.spec.tab, 'A', 'A', t.topRows + 1, t.start - 1)) - 1;
    }
  });
  const got2 = await get(second);

  // 3. The rows up to the last row with data, for the tabs whose window was blank
  const third = [];
  tabs.forEach(t => {
    if (t.iAbove !== undefined) {
      t.rows = exactRowCount(got2[t.iAbove], t.start - t.from).concat(t.tail);
      t.firstRow = t.from;
    } else if (t.iProbe !== undefined) {
      const dataRows = filledRowCount(got2[t.iProbe]);
      t.firstRow = Math.max(t.topRows + 1, t.topRows + dataRows - t.maxRows + 1);
      if (dataRows > 0) {
        t.iLate = third.push(tabRange(t.spec.tab, 'A', t.spec.lastCol, t.firstRow, t.topRows + dataRows)) - 1;
      } else {
        t.rows = [];
      }
    }
  });
  const got3 = await get(third);

  const out = {};
  tabs.forEach(t => {
    if (t.iLate !== undefined) t.rows = got3[t.iLate];
    const rows = (t.rows || []).slice(0, filledRowCount(t.rows));
    const rowsNotRead = Math.max(0, t.firstRow - (t.topRows + 1));
    out[t.spec.tab] = {
      top: t.top,
      rows,
      firstRow: t.firstRow,
      lastRow: t.firstRow + rows.length - 1,
      gridRows: t.known ? t.gridRows : null,
      // no row count: the first rows were read, and a full range may well have cut the tab short
      truncated: t.known ? rowsNotRead > 0 : rows.length >= t.maxRows,
      rowsNotRead,
      fromTop: !t.known,
    };
  });
  return out;
}

/**
 * What a readTabTails read covered, for a tool's output: {grid_rows, first_row_read, last_row_read, rows_read,
 * truncated}, with a `note` in words when rows were left unread, so nobody takes "no match" for "not on the tab".
 */
function tailReadSummary(tab, t) {
  const summary = {
    grid_rows: t.gridRows,
    first_row_read: t.rows.length ? t.firstRow : null,
    last_row_read: t.rows.length ? t.lastRow : null,
    rows_read: t.rows.length,
    truncated: !!t.truncated,
  };
  if (t.truncated) {
    summary.note = t.fromTop
      ? `"${tab}": its size isn't in the workbook metadata, so only its first ${t.rows.length} rows were read; newer rows may be missing.`
      : `"${tab}": only its newest ${t.rows.length} rows were read (sheet rows ${t.firstRow}-${t.lastRow}); ${t.rowsNotRead} older rows were not.`;
  }
  return summary;
}

function sendJsonRpc(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function createMcpStdioServer({ name, version, instructions, tools }) {
  const toolMap = new Map();
  for (const t of tools) {
    toolMap.set(t.name, t);
  }

  async function handleMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    const isNotification = msg.id === undefined;
    const id = msg.id ?? null;

    if (isNotification) {
      return;
    }

    try {
      switch (msg.method) {
        case 'initialize': {
          const clientVersion = (msg.params && msg.params.protocolVersion) || '2024-11-05';
          const supported = ['2024-11-05', '2025-03-26'];
          const negotiated = supported.includes(clientVersion) ? clientVersion : '2024-11-05';
          const result = {
            protocolVersion: negotiated,
            capabilities: {
              tools: { listChanged: false },
            },
            serverInfo: {
              name,
              version: version || '1.0.0',
            },
          };
          if (instructions) {
            result.instructions = instructions;
          }
          sendJsonRpc({ jsonrpc: '2.0', id, result });
          return;
        }

        case 'ping': {
          sendJsonRpc({ jsonrpc: '2.0', id, result: {} });
          return;
        }

        case 'tools/list': {
          const list = tools.map(t => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema || { type: 'object', properties: {} },
          }));
          sendJsonRpc({ jsonrpc: '2.0', id, result: { tools: list } });
          return;
        }

        case 'resources/list': {
          sendJsonRpc({ jsonrpc: '2.0', id, result: { resources: [] } });
          return;
        }

        case 'resources/templates/list': {
          sendJsonRpc({ jsonrpc: '2.0', id, result: { resourceTemplates: [] } });
          return;
        }

        case 'prompts/list': {
          sendJsonRpc({ jsonrpc: '2.0', id, result: { prompts: [] } });
          return;
        }

        case 'tools/call': {
          const toolName = msg.params && msg.params.name;
          const args = (msg.params && msg.params.arguments) || {};
          const tool = toolMap.get(toolName);
          if (!tool) {
            sendJsonRpc({
              jsonrpc: '2.0',
              id,
              error: { code: -32602, message: `Unknown tool: ${toolName}` },
            });
            return;
          }
          try {
            const output = await tool.handler(args);
            const text = typeof output === 'string' ? output : JSON.stringify(output, null, 2);
            sendJsonRpc({
              jsonrpc: '2.0',
              id,
              result: {
                content: [{ type: 'text', text }],
                isError: false,
              },
            });
          } catch (toolErr) {
            const errMsg = toolErr instanceof Error ? `${toolErr.message}` : String(toolErr);
            sendJsonRpc({
              jsonrpc: '2.0',
              id,
              result: {
                content: [{ type: 'text', text: JSON.stringify({ error: errMsg }, null, 2) }],
                isError: true,
              },
            });
          }
          return;
        }

        default: {
          sendJsonRpc({
            jsonrpc: '2.0',
            id,
            error: { code: -32601, message: `Method not found: ${msg.method}` },
          });
        }
      }
    } catch (err) {
      sendJsonRpc({
        jsonrpc: '2.0',
        id,
        error: {
          code: -32603,
          message: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }

  function start() {
    const rl = readline.createInterface({
      input: process.stdin,
      terminal: false,
    });
    rl.on('line', line => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch (e) {
        sendJsonRpc({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: `Parse error: ${e.message}` },
        });
        return;
      }
      handleMessage(parsed);
    });
    rl.on('close', () => {
      process.exit(0);
    });
  }

  return { start, handleMessage };
}

module.exports = {
  DEFAULT_GCP_PROJECT,
  DEFAULT_STORE_SHEET_ID,
  DEFAULT_SCRIPT_ID,
  DEFAULT_LOGGING_PROJECT_KEY,
  getAccessToken,
  gcpFetchJson,
  getWorkbookMetadata,
  batchGetValues,
  readTabTails,
  tailReadSummary,
  createMcpStdioServer,
};
