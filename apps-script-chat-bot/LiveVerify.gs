/**
 * LiveVerify.gs — Standalone, zero-mock live integration test harness for Google Apps Script.
 *
 * Exercises the real live Control tab spreadsheet (`openStore_(false)` / `SpreadsheetApp`), real BigQuery v2 API
 * (`us-central1` Sonar table via `UrlFetchApp` + `ScriptApp.getOAuthToken()`), and real Vertex AI Gemini 3-Step
 * Dual-Track pipeline (`geminiClient_()`), logging real execution output directly via `console.log`.
 * Makes zero mutations to user cells on the live Control tab.
 */

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
