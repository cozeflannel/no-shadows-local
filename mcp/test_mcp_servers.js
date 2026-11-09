#!/usr/bin/env node
/**
 * test_mcp_servers.js — End-to-end stdio JSON-RPC 2.0 test harness for `slrr-dev-pipeline` and `slrr-live-ops`.
 *
 * Spawns each MCP server as a real child process over stdin/stdout pipes and verifies `initialize`,
 * `tools/list`, and `tools/call`. Pass `--live` to also execute live read-only Google Sheets v4 and
 * Cloud Logging v2 calls against `brand-social-central-data`.
 */
'use strict';

const assert = require('assert');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');

function spawnMcpClient(serverScript) {
  const child = spawn(process.execPath, [serverScript], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let nextId = 1;
  const pending = new Map();
  let stderrBuf = '';

  child.stderr.on('data', chunk => {
    stderrBuf += chunk.toString('utf8');
  });

  const rl = readline.createInterface({ input: child.stdout, terminal: false });
  rl.on('line', line => {
    if (!line.trim()) return;
    const msg = JSON.parse(line);
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) {
        reject(new Error(`RPC error ${msg.error.code}: ${msg.error.message}`));
      } else {
        resolve(msg.result);
      }
    }
  });

  function request(method, params = {}) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  function notify(method, params = {}) {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  async function callTool(name, args = {}) {
    const res = await request('tools/call', { name, arguments: args });
    assert(!res.isError, `Tool ${name} returned error: ${JSON.stringify(res.content)}`);
    return JSON.parse(res.content[0].text);
  }

  function close() {
    child.stdin.end();
    return new Promise(resolve => {
      child.on('exit', () => resolve(stderrBuf));
    });
  }

  return { request, notify, callTool, close };
}

async function main() {
  const runLive = process.argv.includes('--live');

  // 1. Test slrr-dev-pipeline over real stdio
  const devClient = spawnMcpClient(path.join(__dirname, 'slrr_dev_pipeline_server.js'));
  try {
    const init = await devClient.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'mcp-test-client', version: '1.0.0' },
    });
    assert.strictEqual(init.serverInfo.name, 'slrr-dev-pipeline');
    devClient.notify('notifications/initialized');

    const listed = await devClient.request('tools/list');
    assert.strictEqual(listed.tools.length, 5);

    const audit = await devClient.callTool('slrr_audit_safety_invariants');
    assert.strictEqual(audit.all_passed, true, `Safety audit failed: ${JSON.stringify(audit, null, 2)}`);

    const leakBlocked = await devClient.callTool('slrr_test_leak_guard', {
      text: 'The bot copied this into the Mirror space from the outbox tab.',
      emoji: '👎',
    });
    assert.strictEqual(leakBlocked.text_check.allowed_to_burson, false);
    assert(leakBlocked.text_check.outbox_guard_hits.length >= 2);
    assert.strictEqual(leakBlocked.emoji_check.allowed_to_burson, false);

    const leakClean = await devClient.callTool('slrr_test_leak_guard', {
      text: 'Hi team — could you please share the direct link to the post? Thank you!',
      emoji: '👍',
    });
    assert.strictEqual(leakClean.text_check.allowed_to_burson, true);
    assert.strictEqual(leakClean.emoji_check.allowed_to_burson, true);

    const sampleAlert = [
      'THIS ALERT MEETS P2 CRITERIA',
      '',
      '🟨SOCIAL ALERT🟨: Gems | Criticism against AI Overviews | Instagram | 29425 Engagements',
      '[Name]: Criticism against AI Overviews / Ongoing Issue',
      '[Engagement]: LOW (29425 engagements)',
      '[Product]: Gems',
      '[Social Network]: Instagram',
      '[Exposure Tag]: Product - Perceived bias',
      '[Sensitive Topic]: -',
      '[KOF]: No',
      '',
      'X user edervolcelazz (195 followers) shared a post featuring an AI Overview with an offensive reply.',
      '',
      '[Link]: https://x.com/edervolcelazz/status/2109566527900926417',
      '[Time/Date Post Went Live]: October 12, 2026, 1:47 AM',
      '[Code]: Product - Perceived bias,29425,edervolcelazz,-,Gems,Ongoing Issue',
    ].join('\n');

    const preview = await devClient.callTool('slrr_preview_alert_triage', { alert_text: sampleAlert });
    assert.strictEqual(preview.detected, true);
    assert(preview.fixes.length > 0, 'Expected deterministic fixes on mismatched Gems/Instagram sample alert');

    console.log('✓ slrr-dev-pipeline passed all stdio protocol & VM tool assertions');
  } finally {
    await devClient.close();
  }

  // 2. Test slrr-live-ops protocol + optional live GCP execution
  const opsClient = spawnMcpClient(path.join(__dirname, 'slrr_live_ops_server.js'));
  try {
    const init = await opsClient.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'mcp-test-client', version: '1.0.0' },
    });
    assert.strictEqual(init.serverInfo.name, 'slrr-live-ops');
    opsClient.notify('notifications/initialized');

    const listed = await opsClient.request('tools/list');
    assert.strictEqual(listed.tools.length, 5);
    console.log('✓ slrr-live-ops passed stdio initialization & tool schema listing');

    if (runLive) {
      const control = await opsClient.callTool('slrr_get_control_status');
      assert.strictEqual(control.safety_audit.lookback_dropdown_strict_15m, true);
      assert.strictEqual(control.safety_audit.write_back_bq_is_off, true);
      console.log(
        `✓ slrr_get_control_status (LIVE): Bot=${control.bot.enabled} | Last check=${control.bot.last_check} | Tabs=${control.tabs.length} | B31=${control.bigquery_lookback.configured}`
      );

      const logs = await opsClient.callTool('slrr_read_logs', { minutes_back: 180, limit: 10 });
      console.log(`✓ slrr_read_logs (LIVE): returned ${logs.returned_count} log entries (severities=${JSON.stringify(logs.severity_counts)})`);

      const kb = await opsClient.callTool('slrr_inspect_knowledge_and_guidance');
      console.log(
        `✓ slrr_inspect_knowledge_and_guidance (LIVE): ${kb.resources.healthy_docs}/${kb.resources.total_docs} healthy docs, ${kb.guidance.total_rules} guidance rules`
      );

      const relay = await opsClient.callTool('slrr_inspect_relay_and_outbox', { limit: 10 });
      console.log(
        `✓ slrr_inspect_relay_and_outbox (LIVE): present_tabs=${JSON.stringify(relay.present_tabs)}, outbox_rows=${relay.burson_outbox.total_rows}, relay_rows=${relay.relay.total_rows}, unmapped_people=${relay.relay_names.unmapped_count}`
      );
    }
  } finally {
    await opsClient.close();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
