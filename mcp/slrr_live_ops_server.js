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

const fs = require('fs');
const path = require('path');
const {
  DEFAULT_GCP_PROJECT,
  DEFAULT_STORE_SHEET_ID,
  DEFAULT_SCRIPT_ID,
  DEFAULT_LOGGING_PROJECT_KEY,
  gcpFetchJson,
  createMcpStdioServer,
} = require('./mcp_stdio');

const REPO_ROOT = path.resolve(__dirname, '..');
const SIDEPANEL_SCRIPT_ID = '1I-2Zrj1V1yr7hYVzhicyO3xNLXqxBeX_cmQUnC9-u4kWmGgjfvgC6pqT';
const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';
const DRIVE_FILES_BASE = 'https://www.googleapis.com/drive/v3/files';
const SCRIPT_PROJECTS_BASE = 'https://script.googleapis.com/v1/projects';
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

function safeJsonParse(str, fallback = null) {
  if (!str || typeof str !== 'string') return fallback;
  try {
    return JSON.parse(str);
  } catch (_e) {
    return fallback;
  }
}

async function handleTraceAlert(args) {
  const query = String(args.query || '').trim();
  if (!query) {
    throw new Error('query is required (e.g., "QA-1002", author handle, post URL, or issue keyword)');
  }
  const sheetId = args.sheet_id || DEFAULT_STORE_SHEET_ID;
  const maxMatches = Math.min(Math.max(Number(args.limit) || 10, 1), 50);
  const includeLogs = args.include_logs !== false;
  const minutesBack = Math.min(Math.max(Number(args.minutes_back) || 1440, 10), 10080);
  const qLower = query.toLowerCase();

  const meta = await getWorkbookMetadata(sheetId);
  const existing = new Set(((meta && meta.sheets) || []).map(s => s.properties.title));
  const wanted = ['Alert log', 'Results', 'Relay', 'Burson outbox', 'Watch detections', 'Follow-up'].filter(t => existing.has(t));
  const ranges = wanted.map(t => (t === 'Alert log' ? `'${t}'!A1:AP2000` : `'${t}'!A1:N1500`));
  const batch = wanted.length ? await batchGetValues(sheetId, ranges) : { valueRanges: [] };
  const byTab = {};
  (batch.valueRanges || []).forEach((vr, idx) => {
    byTab[wanted[idx]] = vr.values || [];
  });

  // 1. Search Alert log
  const alertLogRows = rowsToObjects(byTab['Alert log'] || []);
  const matchedAlerts = alertLogRows
    .filter(r => Object.values(r).some(v => String(v || '').toLowerCase().includes(qLower)))
    .slice(-maxMatches)
    .map(r => {
      const forwardedFields = safeJsonParse(r.forwarded_fields, null);
      const requestedFixes = safeJsonParse(r.requested, null);
      const emailInput = safeJsonParse(r.email_input, null);
      const decisionObj = safeJsonParse(r.decision, r.decision);
      const knowledgeUsed = safeJsonParse(r.knowledge_used, r.knowledge_used);
      return Object.assign({}, r, {
        created_at_iso: Number(r.created_at) ? new Date(Number(r.created_at)).toISOString() : r.created_at,
        updated_at_iso: Number(r.updated_at) ? new Date(Number(r.updated_at)).toISOString() : r.updated_at,
        forwarded_fields_parsed: forwardedFields,
        requested_parsed: requestedFixes,
        email_input_parsed: emailInput,
        decision_parsed: decisionObj,
        knowledge_used_parsed: knowledgeUsed,
      });
    });

  // Collect correlation keys from matched alerts
  const matchTokens = new Set([qLower]);
  matchedAlerts.forEach(a => {
    [
      a.alert_id,
      a.record_key,
      a.author,
      a.source_message,
      a.source_thread,
      a.forward_message,
      a.forward_thread,
      a.live_message,
      a.live_thread,
      a.forwarded_fields_parsed && a.forwarded_fields_parsed.issue_name,
    ]
      .filter(Boolean)
      .forEach(tok => {
        const s = String(tok).trim().toLowerCase();
        if (s.length >= 4) matchTokens.add(s);
      });
  });

  const rowMatchesAnyToken = rowObj => {
    const joined = Object.values(rowObj).join(' \n ').toLowerCase();
    for (const tok of matchTokens) {
      if (joined.includes(tok)) return true;
    }
    return false;
  };

  // 2. Search Results tab (EVERY ALERT + disagreements)
  const resultsRaw = byTab['Results'] || [];
  const resultsMatches = [];
  let currentHeader = null;
  for (let i = 0; i < resultsRaw.length; i++) {
    const r = resultsRaw[i] || [];
    const first = String(r[0] || '').trim();
    if (/^(Burson posted \(ET\)|The IMs sent a Social Alert|The bot sent a Social Alert)/i.test(first)) {
      currentHeader = r.map((h, idx) => String(h || `col_${idx + 1}`).trim());
      continue;
    }
    if (!currentHeader || !r.some(c => String(c || '').trim())) continue;
    const joined = r.join(' | ').toLowerCase();
    let hit = false;
    for (const tok of matchTokens) {
      if (joined.includes(tok)) {
        hit = true;
        break;
      }
    }
    if (hit && resultsMatches.length < maxMatches) {
      const obj = { _row: i + 1 };
      currentHeader.forEach((h, j) => {
        if (h) obj[h] = r[j] !== undefined ? String(r[j]) : '';
      });
      resultsMatches.push(obj);
    }
  }

  // 3. Search Relay & Burson outbox
  const relayMatches = rowsToObjects(byTab['Relay'] || []).filter(rowMatchesAnyToken).slice(-maxMatches);
  const outboxMatches = rowsToObjects(byTab['Burson outbox'] || []).filter(rowMatchesAnyToken).slice(-maxMatches);
  const followUpMatches = rowsToObjects(byTab['Follow-up'] || []).filter(rowMatchesAnyToken).slice(-maxMatches);

  // 4. Search Watch detections
  const watchRaw = byTab['Watch detections'] || [];
  const watchHeaderIdx = watchRaw.findIndex(r => (r || []).some(c => /^Watch$/i.test(String(c || '').trim()) || /^Post$/i.test(String(c || '').trim())));
  const watchRows = watchHeaderIdx >= 0 ? rowsToObjects(watchRaw.slice(watchHeaderIdx)) : [];
  const watchMatches = watchRows.filter(rowMatchesAnyToken).slice(-maxMatches);

  // 5. Optional Cloud Logging search
  let cloudLogs = null;
  if (includeLogs) {
    const logSearchTerm = (matchedAlerts[0] && matchedAlerts[0].alert_id) || query;
    try {
      cloudLogs = await handleReadLogs({
        minutes_back: minutesBack,
        search: logSearchTerm,
        limit: 30,
      });
    } catch (e) {
      cloudLogs = { error: e.message };
    }
  }

  return {
    query,
    sheet_id: sheetId,
    correlation_tokens: Array.from(matchTokens),
    alert_log_matches: matchedAlerts,
    results_parity_matches: resultsMatches,
    relay_matches: relayMatches,
    burson_outbox_matches: outboxMatches,
    follow_up_matches: followUpMatches,
    watch_detection_matches: watchMatches,
    cloud_logging: cloudLogs,
  };
}

