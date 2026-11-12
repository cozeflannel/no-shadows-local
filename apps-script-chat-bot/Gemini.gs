/**
 * Gemini.gs — Gemini AI client: Direct Vertex AI REST (multimodal + structured JSON), with BigQuery ML remote model
 * fallback (`brand-social-central-data.DSD.gemini_analyzer` via `ML.GENERATE_TEXT`) for text-only calls.
 *
 *   geminiClient_().assess(parsed, {deadline, media, hold})  judgment checks for one alert (Review.gs assessPrompts_ and its
 *                                                      schema: ASSESS_SCHEMA_, plus what a Control tab switch that is ON
 *                                                      asks for, Review.gs assessSchema_), with the post's own video /
 *                                                      audio / image attached when Media.gs finds one and the knowledge
 *                                                      base's documents (parsed.knowledge, Knowledge.gs); media 'still' |
 *                                                      'none' attaches only a still of the post, or nothing (an alert whose
 *                                                      review crashed the run before: Bot.gs crashGuard_); hold: the alert
 *                                                      may wait for the next run if this one is too short for its video
 *   geminiClient_().answer(question, row, resources, knowledge, {deadline})   a Burson-safe answer (Voice.gs answerPrompts_
 *                                                      + ANSWER_SCHEMA_), from the documents Burson can see
 *   geminiClient_().answerAnalyst(q, row, botCtx, knowledge)      an internal analyst answer in the clean-data space,
 *                                                      from the whole knowledge base (botCtx.deadline: the run's time limit)
 *   geminiClient_().synopsis(facts)                    the Results tab's summary, from its numbers only (Speed.gs
 *                                                      resultsSynopsisPrompts_ + RESULTS_SYNOPSIS_SCHEMA_)
 *   geminiClient_().pressCoverage(facts)               Watch sent alerts (Watch.gs): did the news pick up a sent alert's
 *                                                      post? With the web search only (null when it's off)
 *   geminiClient_().teamAnswer(facts, {deadline})      Draft answers to questions (FollowUp.gs): an answer to a team's
 *                                                      question on a Social Alert thread from what the bot knows about the
 *                                                      alert only (no web search), or that it can't answer it
 *
 * Web grounding (settings.web_grounding: enterprise | google | off): the alert review and analyst answers can search the
 * web for what Burson's write-up doesn't say (news coverage, whether a claim or incident is real, who the author is,
 * Google's public statements) with Vertex AI's Web Grounding for Enterprise (`enterpriseWebSearch`, the default) or
 * Grounding with Google Search (`googleSearch`). Gemini 3.x returns the same structured JSON with the tool on. Answers to
 * Burson never search: they stick to the guide and the Resources tab. If Vertex AI refuses the tool (not enabled for the
 * project or model), the call is retried without it and grounding stays off for 6 hours. Searches and sources are logged.
 *
 * Limits on every call: an output cap (generationConfig.maxOutputTokens, thinking included: GEMINI_MAX_TOKENS_) and, on
 * Gemini 3 and later, the thinking level (generationConfig.thinkingConfig.thinkingLevel: GEMINI_THINKING_LEVEL_). An
 * answer cut off at the cap (finish reason MAX_TOKENS) is an error, never read as JSON; any finish reason other than STOP
 * is logged with the call's token counts. The run's time limit (deadline, ms): a call with the post's video or audio is
 * started only with GEMINI_MEDIA_MIN_LEFT_MS_ left, and another try only with GEMINI_RETRY_MIN_LEFT_MS_ left
 * (UrlFetchApp can't be stopped once a call has started). Pictures go whatever time is left, as the alert text does: a
 * review with them takes no longer. A run too short for the video or audio holds the alert for the next run when Bot.gs
 * can (assess opts.hold: it throws an error marked holdReview), else Gemini gets a still of the post. What the review went
 * without, and why, comes back as llm._missed ({label, why: 'time' | 'failed'}) for the analysts' note (Review.gs).
 *
 * Errors throw only if Vertex AI and (text-only calls) BigQuery ML.GENERATE_TEXT are both unavailable; Bot.gs then falls
 * back to the deterministic rules alone (reviews) or the fixed answer (questions).
 */

