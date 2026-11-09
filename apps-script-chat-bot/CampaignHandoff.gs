/**
 * CampaignHandoff.gs - Option A thread-ownership router for Brandwatch deep dives and alert campaigns.
 *
 * When a human replies in an alert thread in the configured Mirror alerts space (Control tab B9) asking for a
 * Brandwatch deep dive or an alert campaign, this module records ownership in Firestore Native database
 * slrr-social-alerts (collection thread_ownership), posts a single plain-text handoff confirmation in the thread,
 * and skips the thread on all subsequent polls so slrr-campaigns owns the thread exclusively.
 */

const CAMPAIGN_CLIENT_PREFIX_ = 'client-scmp-';
const CAMPAIGN_FIRESTORE_DB_ = 'slrr-social-alerts';
const CAMPAIGN_OWNERSHIP_COLLECTION_ = 'thread_ownership';
const CAMPAIGN_HANDOFF_REPLY_ = 'Campaign assistant now owns this thread and will reply shortly.';

const CAMPAIGN_DIRECT_RX_ = new RegExp(
  '\\b(?:' +
  'deep[- ]?dive|' +
  'alert\\s+campaign|focused\\s+deep\\s+dive|' +
  'brandwatch\\s+(?:deep|report|query|alert|campaign|volume|mentions|breakdown)|' +
  'custom\\s+alert|' +
  '(?:start|create|run|launch|spin\\s+up|set\\s+up|open|build|make)\\s+' +
    '(?:a\\s+|an\\s+|new\\s+|dedicated\\s+|topic\\s+|focused\\s+)*' +
    '(?:campaign|custom\\s+alert|alert\\s+space|monitoring\\s+space)|' +
  'campaign\\s+(?:for|on|about|around|tracking|space)|' +
  'dig\\s+deeper\\s+(?:in\\s+brandwatch|into\\s+(?:this|the))|' +
  'pull\\s+(?:a\\s+|the\\s+)?(?:brandwatch|mention|volume)\\s+(?:report|breakdown)' +
  ')\\b',
  'i'
);

const CAMPAIGN_CANDIDATE_RX_ = new RegExp(
  '\\b(?:' +
  'brandwatch|dedicated\\s+space|own\\s+space|' +
  'monitor\\s+this|keep\\s+tracking|ongoing\\s+alerts?|' +
  'volume\\s+(?:over|in\\s+the\\s+last|in\\s+the\\s+past)' +
  ')\\b',
  'i'
);

const CAMPAIGN_ROUTE_SCHEMA_ = {
  type: 'OBJECT',
  properties: {
    route_to_campaigns: { type: 'BOOLEAN' },
  },
  required: ['route_to_campaigns'],
};

function campaignAlertsSpace_(ctx) {
  if (!ctx || !ctx.outboundBlocked || ctx.sourceReadOnly || (ctx.settings && ctx.settings.dry_run)) return '';
  const space = String((ctx.spaces && ctx.spaces.burson && ctx.spaces.burson.id) || '').trim();
  if (space && !isSfBurson_(ctx.sfBurson, space)) return space;
  return '';
}

function campaignDocId_(threadName) {
  const raw = String(threadName || '').trim();
  const cleaned = raw.replace(/\//g, '__');
  if (cleaned && cleaned.length <= 120) return cleaned;
  return sha256Hex_(raw);
}

function campaignFirestoreBaseUrl_() {
  const projectId = (typeof GEN !== 'undefined' && GEN.gcp && GEN.gcp.project_id) || 'brand-social-central-data';
  return 'https://firestore.googleapis.com/v1/projects/' + encodeURIComponent(projectId) +
    '/databases/' + encodeURIComponent(CAMPAIGN_FIRESTORE_DB_) +
    '/documents/' + CAMPAIGN_OWNERSHIP_COLLECTION_;
}

function isCampaignOwnedThread_(ctx, space, thread) {
  const targetSpace = campaignAlertsSpace_(ctx);
  if (!targetSpace || space !== targetSpace || !thread) return false;
  const docId = campaignDocId_(thread);
  const runMap = (ctx && (ctx._campaignCheckedThreads || (ctx._campaignCheckedThreads = new Map()))) || null;
  if (runMap && runMap.has(docId)) return runMap.get(docId);

  const cache = CacheService.getScriptCache();
  const cacheKey = 'scmp_owned:' + docId;
  if (cache.get(cacheKey) === '1') {
    if (runMap) runMap.set(docId, true);
    return true;
  }

  const url = campaignFirestoreBaseUrl_() + '/' + encodeURIComponent(docId);
  const resp = UrlFetchApp.fetch(url, {
    method: 'get',
    muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
  });
  const code = resp.getResponseCode();
  if (code === 200) {
    cache.put(cacheKey, '1', 21600);
    if (runMap) runMap.set(docId, true);
    return true;
  }
  if (code === 404) {
    if (runMap) runMap.set(docId, false);
    return false;
  }
  const detail = String(resp.getContentText() || '').slice(0, 300);
  console.error(JSON.stringify({
    event: 'campaign_ownership_read_failed',
    space: space,
    thread: thread,
    status_code: code,
    detail: detail,
  }));
  throw new Error('Failed to inspect thread_ownership for ' + thread + ' (HTTP ' + code + ')');
}

function classifyCampaignCandidate_(text) {
  const projectId = (typeof GEN !== 'undefined' && GEN.gcp && GEN.gcp.project_id) || 'brand-social-central-data';
  const url = geminiUrl_('gemini-3.8-flash', 'global', projectId);
  const payload = {
    systemInstruction: {
      parts: [{
        text: 'Classify whether this Google Chat thread reply asks for (a) a Brandwatch deep-dive/volume report or ' +
          '(b) a dedicated topic-focused Brandwatch alert campaign or space. Return route_to_campaigns=true only for ' +
          'those requests, and false for ordinary triage questions, drafts, or status checks.',
      }],
    },
    contents: [{ role: 'user', parts: [{ text: text }] }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 2048,
      thinkingConfig: { thinkingLevel: 'LOW' },
      responseMimeType: 'application/json',
      responseSchema: CAMPAIGN_ROUTE_SCHEMA_,
    },
  };
  const resp = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
  });
  const code = resp.getResponseCode();
  if (code >= 300) {
    console.error(JSON.stringify({
      event: 'campaign_intent_classify_failed',
      status_code: code,
      detail: String(resp.getContentText() || '').slice(0, 300),
    }));
    throw new Error('Vertex AI campaign classification failed (HTTP ' + code + ')');
  }
  const parsed = JSON.parse(resp.getContentText() || '{}');
  const rawPart = (((parsed.candidates || [])[0] || {}).content || {}).parts || [];
  const jsonText = rawPart.filter(p => !p.thought && typeof p.text === 'string').map(p => p.text).join('').trim();
  const obj = jsonText ? JSON.parse(jsonText) : {};
  return Boolean(obj.route_to_campaigns);
}