function diffFilesSummary(localContent, remoteContent, includePreview) {
  const norm = s => String(s || '').replace(/\r\n/g, '\n');
  const a = norm(localContent);
  const b = norm(remoteContent);
  if (a === b) return { identical: true };
  const aLines = a.split('\n');
  const bLines = b.split('\n');
  let firstDiffLine = 1;
  const maxLen = Math.max(aLines.length, bLines.length);
  for (let i = 0; i < maxLen; i++) {
    if (aLines[i] !== bLines[i]) {
      firstDiffLine = i + 1;
      break;
    }
  }
  const out = {
    identical: false,
    local_lines: aLines.length,
    remote_lines: bLines.length,
    first_diff_line: firstDiffLine,
  };
  if (includePreview) {
    out.local_snippet = aLines.slice(Math.max(0, firstDiffLine - 2), firstDiffLine + 3).join('\n');
    out.remote_snippet = bLines.slice(Math.max(0, firstDiffLine - 2), firstDiffLine + 3).join('\n');
  }
  return out;
}

async function diffSingleAppsScriptProject({ name, scriptId, localDir, includePreview }) {
  const url = `${SCRIPT_PROJECTS_BASE}/${encodeURIComponent(scriptId)}/content`;
  const remote = await gcpFetchJson(url);
  const remoteFiles = new Map();
  ((remote && remote.files) || []).forEach(f => {
    const ext = f.type === 'SERVER_JS' ? '.gs' : f.type === 'HTML' ? '.html' : f.type === 'JSON' ? '.json' : '';
    const filename = `${f.name}${ext}`;
    remoteFiles.set(filename, f.source || '');
  });

  const entries = fs.existsSync(localDir) ? fs.readdirSync(localDir, { withFileTypes: true }) : [];
  const localFiles = new Map();
  entries.forEach(ent => {
    if (!ent.isFile()) return;
    if (ent.name === 'appsscript.json' || ent.name.endsWith('.gs') || ent.name.endsWith('.html')) {
      localFiles.set(ent.name, fs.readFileSync(path.join(localDir, ent.name), 'utf8'));
    }
  });

  const identical = [];
  const modified = [];
  const localOnly = [];
  const remoteOnly = [];

  for (const [fname, localSrc] of localFiles.entries()) {
    if (!remoteFiles.has(fname)) {
      localOnly.push(fname);
      continue;
    }
    const cmp = diffFilesSummary(localSrc, remoteFiles.get(fname), includePreview);
    if (cmp.identical) {
      identical.push(fname);
    } else {
      modified.push(Object.assign({ file: fname }, cmp));
    }
  }
  for (const fname of remoteFiles.keys()) {
    if (!localFiles.has(fname)) {
      remoteOnly.push(fname);
    }
  }

  return {
    project: name,
    script_id: scriptId,
    local_dir: localDir,
    in_sync: modified.length === 0 && localOnly.length === 0 && remoteOnly.length === 0,
    identical_count: identical.length,
    modified_count: modified.length,
    local_only_count: localOnly.length,
    remote_only_count: remoteOnly.length,
    modified_files: modified,
    local_only_files: localOnly,
    remote_only_files: remoteOnly,
  };
}

