/**
 * LiveVerify.gs — Standalone, zero-mock live integration test harness for Google Apps Script.
 *
 * Exercises the real live Control tab spreadsheet (`openStore_(false)` / `SpreadsheetApp`), real BigQuery v2 API
 * (`us-central1` Sonar table via `UrlFetchApp` + `ScriptApp.getOAuthToken()`), and real Vertex AI Gemini 3-Step
 * Dual-Track pipeline (`geminiClient_()`), logging real execution output directly via `console.log`.
 * Makes zero mutations to user cells on the live Control tab.
 *
 * verifyFastTriageLive() does the same for the fast triage (Decisions.gs, FastTriage.gs): real Gemini Decisions calls
 * about the real early-wave signals the bot holds right now, through the client the checks use. It writes to no sheet
 * cell and posts nowhere; its output is one LIVE_VERIFY_FAST_TRIAGE line in the log.
 */

const LIVE_VERIFY_FT_MAX_ = 5;  // signals asked about by verifyFastTriageLive (a look, not a load test)

function verifyLookbackAndPipelineLive() {
  const ss = openStore_(false);
  const sheetId = ss.getId();
  const sh = controlTab_(ss);
  if (!sh) throw new Error('Control tab not found on live spreadsheet ' + sheetId);

  ensureBqLookbackRow_(sh);
  const cell = sh.getRange(BQ_LOOKBACK_ROW_, 2);
  const rule = cell.getDataValidation();
  if (!rule) throw new Error('B31 has no DataValidation rule on live Control tab');
  const values = (rule.getCriteriaValues() || [])[0] || [];
  const allowInvalid = rule.getAllowInvalid();
  if (allowInvalid !== false) throw new Error('Expected B31 allowInvalid === false, got ' + allowInvalid);
  if (JSON.stringify(values) !== JSON.stringify(['15 minutes', '30 minutes', '45 minutes', '60 minutes'])) {
    throw new Error('Unexpected B31 dropdown values: ' + JSON.stringify(values));
  }

  const liveControlRead = readControl_(sh);
  const liveResolved = bqLookbackFrom_(liveControlRead.bqLookback);
  const choiceChecks = ['15 minutes', '30 minutes', '45 minutes', '60 minutes'].map(choice => {
    const parsed = bqLookbackFrom_(choice);
    const clamped = bqLookbackMinutes_({ bq_lookback_minutes: parsed.minutes });
    return { choice, minutes: parsed.minutes, clamped, note: parsed.note };
  });
  const zeroCheck = bqLookbackFrom_(0);

  let liveEarlyAlerts15 = [];
  let liveEarlyError = '';
  try {
    liveEarlyAlerts15 = bqEarlyDetectionRows_(15);
  } catch (e) {
    liveEarlyError = String((e && e.message) || e);
  }
  const gemini = geminiClient_();

  const priors = [{
    alert_id: 'QA-LIVE-VERIFY-1',
    url: 'https://x.com/pixelowner/status/1900000000000000001',
    author: '@pixelowner',
    platforms: ['X'],
    product: 'Pixel',
    issue_name: 'Pixel 10 battery swelling',
    engagement: 2800,
    summary: 'User reported Pixel 10 battery swelling on charger.',
  }, {
    alert_id: 'QA-LIVE-VERIFY-2',
    url: 'https://x.com/mapsfan/status/1900000000000000002',
    author: '@mapsfan',
    platforms: ['X'],
    product: 'Google Maps',
    issue_name: 'Maps routing onto a closed bridge',
    engagement: 5200,
    summary: 'Drivers on X reported Google Maps routing onto a closed bridge.',
  }];

  const soloOnlyBatch = [{
    id: 'solo_new_dev',
    url: 'https://x.com/technews/status/1900000000000000010',
    author: '@technews',
    platform: 'X',
    product: 'Pixel',
    issue_name: 'Pixel 10 battery swelling',
    engagement: 3400,
    summary: 'Breaking update: Google confirmed an official battery replacement program for affected Pixel 10 units.',
  }];
  const soloTrackEval = evaluateBqDualTrack_(soloOnlyBatch, null, {
    threshold: 2000,
    waveMin: 2000,
    minWaveAuthors: 5,
    priorAlerts: priors,
    gemini,
  });

  const paraphrasedWaveBatch = [1, 2, 3, 4, 5].map(i => ({
    id: `wave_m${i}`,
    url: `https://x.com/driver${i}/status/190000000000000002${i}`,
    author: `@driver${i}`,
    platform: 'X',
    issue_name: 'Maps routing onto a closed bridge',
    engagement: 450 + i * 25,
    summary: `Commuter #${i} stranded at Elm Street closure because Google Maps still routes cars onto the closed bridge.`,
  }));
  const waveSuppressionEval = evaluateBqDualTrack_(paraphrasedWaveBatch, null, {
    wavesOnly: true,
    threshold: 2000,
    waveMin: 2000,
    minWaveAuthors: 5,
    priorAlerts: priors,
    gemini,
  });

  const summary = {
    sheetId,
    liveRow31: {
      a31: sh.getRange(BQ_LOOKBACK_ROW_, 1).getValue(),
      b31: cell.getValue(),
      c31: sh.getRange(BQ_LOOKBACK_ROW_, 3).getValue(),
      a33: sh.getRange(CONTROL_HELP_ROW_, 1).getValue(),
      dropdownChoices: values,
      allowInvalid,
      resolvedMinutes: liveResolved.minutes,
    },
    choiceChecks,
    zeroCheck,
    liveBigQuery15Min: {
      earlyDetectionPendingReturned: liveEarlyAlerts15.length,
      earlyDetectionError: liveEarlyError || null,
    },
    liveGeminiSoloTrackCheck: {
      by: soloTrackEval.by,
      soloAlerts: soloTrackEval.solo_alerts,
      discardedIds: soloTrackEval.discarded_ids,
    },
    liveGeminiWaveSuppressionCheck: {
      by: waveSuppressionEval.by,
      groupWavesCount: waveSuppressionEval.group_waves.length,
      discardedIds: waveSuppressionEval.discarded_ids,
    },
  };
  console.log('LIVE_VERIFY_RESULT ' + JSON.stringify(summary, null, 2));
  return summary;
}