const BQ_GEMINI_MODEL_ = 'brand-social-central-data.DSD.gemini_analyzer';
const GROUNDING_TOOLS_ = { enterprise: { enterpriseWebSearch: {} }, google: { googleSearch: {} } };
const GROUNDING_OFF_SEC_ = 6 * 3600;
// generationConfig.maxOutputTokens (thinking included): without a cap a call can run to the model's 65,536-token default
// (5-6 minutes, then UrlFetchApp's timeout). 24k gives multimodal reviews headroom above MEDIUM thinking; 8k covers synopsis thinking + text.
const GEMINI_MAX_TOKENS_ = { review: 24576, answer: 8192, press: 8192, synopsis: 8192, other: 8192 };
// generationConfig.thinkingConfig.thinkingLevel, Gemini 3 and later only (Gemini 2.5 refuses it). MEDIUM is the documented
// default of gemini-3.8-flash (Vertex AI "Thinking" page): this changes nothing on today's model and keeps thinking from
// going to HIGH if the model or its default changes.
const GEMINI_THINKING_LEVEL_ = 'MEDIUM';
// The run's time limit: a call with the post's video or audio needs this much left (a review with one can take a minute
// and a half); any try after a call's (or a review's) first one needs GEMINI_RETRY_MIN_LEFT_MS_
const GEMINI_MEDIA_MIN_LEFT_MS_ = 90 * 1000;
const GEMINI_RETRY_MIN_LEFT_MS_ = 45 * 1000;
// BigQuery ML fallback: how long it waits for ML.GENERATE_TEXT (polling jobs.getQueryResults) before cancelling the job
const BQ_GEMINI_WAIT_MS_ = 75 * 1000;
const BQ_GEMINI_POLL_MS_ = 10 * 1000;

function isMaxTokensErr_(e) {
  return /cut off \(MAX_TOKENS\)/.test(String((e && e.message) || e || ''));
}