async function handleDiffLiveAppsScript(args) {
  const target = String(args.target || 'all').toLowerCase();
  const includePreview = args.include_diff_preview !== false;
  const targets = [];
  if (target === 'all' || target === 'chat-bot') {
    targets.push({
      name: 'apps-script-chat-bot',
      scriptId: DEFAULT_SCRIPT_ID,
      localDir: path.join(REPO_ROOT, 'apps-script-chat-bot'),
      includePreview,
    });
  }
  if (target === 'all' || target === 'sheet-sidepanel') {
    targets.push({
      name: 'apps-script-sheet-sidepanel',
      scriptId: SIDEPANEL_SCRIPT_ID,
      localDir: path.join(REPO_ROOT, 'apps-script-sheet-sidepanel'),
      includePreview,
    });
  }

  const results = [];
  for (const t of targets) {
    results.push(await diffSingleAppsScriptProject(t));
  }
  return {
    all_in_sync: results.every(r => r.in_sync),
    projects: results,
  };
}

function extractDriveFileId(url) {
  const s = String(url || '');
  const m =
    s.match(/\/(?:document|spreadsheets|presentation|file)\/d\/([A-Za-z0-9_-]{15,})/) ||
    s.match(/[?&]id=([A-Za-z0-9_-]{15,})/);
  return m ? m[1] : null;
}

