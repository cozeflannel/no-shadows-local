// Runs Steps.gs + Code.gs in Node with mocked Apps Script services and prints,
// per step, the request the add-on sends to Agent Engine and the outputs it
// returns to Studio. Used by tests/test_studio_addon.py (no Studio needed).
//
//   node studio-addon/test/harness.js            # canned agent response
//   node studio-addon/test/harness.js --error 503 # simulate a transient failure
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const args = process.argv.slice(2);
const errorCode = args[0] === '--error' ? Number(args[1]) : 0;
const captured = [];

// --- mocks -----------------------------------------------------------------
function chain(record) {
  // Generic fluent builder: every setX/addX returns this and records the call.
  return new Proxy(record, {
    get(target, prop) {
      if (prop in target) return target[prop];
      return (...a) => { (target.calls = target.calls || []).push([prop, a]); return chain(target); };
    }
  });
}
const AddOnsResponseService = {
  ErrorActionability: { ACTIONABLE: 'ACTIONABLE', NOT_ACTIONABLE: 'NOT_ACTIONABLE' },
  ErrorRetryability: { RETRYABLE: 'RETRYABLE', NOT_RETRYABLE: 'NOT_RETRYABLE' },
  newVariableData: () => chain({ kind: 'VariableData' }),
  newReturnOutputVariablesAction: () => chain({ kind: 'ReturnOutputVariables' }),
  newReturnElementErrorAction: () => chain({ kind: 'ReturnElementError' }),
  newWorkflowTextFormat: () => chain({ kind: 'WorkflowTextFormat' }),
  newTextFormatElement: () => chain({ kind: 'TextFormatElement' }),
  newHostAppAction: () => chain({ kind: 'HostAppAction' }),
  newRenderActionBuilder: () => chain({ kind: 'RenderActionBuilder', build() { return this; } }),
};
const CardService = {
  InputMode: { RICH_TEXT: 'RICH_TEXT', PLAIN_TEXT: 'PLAIN_TEXT' },
  newCardSection: () => chain({ kind: 'CardSection' }),
  newTextInput: () => chain({ kind: 'TextInput' }),
  newTextParagraph: () => chain({ kind: 'TextParagraph' }),
  newHostAppDataSource: () => chain({ kind: 'HostAppDataSource' }),
  newWorkflowDataSource: () => chain({ kind: 'WorkflowDataSource' }),
  newCardBuilder: () => chain({ kind: 'CardBuilder', build() { return this; } }),
};
const cannedOutputs = {
  has_reply: 'no', reply_text: '', has_burson: 'no', burson_text: '', has_clean: 'yes', clean_text: '🤖 test · TRG-1001',
  has_dm: 'no', dm_text: '', dm_recipients: '', has_youtube: 'no', youtube_text: '', has_doodle: 'no', doodle_text: '',
  has_team: 'no', team_text: '', has_crisis: 'no', crisis_text: '', has_handover: 'no', handover_text: '',
  case_id: 'TRG-1001', escalation_id: '', verdict: 'PASS', summary: 'TRG-1001 PASS'
};
const UrlFetchApp = {
  fetch(url, options) {
    captured.push({ url, headers: options.headers, body: JSON.parse(options.payload) });
    if (errorCode) return { getResponseCode: () => errorCode, getContentText: () => '{"error":"boom"}' };
    return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ output: { ok: true, op: 'x', outputs: cannedOutputs, data: {} } }) };
  }
};
const sandbox = {
  console: { log() {}, error() {} },
  AddOnsResponseService, CardService, UrlFetchApp,
  ScriptApp: { getOAuthToken: () => 'TOKEN' },
  PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => ({ AGENT_ENGINE_RESOURCE: 'projects/p/locations/us-central1/reasoningEngines/123', TRIAGE_ENV: 'dev' })[k] || null }) },
  Session: { getEffectiveUser: () => ({ getEmail: () => 'triage-agent@runner.test' }) },
  Utilities: { getUuid: () => 'run-1' },
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root, 'Steps.gs'), 'utf8') + '\n' + fs.readFileSync(path.join(root, 'Code.gs'), 'utf8'), sandbox);

// --- events ----------------------------------------------------------------
const s = (v) => ({ stringValues: [v] });
const events = {
  triage_alert: { message_text: s('Alert Name: x\nProduct: Gemini App'), sender_name: s('Zapier'), space: s('spaces/AAQAaa_0I9g'),
                  message_id: s('spaces/AAQAaa_0I9g/messages/abc'), sent_at: s('1760292000000'), targets: s('burson,clean,dm,youtube,doodle'), flow: s('burson_alerts') },
  record_reaction: { emoji: s('📦'), reactor_email: s('im@ops.test'), message_text: s('🤖 *Alert* · TRG-1001'), space: s('SLRR Triaged Alerts'), targets: s('reply,dm,crisis') },
  converse: { message_text: s("who's on shift?"), sender_email: s('im@ops.test'), conversation_type: s('DM'), targets: s('reply,dm') },
  ingest_email: { subject: s('Issue [4821337]: WD Intake Request'), from: s('Watchdog <watchdog@tns.test>'), to: s('a@ops.test, b@ops.test'),
                  body: s('Thanks [SLRR ESC-1001 / TRG-1001]'), received_at: s('2026-10-12T18:00:00Z'), targets: s('clean,dm,youtube,doodle') },
  deliver_outbox: { targets: s('burson,clean,dm,youtube,doodle,team,crisis,handover') },
  record_post: { case_id: s('TRG-1001'), message_link: s('https://chat.google.com/room/X/Y') },
  inspect_variables: { var1: s('hello'), var2: s('world') },
};

const results = [];
for (const [step, inputs] of Object.entries(events)) {
  const fn = 'onExecute' + step.split('_').map((p) => p[0].toUpperCase() + p.slice(1)).join('');
  const before = captured.length;
  const response = sandbox[fn]({ workflow: { actionInvocation: { inputs } } });
  const action = response.calls[0][1][0].calls[0][1][0]; // RenderActionBuilder.setHostAppAction(HostAppAction.setWorkflowAction(x))
  const outputs = {};
  let errorRetry = null, errorAct = null;
  for (const [name, a] of action.calls || []) {
    if (name === 'setVariableDataMap') for (const [k, vd] of Object.entries(a[0])) outputs[k] = vd.calls[0][1][0];
    if (name === 'setErrorRetryability') errorRetry = a[0];
    if (name === 'setErrorActionability') errorAct = a[0];
  }
  results.push({ step, function: fn, kind: action.kind, request: captured.length > before ? captured[captured.length - 1] : null,
                 outputs, error_retryability: errorRetry, error_actionability: errorAct });
}
const configCard = sandbox.onConfigTriageAlert({});
process.stdout.write(JSON.stringify({ results, config_widgets: (configCard.calls || []).length }, null, 2));