function geminiClient_() {
  return {
    assess(parsed, opts) {
      const deadline = Number(opts && opts.deadline) || 0;  // the run's time limit (ms), when there is one
      const left = () => (deadline ? deadline - Date.now() : Infinity);
      const mediaTime = () => left() >= GEMINI_MEDIA_MIN_LEFT_MS_;
      const grounding = webGroundingMode_();
      const review = (m, over) => {  // one Gemini call, with the post's media (m) or the alert text alone (null)
        const p = assessPrompts_(parsed, m);
        const o = Object.assign({ grounding, deadline, maxOutputTokens: GEMINI_MAX_TOKENS_.review }, over || {});
        const out = geminiGenerate_(p.system, p.prompt, p.schema || ASSESS_SCHEMA_, m
          ? Object.assign(o, { parts: m.parts, tries: 1, mediaResolution: m.kind === 'image' ? null : 'MEDIA_RESOLUTION_LOW' })
          : o);
        if (m && out && typeof out === 'object' && !Array.isArray(out)) out._media = { label: m.label, kind: m.kind };
        if (parsed && parsed.transcript && parsed.transcript.text && out && typeof out === 'object' && !Array.isArray(out)) {
          out._transcript = {
            label: parsed.transcript.label,
            kind: parsed.transcript.kind || 'video',
            source: parsed.transcript.source || 'google_speech_stt',
            duration_s: parsed.transcript.duration_s || null,
          };
        }
        return out;
      };
      const short = () => `less than ${GEMINI_MEDIA_MIN_LEFT_MS_ / 1000} s left in this run (${secondsLeft_(left())} s)`;
      // What the review may attach (Bot.gs crashGuard_): 'full' the post's own media as below; 'still' only a still of the
      // post (stillMedia_: Burson's screenshot, a frame of the video); 'none' the alert text alone. A review that crashed
      // the run with more gets less next time.
      const allow = opts && (opts.media === 'still' || opts.media === 'none') ? opts.media : 'full';
      const isClip = m => !!m && /^(?:video|audio)$/.test(String(m.kind || ''));
      let missed = null;  // what of the post the review went without, and why ('time' | 'failed'): Review.gs mediaMissedNote_
      // The run is too short for the post's video or audio (`clip`, named): the caller holds the alert for the next run
      // when it can (opts.hold: Bot.gs runOnce_), else Gemini gets a still of the post instead, and analysts are told
      const tooShort = clip => {
        if (opts && opts.hold) {
          const e = new Error(`${short()}, not enough for ${clip}`);
          e.holdReview = true;
          throw e;
        }
        console.warn(`${short()}: Gemini doesn't get ${clip}, only a still of the post`);
        missed = { label: clip, why: 'time' };
        try { return stillMedia_(parsed); } catch (e) { return null; }
      };
      const staged = [];  // the Cloud Storage copies of big videos made for this review: deleted after it
      let media = null;
      try {
        // Only a clip needs GEMINI_MEDIA_MIN_LEFT_MS_: pictures (photos, a frame, a cover, Burson's screenshot) go whatever
        // time is left, since a review with them takes no longer than one without (Oct 21-24: 127 reviews with photos,
        // median 37 s, p95 80 s; 72 from the text alone, median 46 s, p95 133 s). Short of that time, nothing is
        // downloaded or copied for a clip.
        if (allow === 'still') {
          media = stillMedia_(parsed);
        } else if (allow === 'full') {
          const clip = mediaTime() ? '' : reviewClipOf_(parsed);
          media = clip ? tooShort(clip) : mediaFor_(parsed.fields, undefined, {
            bq: parsed && parsed.bq, post: parsed && parsed.post,
            screenshotUrl: bursonScreenshotUrl_(parsed),  // never one of a sign-in prompt (Post.gs)
            picturesOnly: !mediaTime(),  // a clip a page shows only in its meta tags isn't fetched
          });
        }
      } catch (e) {
        if (e && e.holdReview) throw e;
        media = null;
      }
      if (media && media.staged) staged.push.apply(staged, media.staged);
      const withMissed = out => {
        if (missed && out && typeof out === 'object' && !Array.isArray(out)) out._missed = missed;
        return out;
      };
      const retryOver = () => ({
        thinkingLevel: thinkingLevelFor_(GEN.models.triage) ? 'LOW' : '',
        temperature: 0.3,
      });
      let tried = false;  // a call with media was made: the text-only review is then another try
      try {
        // A clip whose lookup or Cloud Storage copy took the time it needed (as above)
        if (isClip(media) && !mediaTime()) media = tooShort(media.label);
        // Extract Google text transcript for any video or audio clip so the LLM always receives the spoken words,
        // even when the clip is >50 MB, >1 min, short on run time (<90 s), or fails direct multimodal streaming.
        if (parsed && typeof extractMediaTranscript_ === 'function') {
          try {
            const tr = extractMediaTranscript_(parsed, {
              media,
              allowDownload: mediaTime(),
            });
            if (tr && tr.text) {
              parsed.transcript = tr;
              console.log(`extracted ${tr.kind} transcript (${tr.source}) for ${tr.label}`);
            }
          } catch (e) {}
        }
        // Gemini can't open the video or audio (private, too big or too long, blocked): a still picture of the post
        // (Burson's screenshot, a frame of the video), then the alert text alone. Never a call with a clip that could run
        // past the run's time limit.
        if (media) {
          tried = true;
          try {
            return withMissed(review(media));
          } catch (e) {
            if (isMaxTokensErr_(e) && !isClip(media) && left() >= GEMINI_RETRY_MIN_LEFT_MS_) {
              try {
                console.warn(`Gemini hit MAX_TOKENS with ${media.label}; retrying concise review with ${media.label}`);
                return withMissed(review(media, retryOver()));
              } catch (e2) {
                e = e2;
              }
            }
            console.warn(`Gemini couldn't review ${media.label} (${(e && e.message) || e})`);
          }
          if (!missed) missed = { label: media.label, why: 'failed' };
          // the still only with time for it and, if it fails too, the text-only review
          let still = null;
          try { still = !isClip(media) || !mediaTime() ? null : stillMedia_(parsed); } catch (e) { still = null; }
          if (still && mediaTime()) {
            try {
              return withMissed(review(still));
            } catch (e) {
              if (isMaxTokensErr_(e) && left() >= GEMINI_RETRY_MIN_LEFT_MS_) {
                try {
                  return withMissed(review(still, retryOver()));
                } catch (e2) {
                  e = e2;
                }
              }
              console.warn(`Gemini couldn't review ${still.label} (${(e && e.message) || e})`);
            }
          }
          console.warn('reviewing the alert text only');
        }
        if (tried && left() < GEMINI_RETRY_MIN_LEFT_MS_) {
          const err = new Error(`no time left in this run for the text-only review (${secondsLeft_(left())} s left)`);
          if (opts && opts.hold) err.holdReview = true;
          throw err;
        }
        try {
          return withMissed(review(null));
        } catch (e) {
          if (isMaxTokensErr_(e) && left() >= GEMINI_RETRY_MIN_LEFT_MS_) {
            console.warn('Gemini hit MAX_TOKENS on text-only review; retrying concise review');
            return withMissed(review(null, retryOver()));
          }
          throw e;
        }
      } finally {
        if (staged.length) unstageMedia_(staged);  // the Cloud Storage copy of a big video is only for this review
      }
    },
    answer(question, alertRow, resources, knowledge, opts) {  // Burson-facing: no web search; only documents Burson can see
      const p = answerPrompts_(question, alertRow, resources, knowledge);
      const out = geminiGenerate_(p.system, p.prompt, ANSWER_SCHEMA_,
        { maxOutputTokens: GEMINI_MAX_TOKENS_.answer, deadline: opts && opts.deadline });
      return String((out && out.answer) || '');
    },
    answerAnalyst(question, alertRow, botCtx, knowledge) {
      const p = answerAnalystPrompts_(question, alertRow, botCtx, knowledge);
      const out = geminiGenerate_(p.system, p.prompt, ANSWER_SCHEMA_, { grounding: webGroundingMode_(),
        maxOutputTokens: GEMINI_MAX_TOKENS_.answer, deadline: botCtx && botCtx.deadline });
      return String((out && out.answer) || '');
    },
    // No web search, and no BigQuery ML fallback: when Gemini can't write it, the tab has its own computed summary
    synopsis(facts) {
      const p = resultsSynopsisPrompts_(facts);
      const out = geminiGenerate_(p.system, p.prompt, RESULTS_SYNOPSIS_SCHEMA_,
        { tries: 2, allowBqFallback: false, maxOutputTokens: GEMINI_MAX_TOKENS_.synopsis });
      return String((out && out.synopsis) || '');
    },
    // Only with the web search (without it there's nothing to go on), one try, and no BigQuery ML fallback (it can't search)
    pressCoverage(facts) {
      const grounding = webGroundingMode_();
      if (!grounding) return null;
      const p = watchPressPrompts_(facts);
      return geminiGenerate_(p.system, p.prompt, WATCH_PRESS_SCHEMA_,
        { grounding, tries: 1, allowBqFallback: false, maxOutputTokens: GEMINI_MAX_TOKENS_.press });
    },
    // Draft answers to questions (FollowUp.gs): no web search, only what the bot knows about the alert, so it can say it
    // doesn't know; {can_answer, confidence, answer, missing}
    teamAnswer(facts, opts) {
      const p = followupAnswerPrompts_(facts);
      return geminiGenerate_(p.system, p.prompt, FOLLOWUP_ANSWER_SCHEMA_,
        { maxOutputTokens: GEMINI_MAX_TOKENS_.answer, deadline: opts && opts.deadline });
    },
    // The 3-step BigQuery evaluation (BigQuery.gs evaluateBqDualTrack_, bqAlertPrompts_ + BQ_ALERT_BATCH_SCHEMA_): which
    // records pass Step 1 (a substantive Google connection, no passive slang, the Resources tab's guidelines, nothing
    // already alerted on unless it's a new development) and, for the Early wave check, which go together as a wave.
    // {solo_alerts, group_waves, discarded_ids}; the caller adds up every number from the records itself
    analyzeBqRecords(records, knowledge, guidance, opts) {
      const p = bqAlertPrompts_(records, knowledge, guidance, opts && opts.priorAlerts, opts);
      return geminiGenerate_(p.system, p.prompt, p.schema || BQ_ALERT_BATCH_SCHEMA_,
        { maxOutputTokens: GEMINI_MAX_TOKENS_.review, deadline: opts && opts.deadline });
    },
  };
}