async function handleInspectResourceDoc(args) {
  const sheetId = args.sheet_id || DEFAULT_STORE_SHEET_ID;
  const query = String(args.query || '').trim().toLowerCase();
  const checkDriveMeta = args.check_drive_metadata !== false;

  const meta = await getWorkbookMetadata(sheetId);
  const existing = new Set(((meta && meta.sheets) || []).map(s => s.properties.title));
  const wanted = ['Resources', 'Knowledge cache (bot)'].filter(t => existing.has(t));
  const ranges = wanted.map(t => (t === 'Knowledge cache (bot)' ? `'${t}'!A1:C500` : `'${t}'!A1:F100`));
  const batch = wanted.length ? await batchGetValues(sheetId, ranges) : { valueRanges: [] };
  const byTab = {};
  (batch.valueRanges || []).forEach((vr, idx) => {
    byTab[wanted[idx]] = vr.values || [];
  });

  const resources = rowsToObjects(byTab['Resources'] || []);
  const cacheRows = (byTab['Knowledge cache (bot)'] || []).slice(1);
  const cacheByUrl = new Map();
  for (const r of cacheRows) {
    const link = String(r[0] || '').trim();
    const part = Number(r[1]);
    const cellText = String(r[2] || '');
    if (!link) continue;
    if (!cacheByUrl.has(link)) {
      cacheByUrl.set(link, { meta: null, parts: 0, total_cached_chars: 0, max_part_chars: 0, sample_text: '' });
    }
    const entry = cacheByUrl.get(link);
    if (part === 0) {
      entry.meta = safeJsonParse(cellText, { raw: cellText });
    } else if (part > 0) {
      entry.parts += 1;
      entry.total_cached_chars += cellText.length;
      if (cellText.length > entry.max_part_chars) entry.max_part_chars = cellText.length;
      if (!entry.sample_text) entry.sample_text = cellText.slice(0, 400);
    }
  }

  const filtered = query
    ? resources.filter(
        r =>
          String(r.Name || '').toLowerCase().includes(query) ||
          String(r.Link || '').toLowerCase().includes(query) ||
          String(r['What it covers'] || '').toLowerCase().includes(query)
      )
    : resources;

  const inspected = [];
  for (const r of filtered) {
    const link = String(r.Link || '').trim();
    const cacheInfo = cacheByUrl.get(link) || null;
    const fileId = extractDriveFileId(link);
    let driveMeta = null;
    if (checkDriveMeta && fileId) {
      try {
        const fields = 'id,name,mimeType,modifiedTime,version,shared,lastModifyingUser(displayName,emailAddress)';
        driveMeta = await gcpFetchJson(
          `${DRIVE_FILES_BASE}/${encodeURIComponent(fileId)}?SupportsAllDrives=true&supportsAllDrives=true&fields=${encodeURIComponent(fields)}`
        );
      } catch (e) {
        driveMeta = { error: e.message };
      }
    }
    inspected.push({
      row: r._row,
      name: r.Name,
      link,
      covers: r['What it covers'],
      burson_can_see: r['Burson can see it?'],
      bot_status: r['Bot status'],
      knowledge_cache: cacheInfo
        ? {
            cached_status: cacheInfo.meta && cacheInfo.meta.status,
            cached_parts: cacheInfo.parts,
            total_cached_chars: cacheInfo.total_cached_chars,
            max_part_chars: cacheInfo.max_part_chars,
            cell_cap_45k_ok: cacheInfo.max_part_chars <= 45000,
            read_at_iso:
              cacheInfo.meta && cacheInfo.meta.read_at ? new Date(Number(cacheInfo.meta.read_at)).toISOString() : null,
            drive_modified_at_cache: cacheInfo.meta && cacheInfo.meta.modified,
            sample_preview: cacheInfo.sample_text,
          }
        : null,
      drive_live_metadata: driveMeta,
    });
  }

  return {
    sheet_id: sheetId,
    matched_count: inspected.length,
    documents: inspected,
  };
}

