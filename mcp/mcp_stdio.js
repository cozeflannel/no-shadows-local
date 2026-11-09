#!/usr/bin/env node
/**
 * mcp_stdio.js — Zero-dependency Model Context Protocol (MCP) JSON-RPC 2.0 Stdio Server & GCP ADC Helper.
 *
 * Implements newline-delimited JSON-RPC 2.0 stdio transport compliant with MCP protocol versions
 * `2024-11-05` and `2025-03-26`, plus cached Google Cloud Application Default Credentials (ADC)
 * token refresh with automatic `x-goog-user-project` attribution for `brand-social-central-data`.
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
  createMcpStdioServer,
};
