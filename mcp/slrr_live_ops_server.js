#!/usr/bin/env node
/**
 * slrr_live_ops_server.js — Read-only Live Operations & Diagnostics MCP Server for Burson QA Bot (SLRR).
 *
 * Exposes structured, read-only MCP tools over:
 *   1. Live Control Google Sheet (`1dVGeQjLOfEYoCm_iIOmXd5hLM3rOTY_71IF-J8Hl2AI`):
 *      - `slrr_get_control_status`: Bot state, space bindings, all 17 switches, B30 testers, B31 lookback validation, safety checks
 *      - `slrr_inspect_relay_and_outbox`: `Burson outbox`, `Relay`, and `Relay names` (flags unmapped Chat users & pending/blocked items)
 *      - `slrr_inspect_parity_and_results`: `Results` and `Learned precedents` tabs (`im_only` / `bot_only` disagreements & KPIs)
 *      - `slrr_inspect_knowledge_and_guidance`: `Resources` and `Guidance` tabs (doc read health, visibility flags, active guidance)
 *   2. Google Cloud Logging v2 (`brand-social-central-data`, scoped strictly to `project_key="MT90an4vYnIDfrbDRi1jgSZANzck4hlvJ"`):
 *      - `slrr_read_logs`: Filtered runtime logs, crash/hold diagnostics, and full single-run `process_id` execution traces
 *
 * SAFETY INVARIANT: Strictly read-only. Never writes to Google Sheets, BigQuery, Gmail, or Google Chat.
 */
'use strict';

const {
  DEFAULT_GCP_PROJECT,
  DEFAULT_STORE_SHEET_ID,
  DEFAULT_LOGGING_PROJECT_KEY,
  gcpFetchJson,
  createMcpStdioServer,
} = require('./mcp_stdio');

const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';
const LOGGING_ENTRIES_URL = 'https://logging.googleapis.com/v2/entries:list';

async function getWorkbookMetadata(sheetId) {
  const url = `${SHEETS_BASE}/${encodeURIComponent(sheetId)}?fields=properties.title,sheets(properties(sheetId,title,index,hidden,gridProperties(rowCount,columnCount)))`;
  return gcpFetchJson(url);
}

async function batchGetValues(sheetId, ranges) {
  const params = ranges.map(r => `ranges=${encodeURIComponent(r)}`).join('&');
  const url = `${SHEETS_BASE}/${encodeURIComponent(sheetId)}/values:batchGet?valueRenderOption=FORMATTED_VALUE&${params}`;
  return gcpFetchJson(url);
}

function rowsToObjects(rows) {
  if (!Array.isArray(rows) || rows.length < 2) return [];
  const header = rows[0].map((h, idx) => String(h || `col_${idx + 1}`).trim());
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] || [];
    if (r.every(cell => !String(cell || '').trim())) continue;
    const obj = { _row: i + 1 };
    header.forEach((col, j) => {
      obj[col] = r[j] !== undefined ? String(r[j]) : '';
    });
    out.push(obj);
  }
  return out;
}