async function handleReadCloudRunLogs(args) {
  const project = args.gcp_project || DEFAULT_GCP_PROJECT;
  const minutesBack = Math.min(Math.max(Number(args.minutes_back) || 120, 1), 10080);
  const limit = Math.min(Math.max(Number(args.limit) || 40, 1), 200);
  const includeWatchTabs = args.include_proactive_watch_sheet !== false;

  const sinceIso = new Date(Date.now() - minutesBack * 60 * 1000).toISOString();
  const clauses = [
    '(resource.type="cloud_run_revision" OR resource.type="cloud_run_job")',
    `timestamp >= "${sinceIso}"`,
  ];
  if (args.service_name) {
    const safeSvc = String(args.service_name).replace(/"/g, '\\"');
    clauses.push(`(resource.labels.service_name="${safeSvc}" OR resource.labels.job_name="${safeSvc}")`);
  }
  if (args.severity) {
    clauses.push(`severity >= ${String(args.severity).toUpperCase()}`);
  }
  if (args.search) {
    const safeSearch = String(args.search).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    clauses.push(`(textPayload:"${safeSearch}" OR jsonPayload.message:"${safeSearch}")`);
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

  const entries = ((resp && resp.entries) || []).map(e => ({
    timestamp: e.timestamp,
    severity: e.severity || 'DEFAULT',
    resource_type: e.resource && e.resource.type,
    service_or_job:
      (e.resource && e.resource.labels && (e.resource.labels.service_name || e.resource.labels.job_name)) || '',
    message:
      (e.jsonPayload && e.jsonPayload.message) ||
      e.textPayload ||
      (e.httpRequest ? `${e.httpRequest.requestMethod} ${e.httpRequest.status} ${e.httpRequest.requestUrl}` : '') ||
      (e.jsonPayload ? JSON.stringify(e.jsonPayload) : ''),
  }));

  let proactiveWatch = null;
  if (includeWatchTabs) {
    const sheetId = args.sheet_id || DEFAULT_STORE_SHEET_ID;
    const meta = await getWorkbookMetadata(sheetId);
    const existing = new Set(((meta && meta.sheets) || []).map(s => s.properties.title));
    const watchTabs = ['Watches', 'Watch sources', 'Watch detections'].filter(t => existing.has(t));
    if (watchTabs.length) {
      const batch = await batchGetValues(
        sheetId,
        watchTabs.map(t => `'${t}'!A1:J35`)
      );
      const map = {};
      (batch.valueRanges || []).forEach((vr, idx) => {
        map[watchTabs[idx]] = vr.values || [];
      });
      proactiveWatch = {
        watches: rowsToObjects(map['Watches'] || []),
        watch_sources: rowsToObjects((map['Watch sources'] || []).slice(2)),
        watch_detections_scorecard: rowsToObjects((map['Watch detections'] || []).slice(2, 12)),
      };
    }
  }

  return {
    filter_used: filter,
    minutes_back: minutesBack,
    returned_count: entries.length,
    entries,
    proactive_watch_sheet_summary: proactiveWatch,
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
  {
    name: 'slrr_trace_alert',
    description:
      'End-to-end multi-system trace for any Social Alert by QA-ID (e.g. "QA-1002"), author handle, post URL, or issue keyword. Correlates across `Alert log` (42 columns + parsed JSON fields), `Results` parity rows, `Relay`, `Burson outbox`, `Follow-up`, `Watch detections`, and Cloud Logging in a single read-only call ($0 cost).',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Alert ID ("QA-1002"), author handle ("AnnieCushing"), post URL, or issue/product substring.',
        },
        limit: {
          type: 'number',
          description: 'Max matched rows per section (default: 10, max: 50).',
        },
        include_logs: {
          type: 'boolean',
          description: 'Whether to also fetch matching Cloud Logging entries (default: true).',
        },
        minutes_back: {
          type: 'number',
          description: 'Cloud Logging lookback window in minutes (default: 1440 = 24h, max: 10080 = 7d).',
        },
        sheet_id: {
          type: 'string',
          description: 'Optional Google Sheet ID override.',
        },
      },
      required: ['query'],
    },
    handler: handleTraceAlert,
  },
  {
    name: 'slrr_diff_live_apps_script',
    description:
      'Fetch the live deployed Apps Script source files via the Apps Script REST API for both `apps-script-chat-bot` and `apps-script-sheet-sidepanel` and diff them line-by-line against your local workspace files ($0 cost).',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          enum: ['all', 'chat-bot', 'sheet-sidepanel'],
          description: 'Which Apps Script project to diff against live deployment (default: "all").',
        },
        include_diff_preview: {
          type: 'boolean',
          description: 'Include line snippet previews for any modified files (default: true).',
        },
      },
    },
    handler: handleDiffLiveAppsScript,
  },
  {
    name: 'slrr_inspect_resource_doc',
    description:
      'Deep-inspect knowledge base documents on the `Resources` tab alongside their cached chunks in `Knowledge cache (bot)` (verifying <=45,000 char cell caps) and live Google Drive API file metadata (`modifiedTime`, `lastModifyingUser`, `shared`).',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Optional document name or URL substring filter (omit to inspect all Resources docs).',
        },
        check_drive_metadata: {
          type: 'boolean',
          description: 'Fetch live Google Drive v3 file metadata for Drive-hosted docs/sheets (default: true).',
        },
        sheet_id: {
          type: 'string',
          description: 'Optional Google Sheet ID override.',
        },
      },
    },
    handler: handleInspectResourceDoc,
  },
  {
    name: 'slrr_read_cloud_run_logs',
    description:
      'Query Cloud Run service/job logs (`console`, `jobs`, `slrr_campaigns`) on `brand-social-central-data` alongside live `Watches`, `Watch sources`, and `Watch detections` health from the Control Sheet.',
    inputSchema: {
      type: 'object',
      properties: {
        service_name: {
          type: 'string',
          description: 'Optional Cloud Run service or job name filter.',
        },
        minutes_back: {
          type: 'number',
          description: 'Lookback window in minutes (default: 120, max: 10080).',
        },
        severity: {
          type: 'string',
          enum: ['DEFAULT', 'INFO', 'WARNING', 'ERROR'],
          description: 'Optional minimum log severity.',
        },
        search: {
          type: 'string',
          description: 'Optional substring to search in log payload.',
        },
        limit: {
          type: 'number',
          description: 'Maximum log entries to return (default: 40, max: 200).',
        },
        include_proactive_watch_sheet: {
          type: 'boolean',
          description: 'Include live Watches, Watch sources, and Watch detections summary from the Control Sheet (default: true).',
        },
      },
    },
    handler: handleReadCloudRunLogs,
  },
];

const server = createMcpStdioServer({
  name: 'slrr-live-ops',
  version: '1.1.0',
  instructions:
    'Read-only live operations and diagnostics server for the Burson QA Bot (SLRR). Use these tools first before running raw gcloud or ad-hoc Sheets scripts.',
  tools: TOOLS,
});

if (require.main === module) {
  server.start();
}

module.exports = { TOOLS, server };