/** Whole seconds left (never below 0) of `ms`, for the log. Pure. */
function secondsLeft_(ms) {
  return Math.max(0, Math.round((Number(ms) || 0) / 1000));
}

/** The web-search tool for reviews and analyst answers (settings.web_grounding), or '' when off or refused lately. */
function webGroundingMode_() {
  const S = (typeof GEN !== 'undefined' && GEN.settings) || {};
  const mode = String(S.web_grounding === undefined ? 'enterprise' : (S.web_grounding || 'off')).trim().toLowerCase();
  if (!GROUNDING_TOOLS_[mode]) return '';
  try {
    if (CacheService.getScriptCache().get('grounding_off:' + mode)) return '';
  } catch (e) {}
  return mode;
}

/** Vertex AI refused the web-search tool: say why, and leave it off for a while (the call is retried without it). */
function groundingRefused_(mode, why) {
  console.warn(`Gemini web grounding (${mode}) was refused, so it's off for ${GROUNDING_OFF_SEC_ / 3600} h: ${why}`);
  try { CacheService.getScriptCache().put('grounding_off:' + mode, '1', GROUNDING_OFF_SEC_); } catch (e) {}
}

function geminiUrl_(model, location, project) {
  const loc = location || 'global';
  const host = loc === 'global' ? 'aiplatform.googleapis.com' : `${loc}-aiplatform.googleapis.com`;
  return `https://${host}/v1/projects/${project}/locations/${loc}/publishers/google/models/${model}:generateContent`;
}

