/**
 * SLRR Triage Agent: Workspace Studio custom steps (Apps Script add-on).
 *
 * No Chat API and no webhooks: each Studio flow (owned by the Triage Agent
 * account) runs one of these steps, which calls the agent on Vertex AI Agent
 * Engine and returns 23 STRING output variables. The flow's own "Check if
 * has_x is yes" blocks then post with Studio's built-in Chat / Docs steps.
 *
 * Script Properties:
 *   AGENT_ENGINE_RESOURCE  projects/<project>/locations/<region>/reasoningEngines/<id>   (required)
 *   TRIAGE_ENV             dev | shadow | prod   (optional; informational)
 *
 * Step definitions (ids, inputs, ops) are GENERATED into Steps.gs by
 * build_manifest.py from triage_agent/models.py. See docs/CONTRACTS.md §13.
 */

// ---------------------------------------------------------------------------
// Configuration cards
// ---------------------------------------------------------------------------

function buildConfigCard_(stepId) {
  var def = STEP_DEFS[stepId];
  var section = CardService.newCardSection().setHeader(def.name);
  if (def.inputs.length === 0) {
    section.addWidget(CardService.newTextParagraph().setText(
      'No inputs. Put this step right after the doorbell starter (Agent Outbox Sheet or doorbell email).'));
  }
  def.inputs.forEach(function (input) {
    var widget = CardService.newTextInput()
      .setFieldName(input.id) // must match the manifest input id
      .setTitle(input.label + (input.required ? ' *' : ''))
      .setHostAppDataSource(
        CardService.newHostAppDataSource().setWorkflowDataSource(
          CardService.newWorkflowDataSource().setIncludeVariables(true)));
    if (input.hint) widget.setHint(input.hint);
    if (CardService.InputMode) {
      widget.setInputMode(input.mode === 'RICH_TEXT' ? CardService.InputMode.RICH_TEXT : CardService.InputMode.PLAIN_TEXT);
    }
    section.addWidget(widget);
  });
  return CardService.newCardBuilder().addSection(section).build();
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

function executeStep_(stepId, e) {
  var def = STEP_DEFS[stepId];
  try {
    var inputs = readInputs_(e, def);
    if (stepId === 'inspect_variables') return inspect_(inputs);
    var missing = def.inputs.filter(function (i) { return i.required && !inputs[i.id]; }).map(function (i) { return i.id; });
    if (missing.length) {
      return errorResponse_('Missing required input(s): ' + missing.join(', ') + '. Map them to starter variables.', true, false);
    }
    var request = {
      op: def.op,
      payload: PAYLOAD_BUILDERS[stepId](inputs),
      context: {
        invoked_by: effectiveUser_(),
        flow: inputs.flow || stepId,
        run_id: Utilities.getUuid(),
        env: prop_('TRIAGE_ENV') || null,
        deliver: 'return',
        targets: parseList_(inputs.targets).length ? parseList_(inputs.targets) : null
      }
    };
    var response = callAgent_(request);
    if (!response.ok && response.retryable) {
      return errorResponse_('The Triage Agent is temporarily unavailable (' + response.error + '). Retrying.', false, true);
    }
    if (!response.ok) {
      return errorResponse_('Triage Agent error: ' + response.error, false, false);
    }
    return outputResponse_(response.outputs || {}, (response.outputs && response.outputs.summary) || def.op);
  } catch (err) {
    console.error(stepId + ' failed: ' + (err && err.stack || err));
    if (err && err.retryable) return errorResponse_('Temporary failure calling the Triage Agent: ' + err.message, false, true);
    if (err && err.actionable) return errorResponse_(err.message, true, false);
    return errorResponse_('Unexpected error: ' + (err && err.message || err), false, false);
  }
}

function readInputs_(e, def) {
  var raw = (e && e.workflow && e.workflow.actionInvocation && e.workflow.actionInvocation.inputs) || {};
  var out = {};
  def.inputs.forEach(function (input) {
    out[input.id] = variableToString_(raw[input.id]);
  });
  return out;
}

function variableToString_(v) {
  if (!v) return '';
  if (v.stringValues && v.stringValues.length) return v.stringValues.join('\n').trim();
  if (v.integerValues && v.integerValues.length) return String(v.integerValues[0]);
  if (v.booleanValues && v.booleanValues.length) return String(v.booleanValues[0]);
  if (v.timestampValues && v.timestampValues.length) return String(v.timestampValues[0]);
  return '';
}

// ---------------------------------------------------------------------------
// Payloads (shapes = triage_agent.models: ChatMessage, ReactionEvent, InboundEmail)
// ---------------------------------------------------------------------------

var PAYLOAD_BUILDERS = {
  triage_alert: function (i) {
    return { message: chatMessage_(i, 'SPACE') };
  },
  record_reaction: function (i) {
    return {
      emoji: i.emoji,
      user: { email: i.reactor_email || null, name: i.reactor_name || null, type: 'HUMAN' },
      message: chatMessage_({ message_text: i.message_text, message_id: i.message_id, message_link: i.message_link, space: i.space }, 'SPACE')
    };
  },
  converse: function (i) {
    var conv = (i.conversation_type || '').toUpperCase();
    if (conv !== 'SPACE' && conv !== 'DM') conv = i.space ? 'SPACE' : 'DM';
    var msg = chatMessage_(i, conv);
    msg.sender.type = 'HUMAN';
    return { message: msg };
  },
  ingest_email: function (i) {
    var from = parseAddress_(i.from);
    return {
      subject: i.subject, from_email: from.email, from_name: from.name, to: parseList_(i.to), cc: parseList_(i.cc),
      body: i.body, message_id: i.message_id || null, thread_id: i.thread_id || null,
      received_at: toIso_(i.received_at), link: i.link || null
    };
  },
  deliver_outbox: function () { return {}; },
  record_post: function (i) {
    return { case_id: i.case_id, message_id: i.message_id || null, message_link: i.message_link || null };
  }
};

function chatMessage_(i, conversationType) {
  var space = (i.space || '').trim();
  var isId = /^spaces\//.test(space) || /^[A-Za-z0-9_-]{11}$/.test(space);
  return {
    message_id: i.message_id || i.message_link || null,
    text: i.message_text || '',
    sender: { name: i.sender_name || null, email: i.sender_email || null, type: 'UNKNOWN' },
    space_id: isId ? space : null,
    space_name: isId ? null : (space || null),
    thread_id: i.thread_id || null,
    link: i.message_link || null,
    create_time: toIso_(i.sent_at),
    conversation_type: conversationType
  };
}

// ---------------------------------------------------------------------------
// Agent Engine call
// ---------------------------------------------------------------------------

function callAgent_(request) {
  var resource = prop_('AGENT_ENGINE_RESOURCE');
  if (!resource) {
    var cfg = new Error('Script Property AGENT_ENGINE_RESOURCE is not set (projects/<p>/locations/<region>/reasoningEngines/<id>).');
    cfg.actionable = true;
    throw cfg;
  }
  var location = resource.split('/')[3];
  var url = 'https://' + location + '-aiplatform.googleapis.com/v1/' + resource + ':query';
  var res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    payload: JSON.stringify({ class_method: 'query', input: request }),
    muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  var text = res.getContentText();
  if (code === 429 || code >= 500) {
    var transient = new Error('HTTP ' + code + ' from Agent Engine');
    transient.retryable = true;
    throw transient;
  }
  if (code >= 400) {
    var bad = new Error('HTTP ' + code + ' from Agent Engine: ' + text.slice(0, 300) +
      (code === 403 ? ' (grant roles/aiplatform.user to the flow owner)' : ''));
    bad.actionable = (code === 403 || code === 404);
    throw bad;
  }
  var body = JSON.parse(text);
  return body.output || body;
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

function outputResponse_(outputs, logText) {
  var map = {};
  OUTPUT_KEYS.forEach(function (key) {
    var value = outputs[key];
    if (value === undefined || value === null) value = key.indexOf('has_') === 0 ? 'no' : '';
    map[key] = AddOnsResponseService.newVariableData().addStringValue(String(value));
  });
  var action = AddOnsResponseService.newReturnOutputVariablesAction()
    .setVariableDataMap(map)
    .setLog(AddOnsResponseService.newWorkflowTextFormat().addTextFormatElement(
      AddOnsResponseService.newTextFormatElement().setText(String(logText || '').slice(0, 500))));
  return render_(action);
}

function errorResponse_(message, actionable, retryable) {
  var action = AddOnsResponseService.newReturnElementErrorAction()
    .setErrorLog(AddOnsResponseService.newWorkflowTextFormat().addTextFormatElement(
      AddOnsResponseService.newTextFormatElement().setText(String(message).slice(0, 500))))
    .setErrorActionability(actionable ? AddOnsResponseService.ErrorActionability.ACTIONABLE
                                      : AddOnsResponseService.ErrorActionability.NOT_ACTIONABLE)
    .setErrorRetryability(retryable ? AddOnsResponseService.ErrorRetryability.RETRYABLE
                                    : AddOnsResponseService.ErrorRetryability.NOT_RETRYABLE);
  return render_(action);
}

function render_(workflowAction) {
  var hostAppAction = AddOnsResponseService.newHostAppAction().setWorkflowAction(workflowAction);
  return AddOnsResponseService.newRenderActionBuilder().setHostAppAction(hostAppAction).build();
}

// ---------------------------------------------------------------------------
// Phase 0: inspect starter variables
// ---------------------------------------------------------------------------

function inspect_(inputs) {
  var seen = {};
  Object.keys(inputs).forEach(function (k) { if (inputs[k]) seen[k] = inputs[k].slice(0, 2000); });
  var json = JSON.stringify(seen, null, 2);
  console.log('Inspect variables: ' + json);
  var action = AddOnsResponseService.newReturnOutputVariablesAction()
    .setVariableDataMap({ summary: AddOnsResponseService.newVariableData().addStringValue(json.slice(0, 4000)) })
    .setLog(AddOnsResponseService.newWorkflowTextFormat().addTextFormatElement(
      AddOnsResponseService.newTextFormatElement().setText(json.slice(0, 1500))));
  return render_(action);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function prop_(name) {
  return PropertiesService.getScriptProperties().getProperty(name);
}

function effectiveUser_() {
  try { return Session.getEffectiveUser().getEmail() || null; } catch (err) { return null; }
}

function parseList_(value) {
  return String(value || '').split(/[,;\n]/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function parseAddress_(value) {
  var s = String(value || '').trim();
  var m = s.match(/^\s*"?([^"<]*)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim() || null, email: m[2].trim() };
  return { name: null, email: s || null };
}

function toIso_(value) {
  var s = String(value || '').trim();
  if (!s) return null;
  if (/^\d{12,}$/.test(s)) return new Date(Number(s)).toISOString(); // TIMESTAMP: ms since epoch
  var d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString();
}