function isCampaignHandoffRequest_(ctx, space, m) {
  const targetSpace = campaignAlertsSpace_(ctx);
  if (!targetSpace || space !== targetSpace || !m || !m.threadReply || !m.thread) return false;
  if (m.senderType !== 'HUMAN' || !m.senderName || m.clientId) return false;
  if (isOwnMessage_(ctx, m)) return false;
  if (typeof relayedFrom_ === 'function' && relayedFrom_(ctx, m)) return false;

  const memo = (ctx && (ctx._campaignIntentByMsg || (ctx._campaignIntentByMsg = new Map()))) || null;
  if (memo && memo.has(m.name)) return memo.get(m.name);

  let cleaned = String(m.text || '').trim();
  if (typeof RELAY_INTERNAL_RX_ !== 'undefined') {
    cleaned = cleaned.replace(RELAY_INTERNAL_RX_, '').trim();
  }
  if (!cleaned) {
    if (memo) memo.set(m.name, false);
    return false;
  }
  let matched = CAMPAIGN_DIRECT_RX_.test(cleaned);
  if (!matched && CAMPAIGN_CANDIDATE_RX_.test(cleaned)) {
    matched = classifyCampaignCandidate_(cleaned);
  }
  if (memo) memo.set(m.name, matched);
  return matched;
}

function handOffThreadToCampaigns_(ctx, space, m) {
  const docId = campaignDocId_(m.thread);
  const runMap = (ctx && (ctx._campaignCheckedThreads || (ctx._campaignCheckedThreads = new Map()))) || null;
  if (runMap && runMap.get(docId) === true) return;

  let alertText = '';
  const root = chatThreadRoot_(space, m.thread);
  if (root) {
    alertText = String(root.text || root.cardText || '').trim();
  }

  let cleanedSource = String(m.text || '').trim();
  if (typeof RELAY_INTERNAL_RX_ !== 'undefined') {
    cleanedSource = cleanedSource.replace(RELAY_INTERNAL_RX_, '').trim();
  }

  const createUrl = campaignFirestoreBaseUrl_() + '?documentId=' + encodeURIComponent(docId);
  const body = {
    fields: {
      space: { stringValue: String(space) },
      thread: { stringValue: String(m.thread) },
      requester: { stringValue: String(m.senderName) },
      source_message: { stringValue: String(m.name) },
      source_text: { stringValue: cleanedSource },
      alert_text: { stringValue: alertText },
      created_at: { stringValue: new Date().toISOString() },
      handled_initial: { booleanValue: false },
    },
  };

  const resp = UrlFetchApp.fetch(createUrl, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(body),
    muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
  });
  const code = resp.getResponseCode();
  if (code >= 300 && code !== 409) {
    const detail = String(resp.getContentText() || '').slice(0, 300);
    console.error(JSON.stringify({
      event: 'campaign_handoff_write_failed',
      space: space,
      thread: m.thread,
      source_message: m.name,
      status_code: code,
      detail: detail,
    }));
    chatPostMessage_(
      space,
      'Campaign handoff failed while saving thread ownership (HTTP ' + code + '). Please retry shortly.',
      { thread: m.thread, key: 'campaign-handoff-err:' + m.name }
    );
    throw new Error('Failed to write thread_ownership for ' + m.thread + ' (HTTP ' + code + ')');
  }

  CacheService.getScriptCache().put('scmp_owned:' + docId, '1', 21600);
  if (runMap) runMap.set(docId, true);

  const reply = chatPostMessage_(
    space,
    CAMPAIGN_HANDOFF_REPLY_,
    { thread: m.thread, key: 'campaign-handoff:' + m.thread }
  );
  if (ctx && ctx.store && reply && reply.name) {
    ctx.store.markDone(reply.name, 'own_post');
  }
  console.log(JSON.stringify({
    event: 'campaign_thread_handed_off',
    space: space,
    thread: m.thread,
    requester: m.senderName,
    source_message: m.name,
    reply_message: (reply && reply.name) || '',
  }));
}