/**
 * The thinking level to send for a model: GEMINI_THINKING_LEVEL_ for Gemini 3 and later text models ("gemini-3.8-flash",
 * "gemini-4-…"), '' for anything else (Gemini 2.5 and earlier return an error when it's set; the image models take other
 * levels). Pure.
 */
function thinkingLevelFor_(model) {
  const m = String(model || '').trim().toLowerCase().match(/^gemini-(\d+)(?:\.\d+)?-/);
  if (!m || Number(m[1]) < 3 || /image|banana|live|tts|embedding/.test(String(model).toLowerCase())) return '';
  return GEMINI_THINKING_LEVEL_;
}

/**
 * opts.parts: media parts sent before the text (Media.gs); opts.mediaResolution: e.g. 'MEDIA_RESOLUTION_LOW';
 * opts.grounding: 'enterprise' | 'google' (the web-search tool);
 * opts.maxOutputTokens: the output cap (thinking included); opts.thinkingLevel: 'LOW' | 'MEDIUM' | 'HIGH' (Gemini 3+).
 */
function geminiPayload_(system, prompt, schema, opts) {
  const o = opts || {};
  const temp = o.temperature !== undefined && o.temperature !== null ? Number(o.temperature) : GEN.models.temperature;
  const generationConfig = { temperature: temp, responseMimeType: 'application/json', responseSchema: schema };
  if (o.mediaResolution) generationConfig.mediaResolution = o.mediaResolution;
  if (Number(o.maxOutputTokens) > 0) generationConfig.maxOutputTokens = Math.round(Number(o.maxOutputTokens));
  if (o.thinkingLevel) generationConfig.thinkingConfig = { thinkingLevel: String(o.thinkingLevel) };
  const payload = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: (o.parts || []).concat([{ text: prompt }]) }],
    generationConfig,
  };
  const tool = GROUNDING_TOOLS_[o.grounding] || null;
  if (tool) payload.tools = [tool];
  return payload;
}

/**
 * SQL-native fallback via BigQuery `ML.GENERATE_TEXT` against `brand-social-central-data.DSD.gemini_analyzer`
 * (using the `brand-social-central-data.us.gemini-connection` remote model) when Direct Vertex AI REST is unreachable
 * or rate-limited and the request is text-only. The query is waited on (jobs.getQueryResults) up to BQ_GEMINI_WAIT_MS_
 * (and never past `deadline`, ms), then cancelled: a job given up on isn't left running.
 */
function bqGeminiFallback_(system, prompt, schema, deadline) {
  if (typeof parseBqRows_ !== 'function' || typeof BQ_API_BASE_ === 'undefined') throw new Error('BigQuery.gs not loaded');
  const fullPrompt = [
    system,
    '',
    'REQUIRED OUTPUT JSON SCHEMA:',
    JSON.stringify(schema),
    '',
    'Return ONLY valid JSON matching the schema above, with no markdown fences or extra commentary.',
    '',
    prompt,
  ].join('\n');
  const sql = [
    'SELECT ml_generate_text_llm_result AS res',
    `FROM ML.GENERATE_TEXT(MODEL \`${BQ_GEMINI_MODEL_}\`,`,
    '  (SELECT @prompt AS prompt),',
    '  STRUCT(0.1 AS temperature, 8192 AS max_output_tokens, TRUE AS flatten_json_output)',
    ')',
  ].join('\n');
  const until = Math.min(Date.now() + BQ_GEMINI_WAIT_MS_, Number(deadline) > 0 ? Number(deadline) - 15 * 1000 : Infinity);
  const rows = parseBqRows_(bqGeminiJob_(sql, fullPrompt, until));
  const raw = rows && rows[0] && rows[0].res ? String(rows[0].res).trim() : '';
  if (!raw) throw new Error('BigQuery ML.GENERATE_TEXT returned empty output');
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  return JSON.parse(cleaned);
}