/**
 * The fast triage, live: one real Gemini Decisions call about each real early-wave signal the bot holds right now
 * (the producer's 3-hour buffer, then the review queue; LIVE_VERIFY_FT_MAX_ at most), through the same client the
 * checks use (the key from Secret Manager, the caps, the pause after a failure). Reads only: nothing is queued,
 * reviewed, posted or written to a sheet (the client counts its own calls in script state, as it always does). Logs,
 * for each signal, what was sent's size, the six answers, the time it took, and what the fast triage does with them
 * (hold back, raise); then the latencies and the day's call counts. No signal at hand: it says so and asks nothing.
 * Run it from the editor.
 */
function verifyFastTriageLive() {
  const props = PropertiesService.getScriptProperties();
  const buffer = ewsReadBuffer_(ewsCache_());
  const queued = edQueueList_(props).map(e => edQueueRow_(props, e.k)).filter(Boolean);
  const ids = new Set();
  const signals = buffer.concat(queued).filter(r => {
    if (!r || !r.alert_id || ids.has(r.alert_id)) return false;
    ids.add(r.alert_id);
    return true;
  }).slice(0, LIVE_VERIFY_FT_MAX_);
  const bars = ftBars_();
  const session = decSession_(() => Infinity, false);
  const results = signals.map(r => {
    const res = decSignalAsk_(r, session);
    return {
      alert_id: r.alert_id,
      signal_type: r.signal_type || '',
      accounts: ewCount_(r.unique_low_tier_authors),
      headline: truncate_(String(r.headline || ''), 120),
      input_chars: decSignalInput_(r).length,
      ok: res.ok,
      why: res.ok ? '' : res.why,
      ms: res.ok ? res.ms : null,
      tokens: res.ok ? res.tokens : null,
      answers: res.ok ? res.dec : null,
      p0_risk_group: ftP0Group_(r),
      never_held_back: ftProtected_(r),
      hold_back: res.ok ? (ftHoldWhy_(r, res.dec, bars) || 'no') : null,
      raise_early: res.ok ? ewsWatchRaise_(res.dec, bars) : null,
    };
  });
  const times = results.filter(x => x.ok).map(x => x.ms).sort((a, b) => a - b);
  const st = decState_(props, Date.now());
  const summary = {
    endpoint: decUrl_(),
    model: DEC_MODEL_,
    signals: { in_buffer: buffer.length, in_queue: queued.length, asked: results.length },
    answered: times.length,
    not_answered: results.filter(x => !x.ok).map(x => `${x.alert_id}: ${x.why}`),
    latency_ms: times.length ? { min: times[0], median: times[Math.floor(times.length / 2)], max: times[times.length - 1] } : null,
    calls_today: { asked: st.asked, failed: st.failed, refused: st.refused, paused_until: st.until ? new Date(st.until).toISOString() : '', why: st.why },
    bars,
    results,
  };
  console.log('LIVE_VERIFY_FAST_TRIAGE ' + JSON.stringify(summary, null, 2));
  return summary;
}