async function handleGetControlStatus(args) {
  const sheetId = args.sheet_id || DEFAULT_STORE_SHEET_ID;
  const meta = await getWorkbookMetadata(sheetId);
  const tabs = ((meta && meta.sheets) || []).map(s => ({
    title: s.properties.title,
    hidden: !!s.properties.hidden,
    rows: s.properties.gridProperties && s.properties.gridProperties.rowCount,
    cols: s.properties.gridProperties && s.properties.gridProperties.columnCount,
  }));

  const gridUrl = `${SHEETS_BASE}/${encodeURIComponent(sheetId)}?ranges=${encodeURIComponent('Control!A1:C37')}&includeGridData=true`;
  const gridDoc = await gcpFetchJson(gridUrl);
  const rowData =
    (gridDoc.sheets &&
      gridDoc.sheets[0] &&
      gridDoc.sheets[0].data &&
      gridDoc.sheets[0].data[0] &&
      gridDoc.sheets[0].data[0].rowData) ||
    [];

  const cellText = (r, c) => {
    const rowObj = rowData[r - 1];
    const cell = rowObj && rowObj.values && rowObj.values[c - 1];
    return cell && cell.formattedValue !== undefined ? String(cell.formattedValue) : '';
  };

  const cellValidation = (r, c) => {
    const rowObj = rowData[r - 1];
    const cell = rowObj && rowObj.values && rowObj.values[c - 1];
    const dv = cell && cell.dataValidation;
    if (!dv || !dv.condition) return null;
    return {
      type: dv.condition.type,
      strict: !!dv.strict,
      values: (dv.condition.values || []).map(v => v.userEnteredValue),
    };
  };

  const switchRows = [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 27, 28, 29, 32, 34, 36];
  const switches = switchRows.map(r => ({
    row: r,
    label: cellText(r, 1),
    value: cellText(r, 2),
    note: cellText(r, 3),
  }));

  const switchByLabel = labelSubstr =>
    switches.find(s => s.label.toLowerCase().includes(labelSubstr.toLowerCase())) || null;

  const writeBack = switchByLabel('Write back to SLRR BigQuery');
  const postBurson = switchByLabel('Post in S-F Burson');
  const relaySw = switchByLabel('Relay with S-F Burson');
  const safetyValve = switchByLabel('Safety valve');
  const directB25 = switchByLabel('Work directly in B25');
  const proactiveWatch = switchByLabel('Proactive watch');
  const tempChecks = switchByLabel('Temp checks');
  const b31Validation = cellValidation(31, 2);
  // Row 35: Watch alerts (OFF / Other alerts space (B33) / Mirror space (B9)), only on its own labelled row
  const watchAlertsRow = cellText(35, 1) === 'Watch alerts';
  const b35Validation = watchAlertsRow ? cellValidation(35, 2) : null;

  return {
    workbook_title: meta.properties && meta.properties.title,
    sheet_id: sheetId,
    bot: {
      enabled: cellText(2, 2),
      status: cellText(5, 2),
      last_check: cellText(6, 2),
      today: cellText(7, 2),
      runs_as: cellText(8, 2),
    },
    spaces: {
      burson_space: { row: 3, configured: cellText(3, 2), resolved: cellText(3, 3) },
      analyst_space: { row: 4, configured: cellText(4, 2), resolved: cellText(4, 3) },
      mirror_space: { row: 9, configured: cellText(9, 2), resolved: cellText(9, 3) },
      autocorrect_space: { row: 10, configured: cellText(10, 2), resolved: cellText(10, 3) },
      sf_burson_space: { row: 25, configured: cellText(25, 2), resolved: cellText(25, 3) },
      burson_test_copy: { row: 26, configured: cellText(26, 2), resolved: cellText(26, 3) },
      // Row 33: a Google-only space with other alerts, worked directly every minute beside the Mirror (always Testing)
      other_alerts_space: { row: 33, configured: cellText(33, 2), resolved: cellText(33, 3) },
    },
    testing_recipients: {
      row: 30,
      configured: cellText(30, 2),
      resolved: cellText(30, 3),
    },
    brand_safety_groups_tab: tabs.find(t => t.title.toLowerCase() === 'brand safety groups') || null,
    bigquery_lookback: {
      row: 31,
      configured: cellText(31, 2),
      resolved: cellText(31, 3),
      validation: b31Validation,
    },
    // Row 32: ON with B25 a Google-only space, the bot works right in B25 (one space, always Testing); C32 says which
    work_directly_in_b25: directB25
      ? { row: 32, value: directB25.value, note: directB25.note, active: /^✓ ON: B25/.test(directB25.note) }
      : { row: 32, value: 'MISSING', note: '', active: false },
    // Row 34: Proactive watch, a shadow test over every source's new rows in BigQuery, read-only (Watches / Watch
    // detections / Watch sources tabs); C34 how it's doing, and which sources are live, stale or failing
    proactive_watch: proactiveWatch
      ? { row: 34, value: proactiveWatch.value, note: proactiveWatch.note }
      : { row: 34, value: 'MISSING', note: '' },
    // Row 35: Watch alerts, where the Proactive watch's flags are posted as the bot's own alerts (OFF until a person
    // chooses: the Other alerts space B33, or the Mirror space B9); C35 how it's going. MISSING before this build ran
    watch_alerts: watchAlertsRow
      ? { row: 35, value: cellText(35, 2), note: cellText(35, 3), validation: b35Validation }
      : { row: 35, value: 'MISSING', note: '', validation: null },
    // Row 36: Temp checks, the team's temperature check on request ("temp check <Brandwatch query>" in a thread of the
    // Mirror space or B33), Brandwatch read-only; C36 the last one. MISSING before this build ran
    temp_checks: tempChecks
      ? { row: 36, value: tempChecks.value, note: tempChecks.note }
      : { row: 36, value: 'MISSING', note: '' },
    switches,
    safety_audit: {
      write_back_bq_is_off: !writeBack || writeBack.value.toUpperCase() === 'OFF',
      post_in_sf_burson: postBurson ? postBurson.value : 'MISSING',
      relay_with_sf_burson: relaySw ? relaySw.value : 'MISSING',
      safety_valve: safetyValve ? `${safetyValve.value} (${safetyValve.note})` : 'MISSING',
      work_directly_in_b25: directB25 ? directB25.value : 'MISSING',
      proactive_watch: proactiveWatch ? proactiveWatch.value : 'MISSING',
      watch_alerts: watchAlertsRow ? cellText(35, 2) : 'MISSING',
      temp_checks: tempChecks ? tempChecks.value : 'MISSING',
      lookback_dropdown_strict_15m:
        !!b31Validation &&
        b31Validation.strict === true &&
        JSON.stringify(b31Validation.values) === JSON.stringify(['15 minutes', '30 minutes', '45 minutes', '60 minutes']),
    },
    tabs,
  };
}