/**
 * Runs the ML.GENERATE_TEXT query (jobs.query), then waits on it (jobs.getQueryResults, BQ_GEMINI_POLL_MS_ at a time) until
 * it's done or `until` (ms) has passed: the finished jobs.query-style response, or an error once the job was cancelled
 * (jobs.cancel). Throws on an HTTP error or a failed job.
 */
function bqGeminiJob_(sql, prompt, until) {
  const call = (method, url, body) => {
    const resp = UrlFetchApp.fetch(url, Object.assign({
      method, muteHttpExceptions: true, headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    }, body ? { contentType: 'application/json', payload: JSON.stringify(body) } : {}));
    const code = resp.getResponseCode();
    const text = resp.getContentText() || '';
    if (code < 200 || code >= 300) throw new Error(`BigQuery HTTP ${code}: ${text.slice(0, 240)}`);
    return text ? JSON.parse(text) : {};
  };
  const waitMs = () => Math.max(1000, Math.min(BQ_GEMINI_POLL_MS_, until - Date.now()));
  const maxBytes = typeof BQ_MAX_BYTES_BILLED_ !== 'undefined' ? BQ_MAX_BYTES_BILLED_ : String(10 * 1024 * 1024 * 1024);
  if (typeof apiGuardNote_ === 'function') apiGuardNote_('bigquery', 1);
  let res = call('post', `${BQ_API_BASE_}${GCP_PROJECT}/queries`, {
    query: sql, useLegacySql: false, timeoutMs: waitMs(), maximumBytesBilled: maxBytes, parameterMode: 'NAMED',
    queryParameters: [{ name: 'prompt', parameterType: { type: 'STRING' }, parameterValue: { value: String(prompt) } }],
  });
  const job = (res && res.jobReference) || {};
  const where = job.location ? `location=${encodeURIComponent(job.location)}` : '';
  const jobUrl = `${BQ_API_BASE_}${encodeURIComponent(job.projectId || GCP_PROJECT)}`;
  // Each jobs.getQueryResults waits up to BQ_GEMINI_POLL_MS_ for the job; the count is only a backstop
  for (let polls = 0; res && !res.jobComplete && job.jobId && Date.now() < until && polls < 30; polls++) {
    res = call('get', `${jobUrl}/queries/${encodeURIComponent(job.jobId)}?${where ? where + '&' : ''}timeoutMs=${waitMs()}`);
  }
  if (res && res.jobComplete) return res;  // a job that failed is an HTTP error above
  if (job.jobId) {
    try {
      call('post', `${jobUrl}/jobs/${encodeURIComponent(job.jobId)}/cancel${where ? '?' + where : ''}`);
    } catch (e) {
      console.warn(`couldn't cancel the BigQuery ML job ${job.jobId}: ${(e && e.message) || e}`);
    }
  }
  throw new Error(`BigQuery ML.GENERATE_TEXT didn't finish in time; its job${job.jobId ? ` ${job.jobId}` : ''} was cancelled`);
}

/**
 * One Gemini call: Vertex AI (3 tries on 429 / 5xx unless opts.tries says otherwise), then BigQuery ML for a text-only
 * call (unless opts.allowBqFallback is false or settings.bq_gemini_fallback is off). opts.deadline (ms): the run's time
 * limit (a call with a video or audio clip needs GEMINI_MEDIA_MIN_LEFT_MS_ left at every try, any other try after the
 * first GEMINI_RETRY_MIN_LEFT_MS_; a call with pictures goes as a text-only one does; out of time, it throws without the
 * fallback). opts.maxOutputTokens defaults to GEMINI_MAX_TOKENS_.other.
 */
function geminiGenerate_(system, prompt, schema, opts) {
  const o = Object.assign({}, opts || {});
  const hasMedia = Array.isArray(o.parts) && o.parts.length > 0;
  // A video or audio clip can make a call run long; pictures don't (assess)
  const hasClip = hasMedia && o.parts.some(p => /^(?:video|audio)\//i.test(String(((p && (p.fileData || p.inlineData)) || {}).mimeType || '')));
  if (!(Number(o.maxOutputTokens) > 0)) o.maxOutputTokens = GEMINI_MAX_TOKENS_.other;
  if (o.thinkingLevel === undefined) o.thinkingLevel = thinkingLevelFor_(GEN.models.triage);
  const deadline = Number(o.deadline) || 0;
  const left = () => (deadline ? deadline - Date.now() : Infinity);
  // Not enough of the run left for this try: a call with a clip (any try), or another try after the first
  const noTime = first => (hasClip && left() < GEMINI_MEDIA_MIN_LEFT_MS_) || (!first && left() < GEMINI_RETRY_MIN_LEFT_MS_);
  const bqFallback = !hasMedia && o.allowBqFallback !== false &&
    (typeof GEN === 'undefined' || !GEN.settings || GEN.settings.bq_gemini_fallback !== false);
  const v429 = typeof apiGuardVertex429Active_ === 'function' && apiGuardVertex429Active_();
  // During a brief post-429 Vertex cooldown, text calls with BigQuery ML fallback skip 3x Vertex retry amplification and
  // route straight to BigQuery ML first so SLA alerts finish faster without hammering a rate-limited endpoint
  if (v429 && bqFallback && left() >= GEMINI_RETRY_MIN_LEFT_MS_) {
    try {
      return bqGeminiFallback_(system, prompt, schema, deadline);
    } catch (bqErr) {
      console.warn(`BigQuery ML fallback during Vertex 429 cooldown failed: ${(bqErr && bqErr.message) || bqErr}`);
    }
  }
  const url = geminiUrl_(GEN.models.triage, GEN.models.location, GCP_PROJECT);
  const paramsFor = () => ({
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    payload: JSON.stringify(geminiPayload_(system, prompt, schema, o)),
  });
  let params = paramsFor();
  const tries = v429 ? 1 : (o.tries || 3);
  let last = '';
  let calls = 0;
  let got429 = 0;
  let late = false;  // stopped by the run's time limit
  let refused = null;  // the web-search tool got a 4xx: retried once without it
  for (let attempt = 1; attempt <= tries; attempt++) {
    if (noTime(calls === 0)) { late = true; break; }
    calls++;
    if (typeof apiGuardNote_ === 'function') apiGuardNote_('gemini', 1);
    let code = 0;
    let text = '';
    try {
      const resp = UrlFetchApp.fetch(url, params);
      code = resp.getResponseCode();
      text = resp.getContentText() || '';
    } catch (e) {  // network error / timeout
      code = 599;
      text = String((e && e.message) || e);
    }
    if (code === 429) got429++;
    if (code !== 429 && code < 500) {
      // A 4xx with the web-search tool on: once more without it, when the error is about the tool (or nothing else in
      // the request could be: no media). A media error goes straight back to assess(), which retries text-only.
      if (code >= 300 && o.grounding && (!hasMedia || /search|ground|tool|enterprise|retriev/i.test(text))) {
        refused = { mode: o.grounding, why: `${code} ${text.slice(0, 200)}` };
        o.grounding = '';
        params = paramsFor();
        attempt--;
        continue;
      }
      if (code >= 300) throw new Error(`Gemini ${code}: ${text.slice(0, 300)}`);
      if (v429 && typeof apiGuardClearVertex429_ === 'function') apiGuardClearVertex429_();
      if (refused) groundingRefused_(refused.mode, refused.why);  // it worked without the tool: the tool was the problem
      const body = JSON.parse(text);
      const finish = geminiFinishNote_(body);
      if (finish) console.warn(`Gemini ${finish}`);
      const out = parseGeminiJson_(body);
      const web = webSources_(body);
      if (web) {
        console.log(`Gemini web search: ${web.queries.join(' | ') || '(no queries)'}; sources: ` +
          `${web.sources.map(s => s.title || s.uri).join(', ') || 'none'}`);
        if (out && typeof out === 'object' && !Array.isArray(out)) out._web = web;
      }
      return out;
    }
    last = `${code} ${text.slice(0, 200)}`;
    if (attempt < tries) {
      const pause = 1500 * attempt;
      if (deadline && left() - pause < GEMINI_RETRY_MIN_LEFT_MS_) { late = true; break; }
      Utilities.sleep(pause);
    }
  }
  if (!v429 && calls > 0 && got429 === calls && typeof apiGuardNoteVertex429_ === 'function') {
    apiGuardNoteVertex429_();
  }
  // Fallback: SQL-native BigQuery ML.GENERATE_TEXT (`brand-social-central-data.DSD.gemini_analyzer`) for text-only calls,
  // as another try (only with GEMINI_RETRY_MIN_LEFT_MS_ left of the run, and skipped when already tried above on v429)
  const runBqFallback = bqFallback && !v429;
  if (runBqFallback && !late && noTime(false)) late = true;
  if (late) {
    const s = secondsLeft_(left());
    throw new Error(calls ? `Gemini unavailable after ${calls} of ${tries} tries, no time left in this run for another try (${s} s left): ${last}`
      : `Gemini not called: not enough time left in this run (${s} s)`);
  }
  if (runBqFallback) {
    try {
      return bqGeminiFallback_(system, prompt, schema, deadline);
    } catch (bqErr) {
      // The Vertex error below is the one reported; the fallback's own failure goes in the log
      console.warn(`BigQuery ML fallback failed: ${(bqErr && bqErr.message) || bqErr}`);
    }
  }

  throw new Error(`Gemini unavailable after ${tries} tries: ${last}`);
}

/**
 * Why a generateContent response stopped, when it isn't the natural end (STOP), with its token counts: "finish reason
 * MAX_TOKENS · tokens: 31,204 in, 2,950 thinking, 13,434 out, 47,588 total", or '' for STOP. Pure.
 */
function geminiFinishNote_(body) {
  const cand = ((body && body.candidates) || [])[0];
  const reason = cand ? String(cand.finishReason || 'none') : 'none (no answer)';
  if (/^(?:FINISH_REASON_)?STOP$/.test(reason)) return '';
  const u = (body && body.usageMetadata) || {};
  const n = v => Number(v || 0).toLocaleString('en-US');
  const counts = [[u.promptTokenCount, 'in'], [u.thoughtsTokenCount, 'thinking'], [u.candidatesTokenCount, 'out'],
    [u.totalTokenCount, 'total']].filter(c => c[0] !== undefined && c[0] !== null).map(c => `${n(c[0])} ${c[1]}`);
  return `finish reason ${reason}${counts.length ? ` · tokens: ${counts.join(', ')}` : ''}`;
}

/** generateContent response -> the JSON object Gemini returned (thought parts skipped). Pure. */
function parseGeminiJson_(body) {
  const cand = ((body && body.candidates) || [])[0];
  if (!cand) {
    const blocked = body && body.promptFeedback && body.promptFeedback.blockReason;
    throw new Error('Gemini returned no answer' + (blocked ? ` (blocked: ${blocked})` : ''));
  }
  // Cut off at the output cap: whatever JSON there is is incomplete
  if (/^(?:FINISH_REASON_)?MAX_TOKENS$/.test(String(cand.finishReason || ''))) throw new Error('Gemini\'s answer was cut off (MAX_TOKENS)');
  const text = ((cand.content && cand.content.parts) || [])
    .filter(p => !p.thought && typeof p.text === 'string').map(p => p.text).join('').trim();
  if (!text) throw new Error(`Gemini returned no text (finish reason: ${cand.finishReason || 'unknown'})`);
  try {
    return JSON.parse(text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
  } catch (e) {
    throw new Error('Gemini returned invalid JSON: ' + text.slice(0, 200));
  }
}

/** The web searches behind a grounded answer: {queries, sources: [{title, uri}]}, or null when it didn't search. Pure. */
function webSources_(body) {
  const cand = ((body && body.candidates) || [])[0] || {};
  const gm = cand.groundingMetadata || {};
  const queries = (gm.webSearchQueries || []).map(q => String(q || '').trim()).filter(Boolean).slice(0, 6);
  const sources = (gm.groundingChunks || []).map(c => c.web || c.retrievedContext || {})
    .map(w => ({ title: String(w.title || w.domain || '').trim(), uri: String(w.uri || '').trim() }))
    .filter(s => s.title || s.uri).slice(0, 8);
  return queries.length || sources.length ? { queries, sources } : null;
}