async function handleReadLogs(args) {
  const project = args.gcp_project || DEFAULT_GCP_PROJECT;
  const projectKey = args.project_key || DEFAULT_LOGGING_PROJECT_KEY;
  const minutesBack = Math.min(Math.max(Number(args.minutes_back) || 120, 1), 10080);
  const limit = Math.min(Math.max(Number(args.limit) || 50, 1), 200);
  const includeLegacyOrphan = args.include_legacy_orphan === true;

  const sinceIso = new Date(Date.now() - minutesBack * 60 * 1000).toISOString();
  const clauses = [
    `labels."script.googleapis.com/project_key"="${projectKey}"`,
    `timestamp >= "${sinceIso}"`,
  ];

  if (!includeLegacyOrphan) {
    clauses.push('NOT resource.labels.function_name="checkSourceSpaceForNewMessages"');
  }
  if (args.severity) {
    clauses.push(`severity >= ${String(args.severity).toUpperCase()}`);
  }
  if (args.process_id) {
    const safePid = String(args.process_id).replace(/"/g, '\\"');
    clauses.push(`labels."script.googleapis.com/process_id"="${safePid}"`);
  }
  if (args.function_name) {
    const safeFn = String(args.function_name).replace(/"/g, '\\"');
    clauses.push(`resource.labels.function_name="${safeFn}"`);
  }
  if (args.search) {
    const safeSearch = String(args.search).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    clauses.push(`(jsonPayload.message:"${safeSearch}" OR textPayload:"${safeSearch}")`);
  }

  const filter = clauses.join(' AND ');
  const resp = await gcpFetchJson(LOGGING_ENTRIES_URL, {
    method: 'POST',
    quotaProject: project,
    body: {
      resourceNames: [`projects/${project}`],
      filter,
      orderBy: 'timestamp desc',
      pageSize: limit,
    },
  });

  const rawEntries = (resp && resp.entries) || [];
  const entries = rawEntries.map(e => ({
    timestamp: e.timestamp,
    severity: e.severity || 'DEFAULT',
    function_name: (e.resource && e.resource.labels && e.resource.labels.function_name) || '',
    process_id: (e.labels && e.labels['script.googleapis.com/process_id']) || '',
    message:
      (e.jsonPayload && e.jsonPayload.message) ||
      e.textPayload ||
      (e.jsonPayload ? JSON.stringify(e.jsonPayload) : ''),
  }));

  const severityCounts = {};
  entries.forEach(e => {
    severityCounts[e.severity] = (severityCounts[e.severity] || 0) + 1;
  });

  return {
    filter_used: filter,
    minutes_back: minutesBack,
    returned_count: entries.length,
    severity_counts: severityCounts,
    entries,
  };
}

async function handleInspectRelayAndOutbox(args) {
  const sheetId = args.sheet_id || DEFAULT_STORE_SHEET_ID;
  const maxRows = Math.min(Math.max(Number(args.limit) || 40, 5), 200);
  const meta = await getWorkbookMetadata(sheetId);
  const existing = new Set(((meta && meta.sheets) || []).map(s => s.properties.title));

  const wantedTabs = ['Burson outbox', 'Relay', 'Relay names', 'Test copy'].filter(t => existing.has(t));
  if (!wantedTabs.length) {
    return {
      sheet_id: sheetId,
      present_tabs: [],
      note: 'None of Burson outbox, Relay, Relay names, or Test copy tabs exist in the workbook yet.',
    };
  }

  const batch = await batchGetValues(
    sheetId,
    wantedTabs.map(t => `'${t}'!A1:N2000`)
  );
  const byTab = {};
  (batch.valueRanges || []).forEach((vr, idx) => {
    byTab[wantedTabs[idx]] = vr.values || [];
  });

  const outboxRows = rowsToObjects(byTab['Burson outbox'] || []);
  const outboxStatusCounts = {};
  outboxRows.forEach(r => {
    const st = r.Status || 'Unknown';
    outboxStatusCounts[st] = (outboxStatusCounts[st] || 0) + 1;
  });

  const relayRows = rowsToObjects(byTab['Relay'] || []);
  const relayDirectionCounts = {};
  relayRows.forEach(r => {
    const key = `${r.direction || '?'} :: ${r.status || '?'}`;
    relayDirectionCounts[key] = (relayDirectionCounts[key] || 0) + 1;
  });

  const nameRows = rowsToObjects(byTab['Relay names'] || []);
  const unmappedUsers = nameRows.filter(r => !String(r.name || '').trim() || !String(r.org || '').trim());

  return {
    sheet_id: sheetId,
    present_tabs: wantedTabs,
    burson_outbox: {
      exists: existing.has('Burson outbox'),
      total_rows: outboxRows.length,
      status_counts: outboxStatusCounts,
      pending_or_send_rows: outboxRows.filter(r => /^(pending|send|blocked|failed)$/i.test(String(r.Status || '').trim())).slice(-maxRows),
      recent_rows: outboxRows.slice(-Math.min(15, maxRows)),
    },
    relay: {
      exists: existing.has('Relay'),
      total_rows: relayRows.length,
      direction_status_counts: relayDirectionCounts,
      recent_rows: relayRows.slice(-maxRows),
    },
    relay_names: {
      exists: existing.has('Relay names'),
      total_people: nameRows.length,
      unmapped_count: unmappedUsers.length,
      unmapped_people: unmappedUsers.slice(0, 30),
      mapped_people: nameRows.filter(r => String(r.name || '').trim() && String(r.org || '').trim()),
    },
  };
}

async function handleInspectParityAndResults(args) {
  const sheetId = args.sheet_id || DEFAULT_STORE_SHEET_ID;
  const maxRows = Math.min(Math.max(Number(args.limit) || 50, 10), 200);
  const meta = await getWorkbookMetadata(sheetId);
  const existing = new Set(((meta && meta.sheets) || []).map(s => s.properties.title));

  const ranges = [];
  const keys = [];
  if (existing.has('Results')) {
    ranges.push(`'Results'!A1:L350`);
    keys.push('Results');
  }
  if (existing.has('Learned precedents')) {
    ranges.push(`'Learned precedents'!A1:J150`);
    keys.push('Learned precedents');
  }
  if (existing.has('Analysis')) {
    ranges.push(`'Analysis'!A1:N120`);
    keys.push('Analysis');
  }
  if (!ranges.length) {
    return { sheet_id: sheetId, note: 'Neither Results, Learned precedents, nor Analysis tab exists yet.' };
  }

  const batch = await batchGetValues(sheetId, ranges);
  const dataMap = {};
  (batch.valueRanges || []).forEach((vr, idx) => {
    dataMap[keys[idx]] = vr.values || [];
  });

  const resultsRaw = dataMap['Results'] || [];
  const headlineBlock = [];
  const disagreements = [];
  let inDisagreements = false;
  let disagreementHeader = null;

  for (let i = 0; i < resultsRaw.length; i++) {
    const row = resultsRaw[i] || [];
    const first = String(row[0] || '').trim();
    if (i < 28 && row.some(c => String(c || '').trim())) {
      headlineBlock.push({ row: i + 1, cells: row.filter(c => String(c || '').trim() !== '') });
    }
    if (/WHERE THE BOT AND THE IMs DIFFERED/i.test(first)) {
      inDisagreements = true;
      disagreementHeader = null;
      continue;
    }
    if (inDisagreements) {
      if (/^(EVERY ALERT|OUTCOMES|FOLLOW-UP)/i.test(first)) {
        inDisagreements = false;
        continue;
      }
      if (!row.some(c => String(c || '').trim())) continue;
      if (!disagreementHeader) {
        disagreementHeader = row.map((h, idx) => String(h || `col_${idx + 1}`).trim());
      } else if (disagreements.length < maxRows) {
        const item = { _row: i + 1 };
        disagreementHeader.forEach((h, j) => {
          if (h) item[h] = row[j] !== undefined ? String(row[j]) : '';
        });
        disagreements.push(item);
      }
    }
  }

  const precedents = rowsToObjects(dataMap['Learned precedents'] || []);
  const analysisRaw = dataMap['Analysis'] || [];
  let analysisSummary = { exists: existing.has('Analysis') };
  if (existing.has('Analysis') && analysisRaw.length) {
    const headIdx = analysisRaw.findIndex(r => String((r && r[0]) || '').trim() === 'Posted / Asked (ET)');
    const header = headIdx >= 0 ? analysisRaw[headIdx].slice(0, 12).map(c => String(c || '').trim()) : [];
    const items = headIdx >= 0
      ? rowsToObjects([header].concat(analysisRaw.slice(headIdx + 1).map(r => (r || []).slice(0, 12))))
      : [];
    if (headIdx === 0) {
      let panelControls = null;
      let panelSummary = null;
      const row2 = analysisRaw[1] || [];
      try { if (row2[12]) panelControls = JSON.parse(row2[12]); } catch (e) {}
      try { if (row2[13]) panelSummary = JSON.parse(row2[13]); } catch (e) {}
      analysisSummary = {
        exists: true,
        layout: 2,
        header_row: 1,
        updated: (panelSummary && panelSummary.overview && panelSummary.overview.updatedEt) || '',
        overview: (panelSummary && panelSummary.overview) || null,
        controls: (panelSummary && panelSummary.controls) || panelControls,
        scorecard: (panelSummary && panelSummary.scorecard) || null,
        rows_shown: items.filter(it => it['row key']).length,
        sample_rows: items.filter(it => it['row key']).slice(0, Math.min(10, maxRows)),
      };
    } else {
      analysisSummary = {
        exists: true,
        layout: 1,
        header_row: headIdx + 1,
        updated: String(((analysisRaw[0] || [])[4]) || '').trim(),
        controls: analysisRaw.slice(3, 7).map(r => ({
          setting: String((r && r[0]) || '').trim(),
          value: String((r && r[1]) || '').trim(),
          status: String((r && r[2]) || '').trim(),
        })),
        scorecard: analysisRaw.slice(9, 13).map(r => ({
          metric: String((r && r[0]) || '').trim(),
          value: String((r && r[1]) || '').trim(),
          detail: String((r && r[2]) || '').trim(),
        })),
        rows_shown: items.length,
        sample_rows: items.slice(0, Math.min(10, maxRows)),
      };
    }
  }

  return {
    sheet_id: sheetId,
    results_headline: headlineBlock,
    disagreement_count_shown: disagreements.length,
    disagreements,
    learned_precedents: {
      exists: existing.has('Learned precedents'),
      total: precedents.length,
      active_count: precedents.filter(p => !/^no$/i.test(String(p['Active (Yes/No)'] || p.Active || 'Yes').trim())).length,
      rows: precedents.slice(-maxRows),
    },
    analysis_tab: analysisSummary,
  };
}

async function handleInspectKnowledgeAndGuidance(args) {
  const sheetId = args.sheet_id || DEFAULT_STORE_SHEET_ID;
  const meta = await getWorkbookMetadata(sheetId);
  const existing = new Set(((meta && meta.sheets) || []).map(s => s.properties.title));

  const wantedTabs = ['Resources', 'Guidance'].filter(t => existing.has(t));
  const batch = wantedTabs.length
    ? await batchGetValues(
        sheetId,
        wantedTabs.map(t => `'${t}'!A1:F100`)
      )
    : { valueRanges: [] };

  const byTab = {};
  (batch.valueRanges || []).forEach((vr, idx) => {
    byTab[wantedTabs[idx]] = vr.values || [];
  });

  const resources = rowsToObjects(byTab['Resources'] || []);
  const guidance = rowsToObjects(byTab['Guidance'] || []);

  const failingDocs = resources.filter(r => {
    const st = String(r['Bot status'] || '').trim();
    return (r.Name || r.Link) && (!st || !st.startsWith('✓'));
  });

  return {
    sheet_id: sheetId,
    resources: {
      total_docs: resources.length,
      healthy_docs: resources.length - failingDocs.length,
      burson_visible_docs: resources.filter(r => /^yes$/i.test(String(r['Burson can see it?'] || '').trim())).map(r => r.Name),
      failing_or_unread_docs: failingDocs,
      all_docs: resources,
    },
    guidance: {
      total_rules: guidance.length,
      rules: guidance,
    },
  };
}

const TOOLS = [
  {
    name: 'slrr_get_control_status',
    description:
      'Read live Control tab state from the Burson QA Bot Google Sheet: Bot ON/OFF, Last check, Today stats, space links/statuses (Burson, Analyst, Mirror, Auto-correct, S-F Burson B25, Burson test copy B26), all 20 switches (row 32: Work directly in B25; row 34: Proactive watch; row 36: Temp checks), row 35 Watch alerts (where the watch\'s flags are posted: OFF, B33 or B9), B30 testers, B31 BigQuery lookback validation, and live safety checks.',
    inputSchema: {
      type: 'object',
      properties: {
        sheet_id: {
          type: 'string',
          description: 'Optional Google Sheet ID override (defaults to live Burson QA Bot Control Sheet).',
        },
      },
    },
    handler: handleGetControlStatus,
  },
  {
    name: 'slrr_read_logs',
    description:
      'Query live Apps Script Cloud Logging entries for the Burson QA Bot (automatically scoped to project_key MT90an4vYnIDfrbDRi1jgSZANzck4hlvJ on brand-social-central-data and excluding orphaned legacy triggers). Supports searching by QA-ID, post URL, keyword, severity, or single-run process_id.',
    inputSchema: {
      type: 'object',
      properties: {
        minutes_back: {
          type: 'number',
          description: 'How many minutes back to search (default: 120, max: 10080 for 7 days).',
        },
        severity: {
          type: 'string',
          enum: ['DEFAULT', 'INFO', 'WARNING', 'ERROR'],
          description: 'Optional minimum log severity filter.',
        },
        search: {
          type: 'string',
          description: 'Optional substring to match in log message (e.g., "QA-", author handle, "relay", "outbox", "early wave").',
        },
        process_id: {
          type: 'string',
          description: 'Optional Apps Script process_id to retrieve the complete 1-minute execution trace of a specific run.',
        },
        function_name: {
          type: 'string',
          description: 'Optional Apps Script function name filter (e.g., "poll").',
        },
        limit: {
          type: 'number',
          description: 'Maximum log entries to return (default: 50, max: 200).',
        },
        include_legacy_orphan: {
          type: 'boolean',
          description: 'Set true only if you want to see legacy checkSourceSpaceForNewMessages trigger errors.',
        },
      },
    },
    handler: handleReadLogs,
  },
  {
    name: 'slrr_inspect_relay_and_outbox',
    description:
      'Inspect live 2-way S-F Burson <-> Mirror space bridge tabs: `Burson outbox` (Pending/Send/Blocked/Sent rows), `Relay` message/reaction history, and `Relay names` (highlighting any unmapped Chat user IDs missing name or Google/Burson org).',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Max recent rows to return per tab (default: 40, max: 200).',
        },
        sheet_id: {
          type: 'string',
          description: 'Optional Google Sheet ID override.',
        },
      },
    },
    handler: handleInspectRelayAndOutbox,
  },
  {
    name: 'slrr_inspect_parity_and_results',
    description:
      'Read the live `Results` and `Learned precedents` tabs to inspect Bot vs. Human IM speed/accuracy KPIs, `WHERE THE BOT AND THE IMs DIFFERED` disagreements (`im_only` vs `bot_only`), and active learned precedents.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Max disagreement/precedent rows to return (default: 50, max: 200).',
        },
        sheet_id: {
          type: 'string',
          description: 'Optional Google Sheet ID override.',
        },
      },
    },
    handler: handleInspectParityAndResults,
  },
  {
    name: 'slrr_inspect_knowledge_and_guidance',
    description:
      'Read the live `Resources` (knowledge base docs, read status, Burson visibility) and `Guidance` (active SLRR lead escalation/skip instructions) tabs.',
    inputSchema: {
      type: 'object',
      properties: {
        sheet_id: {
          type: 'string',
          description: 'Optional Google Sheet ID override.',
        },
      },
    },
    handler: handleInspectKnowledgeAndGuidance,
  },
];

const server = createMcpStdioServer({
  name: 'slrr-live-ops',
  version: '1.0.0',
  instructions:
    'Read-only live operations and diagnostics server for the Burson QA Bot (SLRR). Use these tools first before running raw gcloud or ad-hoc Sheets scripts.',
  tools: TOOLS,
});

if (require.main === module) {
  server.start();
}

module.exports = { TOOLS, server };
