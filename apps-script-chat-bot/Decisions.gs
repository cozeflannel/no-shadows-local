/**
 * Decisions.gs — the Gemini Decisions client behind the early-wave fast triage (Control row 38, Fast triage).
 *
 * The Decisions API answers typed questions about one input with calibrated probabilities and writes no text, so the
 * bot can rank and filter early-wave signals on numbers before the full Gemini review (which still runs before every
 * card: nothing is posted, emailed or drafted on a Decisions answer). FastTriage.gs decides what the answers are used
 * for; this file only asks.
 *
 * What it does
 *   decisionsAsk_(input, questions, session) makes ONE call and returns {ok: true, answers, tokens, ms}, or
 *   {ok: false, why} with `skipped` (it didn't ask: a cap, a pause, too little of the run left) or `refused` (the API's
 *   safety filter turned the input down). It never throws. decSignalAsk_(row, session) asks the fast triage's six
 *   questions (decSignalQuestions_) about one signal.
 *
 * What it sends
 *   The model's name, the questions and one input string. The only input the bot builds is decSignalInput_(row): the
 *   signal's kind, its headline, how many accounts and posts, the platforms' names, its time window, and up to
 *   ED_POSTS_MAX_ post snippets, each with its platform and posting time. The builder reads only those fields of the
 *   row and cleans the two free-text ones (the headline and the snippets: public post text) of links, email
 *   addresses, @handles, u/ names, Chat resource names and digit runs of DEC_ID_DIGITS_ or more. So it never sends an
 *   author's handle, name or id, a link, an email address, a Chat space or message id, anything from the sheet, the
 *   Resources or Guidance knowledge base, an incident manager's name, a Burson write-up or anything from Gmail.
 *   The questions are fixed text, written from the team's own definitions already in this project: the producer's
 *   entity and homonym lists and risk-term groups (EarlyWaveSource.gs), the official Exposure Tags and their
 *   descriptions (GEN.exposure_tags) and the review's own guidance on escalate / monitor / dismiss
 *   (EarlyDetection.gs edReviewPrompts_). Nothing about a signal is in them.
 *
 * The key
 *   An AI Studio API key, the latest version of DEC_SECRET_ in Secret Manager, read with the script's own
 *   cloud-platform token as ProactiveWatch.gs pwBwToken_ reads its token: once a check, kept in memory for that check
 *   only, sent in the x-goog-api-key header (never in a URL), never logged or written anywhere; an error message that
 *   repeats it has it cut out.
 *
 * Limits
 *   Background work only: a call starts only with DEC_MIN_LEFT_MS_ of the run left, never while SLA triage is catching
 *   up, at most DEC_MAX_PER_CHECK_ a check and DEC_MAX_PER_DAY_ a day, and under ApiGuard.gs's own rolling ceilings for
 *   the `decisions` kind (API_GUARD_DECISIONS_10M_ / _60M_). An input is at most DEC_INPUT_MAX_CHARS_ characters. Each
 *   call is counted before it is made, so a run that dies mid-call still counts.
 *
 * When it fails (fail open)
 *   A missing key, an HTTP error (rate limit, quota, server error), an answer that can't be read, a network error or a
 *   call slower than DEC_SLOW_MS_ (UrlFetchApp has no timeout to set, so a slow call is counted as failed once it is
 *   back) is logged once, counted, and pauses every call for DEC_PAUSE_MS_; decStatusText_ puts the pause and its reason
 *   in the switch's Control note (C38). The safety filter refusing one input (HTTP 400, code `safety` and its kin: posts
 *   about self-harm are the likely case) is counted and that signal goes on without an answer, with no pause: the next
 *   signal is another input. Either way the caller gets {ok: false} and handles the signal exactly as it did before
 *   the fast triage. No retry, ever.
 *
 * Measured (Nov 13, 2026: 14 real calls, one at a time from a laptop, with the documentation's own example text as
 * input): the six questions below answered in 0.25-0.46 s (median 0.35 s, p90 0.41 s) and cost 2,941 input tokens
 * (2,200 of them the Exposure Tag descriptions), so a signal is about 3,300-3,700 tokens and a full check of
 * DEC_MAX_PER_CHECK_ calls about 5 seconds. DEC_SLOW_MS_ is 20 times the slowest call seen and DEC_MIN_LEFT_MS_ twice
 * DEC_SLOW_MS_; both wait for timings from inside Apps Script (the live check, LiveVerify.gs verifyFastTriageLive)
 * to be tightened. The API's errors, as recorded: a bad key is HTTP 400 with status INVALID_ARGUMENT; a bad request is
 * HTTP 400 with code `invalid_request` and the rule it broke.
 */

// The endpoint, defined once. Decisions is on the Gemini Developer API only for now; when it reaches Vertex AI these
// three lines and decKey_ (the credential) are all that change, and no caller is touched
const DEC_BASE_URL_ = 'https://generativelanguage.googleapis.com';
const DEC_API_VERSION_ = 'v1beta';
const DEC_MODEL_ = 'gemini-decision-1';
const DEC_SECRET_ = 'agentic_assistant';     // the API key's secret in Secret Manager (in GCP_PROJECT); only its name is here

const DEC_MIN_LEFT_MS_ = 20 * 1000;          // a call starts only with this much of the run left (as ED_PICTURE_MIN_LEFT_MS_)
const DEC_SLOW_MS_ = 10 * 1000;              // a call that took longer counts as failed: the fast triage must stay fast
const DEC_PAUSE_MS_ = 15 * 60 * 1000;        // after a failure no call is made for this long (one early-wave check interval)
const DEC_MAX_PER_CHECK_ = 15;               // calls an early-wave check (queue candidates and early-watch stories together)
const DEC_MAX_PER_DAY_ = 150;                // calls a day: about 72 queue candidates a day (Nov 11-13) plus the early watch
const DEC_MAX_PER_DAY_ALLOWANCE_ = 300;      // calls a day while the Auto-correct flow's allowance is on (BigQuery.gs
                                             // edAllowance_: every candidate is asked, ~136 signals a day on Nov 15); every
                                             // other flow, and the setting at 0, keep DEC_MAX_PER_DAY_
const DEC_INPUT_MAX_CHARS_ = 4000;           // the input's JSON: a headline, the counts and 8 snippets of 280 characters
const DEC_HEADLINE_CHARS_ = 200;             // of the signal's headline
const DEC_ID_DIGITS_ = 8;                    // a run of this many digits is taken for an id and cut (a CVE number has 4-7)
const DEC_STATE_PROP_ = 'DECISIONS_STATE';   // {day, asked, failed, refused, until, why[, cap]}: today's calls and the pause
const DEC_REFUSAL_CODES_ = ['safety', 'prohibited_content', 'blocklist', 'image_safety', 'content_blocked'];  // HTTP 400: the input was refused

// The fast triage's questions (decSignalQuestions_): their keys, and the severity rubric's levels (ED_SEVERITIES_)
const DEC_Q_ABOUT_ = 'about_google';
const DEC_Q_RISK_ = 'brand_risk';
const DEC_Q_INDEPENDENT_ = 'independent_reports';
const DEC_Q_NOISE_ = 'routine_noise';
const DEC_Q_CATEGORY_ = 'category';
const DEC_Q_SEVERITY_ = 'severity';
const DEC_OTHER_RISK_ = 'other risk';        // the category for a risk no Exposure Tag describes
const DEC_NO_CATEGORY_ = 'none';             // the category for no brand-safety issue at all

// ---------------------------------------------------------------------------------------------------------------
// Today's calls and the pause (script property DEC_STATE_PROP_)
// ---------------------------------------------------------------------------------------------------------------

/**
 * Today's Decisions calls: {day, asked, failed, refused, until (ms: no call before it), why (the last failure)}, and
 * `cap` only when today's last call was made under a daily cap other than DEC_MAX_PER_DAY_ (the allowance's
 * DEC_MAX_PER_DAY_ALLOWANCE_: decStatusText_ names that cap). A new day starts the counts again; a pause still running
 * is kept. Never throws.
 */
function decState_(props, now) {
  const day = dayKey_();
  let s = null;
  try { s = JSON.parse(props.getProperty(DEC_STATE_PROP_) || 'null'); } catch (e) { s = null; }
  if (!s || typeof s !== 'object' || Array.isArray(s)) s = {};
  const num = v => Math.max(0, Math.floor(Number(v) || 0));
  const until = num(s.until);
  const paused = until > (Number(now) || Date.now());
  const same = s.day === day;
  const out = {
    day,
    asked: same ? num(s.asked) : 0,
    failed: same ? num(s.failed) : 0,
    refused: same ? num(s.refused) : 0,
    until: paused ? until : 0,
    why: paused || same ? String(s.why || '') : '',
  };
  if (same && num(s.cap)) out.cap = num(s.cap);
  return out;
}

/** Saves today's Decisions calls. Never throws. */
function decSaveState_(props, st) {
  try {
    props.setProperty(DEC_STATE_PROP_, JSON.stringify(st));
  } catch (e) {
    console.error('Gemini Decisions: could not save today\'s calls: ' + ((e && e.message) || e));
  }
}

/**
 * The Decisions calls as the switch's Control note says them: "12 asked today · 1 refused by the safety filter ·
 * paused until 12:40 PM (HTTP 429: too_many_requests): signals go on without it", or '' when none was made today
 * and nothing is paused. Never throws.
 */
function decStatusText_(props, now) {
  try {
    const t = Number(now) || Date.now();
    const st = decState_(props, t);
    const parts = [];
    if (st.asked) parts.push(`${fmtInt_(st.asked)} asked today`);
    if (st.refused) parts.push(`${fmtInt_(st.refused)} refused by the safety filter`);
    if (st.failed) parts.push(`${fmtInt_(st.failed)} failed`);
    if (st.until > t) {
      const tz = (typeof GEN !== 'undefined' && GEN && GEN.timezone) || 'America/New_York';
      parts.push(`paused until ${Utilities.formatDate(new Date(st.until), tz, 'h:mm a')}` +
        `${st.why ? ` (${st.why})` : ''}: signals go on without it`);
    } else if (st.asked >= (st.cap || DEC_MAX_PER_DAY_)) {
      parts.push(`daily cap of ${st.cap || DEC_MAX_PER_DAY_} reached, more tomorrow`);
    }
    return parts.join(' \u00b7 ');
  } catch (e) {
    return '';
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The call
// ---------------------------------------------------------------------------------------------------------------

/**
 * A check's session with the Decisions API: {left: () => ms of the run left, busy: SLA triage is catching up, key: the
 * API key once read (in memory, this check only), asked: calls made this check, perDay: the day's cap}. `perDay` is
 * DEC_MAX_PER_DAY_ unless a positive number is given (the Auto-correct flow's allowance gives
 * DEC_MAX_PER_DAY_ALLOWANCE_). Pure.
 */
function decSession_(left, busy, perDay) {
  const cap = Math.floor(Number(perDay));
  return {
    left: typeof left === 'function' ? left : () => Infinity, busy: !!busy, key: '', asked: 0,
    perDay: isFinite(cap) && cap > 0 ? cap : DEC_MAX_PER_DAY_,
  };
}

/**
 * The API key: the latest version of DEC_SECRET_ in Secret Manager, read with the script's own cloud-platform token and
 * billed to GCP_PROJECT (as ProactiveWatch.gs pwBwToken_). Never kept, logged or written anywhere. Throws with what
 * went wrong.
 */
function decKey_() {
  const resp = UrlFetchApp.fetch(
    `https://secretmanager.googleapis.com/v1/projects/${GCP_PROJECT}/secrets/${DEC_SECRET_}/versions/latest:access`, {
      muteHttpExceptions: true,
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken(), 'x-goog-user-project': GCP_PROJECT },
    });
  const code = resp.getResponseCode();
  if (code !== 200) throw new Error(`no API key (Secret Manager HTTP ${code})`);
  let data = '';
  try { data = String(((JSON.parse(resp.getContentText() || '{}') || {}).payload || {}).data || ''); } catch (e) { data = ''; }
  const key = data ? Utilities.newBlob(Utilities.base64Decode(data)).getDataAsString().trim() : '';
  if (!key) throw new Error('no API key (the secret is empty)');
  return key;
}

/** The Decisions endpoint (no key in it: the key goes in a header). Pure. */
function decUrl_() {
  return `${DEC_BASE_URL_}/${DEC_API_VERSION_}/decisions`;
}

/**
 * Why no call is made right now ('' when one may be): SLA triage is catching up, a pause after a failure, a cap (the
 * check's or the day's), ApiGuard's rolling ceilings, or too little of the run left. Never throws.
 */
function decSkipWhy_(session, st, now) {
  if (session.busy) return 'the alerts come first';
  if (st.until > now) return `paused after a failure${st.why ? ` (${st.why})` : ''}`;
  // the open engine (row 51, step S11): no count a check or a day; the day's quick-look ceiling (openMayStart_ below),
  // ApiGuard's runaway ceilings and the run's time bound the calls. OFF: the counts, as before
  const open = typeof openOn_ === 'function' && openOn_();
  if (!open && session.asked >= DEC_MAX_PER_CHECK_) return `${DEC_MAX_PER_CHECK_} calls this check`;
  const perDay = session.perDay || DEC_MAX_PER_DAY_;
  if (!open && st.asked >= perDay) return `${perDay} calls today`;
  if (typeof apiGuardAllowDecisions_ === 'function' && !apiGuardAllowDecisions_(now)) return 'too many calls lately';
  if (session.left() < DEC_MIN_LEFT_MS_) return 'too little of the run left';
  // the open engine (Control row 51, OpenEngine.gs): the day's quick-look ceiling, the run-time and outside-call steps;
  // with row 51 OFF it always says yes
  if (typeof openMayStart_ === 'function') {
    const may = openMayStart_('quick', null);
    if (!may.ok) return may.why;
  }
  return '';
}

/**
 * One answer as the bot reads it, or null when it isn't the answer to question `q`:
 *   noul    {type, p (the probability of yes), confidence}
 *   choice  {type, choice (one of the question's options), p (its probability), probabilities, confidence}
 *   score   {type, score (the probability-weighted level), level (the most probable one), probabilities: [per level],
 *            confidence}
 * Pure.
 */
function decAnswer_(a, q) {
  if (!a || typeof a !== 'object' || Array.isArray(a) || !q || a.type !== q.type) return null;
  const unit = v => (v !== null && v !== undefined && v !== '' && isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 1 ? Number(v) : null);
  if (q.type === 'noul') {
    const p = unit(a.noul);
    if (p === null) return null;
    const c = unit(a.confidence);
    return { type: 'noul', p, confidence: c === null ? Math.max(p, 1 - p) : c };
  }
  const probs = a.probabilities && typeof a.probabilities === 'object' && !Array.isArray(a.probabilities) ? a.probabilities : null;
  if (!probs) return null;
  if (q.type === 'choice') {
    const options = Object.keys(q.criteria || {});
    const choice = String(a.choice === undefined || a.choice === null ? '' : a.choice);
    if (options.indexOf(choice) < 0) return null;
    const out = {};
    options.forEach(o => { const p = unit(probs[o]); if (p !== null) out[o] = p; });
    const p = unit(probs[choice]);
    if (p === null) return null;
    const c = unit(a.confidence);
    return { type: 'choice', choice, p, probabilities: out, confidence: c === null ? p : c };
  }
  if (q.type === 'score') {
    const levels = Array.isArray(q.criteria) ? q.criteria.length : 0;
    const score = Number(a.score);
    if (!levels || a.score === null || a.score === undefined || !isFinite(score) || score < 0 || score > levels - 1) return null;
    const list = [];
    for (let i = 0; i < levels; i++) {
      const p = unit(probs[String(i)]);
      if (p === null) return null;
      list.push(p);
    }
    let level = 0;
    list.forEach((p, i) => { if (p > list[level]) level = i; });
    const c = unit(a.confidence);
    return { type: 'score', score, level, probabilities: list, confidence: c === null ? list[level] : c };
  }
  return null;
}

/**
 * What an HTTP answer says: {ok: true, answers, tokens, ms}; {ok: false, refused: true, why} when the safety filter
 * turned the input down; {ok: false, why} for anything else (an error status, a body that isn't the answers to
 * `questions`, a call slower than DEC_SLOW_MS_). Pure.
 */
function decRead_(code, text, questions, ms) {
  let body = null;
  try { body = JSON.parse(String(text || '') || 'null'); } catch (e) { body = null; }
  if (code !== 200) {
    const err = body && typeof body === 'object' && body.error && typeof body.error === 'object' ? body.error : {};
    const name = [err.code, err.status].map(v => String(v === undefined || v === null ? '' : v).trim())
      .filter(v => v && v !== String(code))[0] || '';
    const label = truncate_(name.replace(/[^A-Za-z0-9_ -]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase(), 40);
    if (code === 400 && DEC_REFUSAL_CODES_.indexOf(label) >= 0) {
      return { ok: false, refused: true, why: `the safety filter refused the input (${label})`, ms };
    }
    return { ok: false, why: `HTTP ${code}${label ? `: ${label}` : ''}`, ms };
  }
  const fb = body && typeof body === 'object' && body.prompt_feedback && typeof body.prompt_feedback === 'object' ? body.prompt_feedback : null;
  const block = fb && fb.block_reason
    ? truncate_(String(fb.block_reason).replace(/[^A-Za-z0-9_ -]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase(), 40) : '';
  if (block) return { ok: false, refused: true, why: `the safety filter refused the input (${block})`, ms };
  const got = body && typeof body === 'object' && body.answers && typeof body.answers === 'object' && !Array.isArray(body.answers)
    ? body.answers : null;
  if (!got) return { ok: false, why: 'an answer that couldn\'t be read', ms };
  const answers = {};
  for (const k of Object.keys(questions)) {
    const a = decAnswer_(got[k], questions[k]);
    if (!a) return { ok: false, why: `an answer that couldn't be read (${k})`, ms };
    answers[k] = a;
  }
  if (ms > DEC_SLOW_MS_) return { ok: false, why: `a slow answer (${Math.round(ms / 1000)} s)`, ms };
  const tokens = Number(body.usage && body.usage.total_input_tokens);
  return { ok: true, answers, tokens: isFinite(tokens) && tokens > 0 ? Math.round(tokens) : 0, ms };
}

/**
 * Asks the Decisions API `questions` ({key: {type, instructions, criteria}}) about `input` (one string) in ONE call,
 * within the check's `session` (decSession_). {ok: true, answers: {key: decAnswer_}, tokens, ms}, or {ok: false, why}:
 * with `skipped` when no call was made (decSkipWhy_, or nothing to ask), with `refused` when the safety filter turned
 * the input down (counted, no pause), else a failure (logged, counted, every call paused for DEC_PAUSE_MS_). Never
 * retries and never throws; the key never leaves this function but in its request header.
 */
function decisionsAsk_(input, questions, session) {
  const s = session || decSession_();
  let key = '';
  const clean = v => {
    const t = String(v === undefined || v === null ? '' : v);
    return truncate_((key ? t.split(key).join('[key]') : t).replace(/\s+/g, ' ').trim(), 120);
  };
  try {
    const text = typeof input === 'string' ? input.trim() : '';
    if (!text || !questions || typeof questions !== 'object' || !Object.keys(questions).length) {
      return { ok: false, skipped: true, why: 'nothing to ask' };
    }
    const props = PropertiesService.getScriptProperties();
    const now = Date.now();
    const st = decState_(props, now);
    const skip = decSkipWhy_(s, st, now);
    if (skip) return { ok: false, skipped: true, why: skip };
    let out = null;
    try {
      key = s.key || decKey_();
      s.key = key;
    } catch (e) {
      out = { ok: false, why: clean((e && e.message) || e) || 'no API key' };
    }
    if (!out) {
      // Counted before the call is made: a run that dies mid-call still counts toward every cap
      s.asked++;
      st.asked++;
      if (typeof openCount_ === 'function') openCount_('ql', 1);  // row 51: one toward the day's quick-look ceiling
      if (typeof engAdd_ === 'function') engAdd_('qAsked', 1);
      if ((s.perDay || DEC_MAX_PER_DAY_) !== DEC_MAX_PER_DAY_) st.cap = s.perDay; else delete st.cap;
      decSaveState_(props, st);
      if (typeof apiGuardNote_ === 'function') apiGuardNote_('decisions', 1);
      try {
        const t0 = Date.now();
        const resp = UrlFetchApp.fetch(decUrl_(), {
          method: 'post',
          contentType: 'application/json',
          muteHttpExceptions: true,
          headers: { 'x-goog-api-key': key },
          payload: JSON.stringify({ model: DEC_MODEL_, input: text, questions }),
        });
        out = decRead_(resp.getResponseCode(), resp.getContentText(), questions, Date.now() - t0);
      } catch (e) {
        out = { ok: false, why: clean((e && e.message) || e) || 'no answer' };
      }
    }
    if (out.ok) return out;
    out.why = clean(out.why);
    if (out.refused) {
      st.refused++;
    } else {
      st.failed++;
      // the open engine (row 51, step S6): the pause is one check's interval, as it is today
      const pause = typeof openCheckMs_ === 'function' ? openCheckMs_() : DEC_PAUSE_MS_;
      st.until = Date.now() + pause;
      st.why = out.why;
      console.warn(`Gemini Decisions: ${out.why}; no calls for ${Math.round(pause / 60000)} minutes (signals go on without it)`);
    }
    decSaveState_(props, st);
    return out;
  } catch (e) {
    return { ok: false, why: clean((e && e.message) || e) || 'no answer' };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The input: one function builds everything the bot ever sends about a signal
// ---------------------------------------------------------------------------------------------------------------

/**
 * Public post text (a headline or a snippet) as it may be sent: no link, email address, @handle, u/ name, Chat
 * resource name or digit run of DEC_ID_DIGITS_ or more (an account or post id), on one line, `max` characters at
 * most. Pure.
 */
function decCleanText_(s, max) {
  const text = String(s === undefined || s === null ? '' : s)
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, ' ')
    .replace(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,10}\/\S*/gi, ' ')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, ' ')
    .replace(/(^|[^A-Za-z0-9_])@[A-Za-z0-9_][A-Za-z0-9_.-]*/g, '$1 ')
    .replace(/(^|[^A-Za-z0-9_])u\/[A-Za-z0-9_-]+/gi, '$1 ')
    .replace(/\b(?:spaces|users|messages|threads|members)\/[A-Za-z0-9_.-]+/gi, ' ')
    .replace(new RegExp(`\\d{${DEC_ID_DIGITS_},}`, 'g'), ' ')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return truncate_(text, max);
}

/** A timestamp as it may be sent ('2026-11-13T15:10:00Z', '2026-11-13 15:10 UTC'), or '' when it isn't one. Pure. */
function decTime_(s) {
  const m = String(s === undefined || s === null ? '' : s).trim()
    .match(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d{1,3})?(?:Z| UTC|[+-]\d{2}:?\d{2})?$/);
  return m ? m[0] : '';
}

/** A platform's name as it may be sent ('X', 'Owned Social'), or '' when it isn't a plain name. Pure. */
function decPlatform_(s) {
  const name = String(s === undefined || s === null ? '' : s).replace(/\s+/g, ' ').trim();
  return /^[A-Za-z][A-Za-z .&/-]{0,29}$/.test(name) && !/\b(?:spaces|users|messages|threads|members|go|u)\//i.test(name) ? name : '';
}

/** How long a window is, as a named bucket (the API compares names better than numbers), or ''. Pure. */
function decSpanWords_(start, end) {
  const a = Date.parse(String(start || '').replace(' UTC', 'Z').replace(' ', 'T'));
  const b = Date.parse(String(end || '').replace(' UTC', 'Z').replace(' ', 'T'));
  if (!isFinite(a) || !isFinite(b) || b < a) return '';
  const mins = (b - a) / 60000;
  return mins < 15 ? 'within 15 minutes' : mins < 60 ? 'within an hour' : mins < 180 ? 'within 3 hours'
    : mins < 720 ? 'within 12 hours' : mins < 1440 ? 'within a day' : 'over more than a day';
}

/**
 * Everything the bot sends the Decisions API about a signal (`row`: an EarlyWaveRow or a queued compact row), as one
 * JSON string of DEC_INPUT_MAX_CHARS_ at most (fewer snippets when it would be longer), or '' when the row has
 * neither a headline nor a snippet:
 *   {signal, headline, accounts, posts, platforms: [names], window: {start, end, length}, pace (a velocity spike's),
 *    snippets: [{platform, posted_at, text}]}
 * Only these fields are read from the row; the headline and the snippets are public post text, cleaned by
 * decCleanText_. Nothing else can get in: no author, link, id, email address or internal text. Pure.
 */
function decSignalInput_(row) {
  const r = row && typeof row === 'object' ? row : {};
  const count = v => (isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v)) : 0);
  const sig = String(r.signal_type || 'CLUSTER_EMERGENCE').trim().toUpperCase();
  const posts = edRepPosts_(Array.isArray(r.posts) ? r.posts : r.representative_posts_json).slice(0, ED_POSTS_MAX_);
  const snippets = posts.map(p => {
    const o = {};
    const platform = decPlatform_(p.platform);
    const at = decTime_(p.published_at);
    if (platform) o.platform = platform;
    if (at) o.posted_at = at;
    o.text = decCleanText_(p.snippet, EWS_SNIPPET_CHARS_);
    return o;
  }).filter(o => o.text);
  const headline = decCleanText_(r.headline, DEC_HEADLINE_CHARS_);
  if (!headline && !snippets.length) return '';
  const accounts = count(r.unique_low_tier_authors);
  const platforms = String(r.platforms_csv || '').split(',').map(decPlatform_).filter(Boolean)
    .filter((p, i, all) => all.indexOf(p) === i).slice(0, 12);
  const start = decTime_(r.window_start_utc);
  const end = decTime_(r.window_end_utc);
  const ratio = Number(r.velocity_ratio);
  const out = {
    signal: sig === 'VELOCITY_SPIKE' ? 'a jump in the accounts posting on one topic'
      : typeof EWS_WATCH_SIGNAL_ !== 'undefined' && sig === EWS_WATCH_SIGNAL_
        ? 'a few accounts starting to tell the same story'
        : 'several accounts telling the same story',
    headline,
    accounts,
    posts: Math.max(accounts, count(r.mention_count)),
    platforms,
  };
  if (start || end) {
    out.window = {};
    if (start) out.window.start = start;
    if (end) out.window.end = end;
    const span = decSpanWords_(start, end);
    if (span) out.window.length = span;
  }
  if (sig === 'VELOCITY_SPIKE' && isFinite(ratio) && ratio > 0) {
    out.pace = ratio >= 10 ? '10 times the usual pace or more' : ratio >= 5 ? '5 to 10 times the usual pace'
      : ratio >= 3 ? '3 to 5 times the usual pace' : 'under 3 times the usual pace';
  }
  out.snippets = snippets;
  let json = JSON.stringify(out);
  while (json.length > DEC_INPUT_MAX_CHARS_ && out.snippets.length > 1) {
    out.snippets = out.snippets.slice(0, -1);
    json = JSON.stringify(out);
  }
  return json.length > DEC_INPUT_MAX_CHARS_ ? '' : json;
}

// ---------------------------------------------------------------------------------------------------------------
// The questions: fixed text from the team's own definitions
// ---------------------------------------------------------------------------------------------------------------

/**
 * The severity rubric: ED_SEVERITIES_' five levels, lowest first. The project names the levels but nowhere says what
 * each means, and the API needs a description a level, so each is put together from definitions the team already
 * uses: the review's `dismiss`, `monitor` and `escalate` (EarlyDetection.gs edReviewPrompts_) and the Exposure Tags'
 * P2 and P0 tiers (a P0 tag is escalated at any size). Pure.
 */
function decSeverityLevels_() {
  const words = {
    none: 'not a brand-safety issue for Google: an unrelated keyword or homonym, disconnected everyday gripes, routine ' +
      'one-off troubleshooting with no broader incident, fan or promotional content, edited or doctored memes, or ' +
      'copy-paste spam making no real claim about Google.',
    low: 'criticism or a complaint of the kind the lowest-priority Exposure Tags describe (general criticism, a feature ' +
      'request, a meme, a publisher or hardware gripe, a known long-running complaint), with no sign of a wider incident.',
    medium: 'something real may be starting to coalesce: an unverified claim, early bug reports, or a multi-account ' +
      'spike whose root cause is unclear.',
    high: 'multiple independent users converge on a concrete, credible emerging issue for Google: new product breakage, ' +
      'an outage or regression, account lockouts, a security or privacy exposure, a scam or malware using a Google ' +
      'product, a coordinated boycott or backlash, viral misinformation about Google, or an executive or employee ' +
      'flashpoint.',
    critical: 'an issue the team escalates at any size: dangerous or harmful AI or Search output, child safety or ' +
      'self-harm, offensive or explicit results, perceived bias, a data breach or private data exposed, threats to the ' +
      'physical safety of Googlers or campuses, whistleblower or employee misconduct allegations, or backlash against ' +
      'one of Google\'s own posts or ads.',
  };
  return ED_SEVERITIES_.map(level => `${level}: ${words[level]}`);
}

/**
 * The category options: every official Exposure Tag (GEN.exposure_tags) under its own name with its own description,
 * then DEC_OTHER_RISK_ and DEC_NO_CATEGORY_. The producer's six risk-term groups (EWS_RISK_GROUPS_) are word lists for
 * the same ground, and their tiers are the tags' priorities, so a tag's priority says which tier an answer is in
 * (decP0Mass_). An option key is 1-128 characters with no space at either end (the API's rule). Pure.
 */
function decCategoryOptions_() {
  const out = {};
  ((typeof GEN !== 'undefined' && GEN && GEN.exposure_tags) || []).forEach(t => {
    const name = String((t && t.name) || '').replace(/\s+/g, ' ').trim();
    const what = String((t && t.description) || '').replace(/\s+/g, ' ').trim();
    if (name && name.length <= 128 && !Object.prototype.hasOwnProperty.call(out, name)) out[name] = what;
  });
  out[DEC_OTHER_RISK_] = 'A risk to Google\'s reputation that none of the other options describes.';
  out[DEC_NO_CATEGORY_] = 'No brand-safety issue for Google: praise, promotion, routine chatter, an unrelated keyword or ' +
    'homonym, or posts that are not about Google.';
  return out;
}

/**
 * The fast triage's six questions about a signal, all asked in one request (the API answers each on its own and never
 * sees the keys, so each instruction is the whole question; the fields named are decSignalInput_'s):
 *   about_google, brand_risk, independent_reports, routine_noise (yes / no), category (one option), severity (a rubric).
 * Their words are the team's own: the producer's entity and homonym lists (EWS_ENTITY_RX_, EWS_STRIP_RX_), the
 * review's guidance on what to escalate, monitor and dismiss (EarlyDetection.gs edReviewPrompts_), the Exposure Tags
 * (GEN.exposure_tags) and ED_SEVERITIES_. Pure.
 */
function decSignalQuestions_() {
  const q = {};
  q[DEC_Q_ABOUT_] = {
    type: 'noul',
    instructions: 'Are the posts in `snippets` about Google or Alphabet: the company, one of its executives, or one of its ' +
      'products or services?',
    criteria: {
      true_description: 'They are about Google or Alphabet, an executive of theirs, or a product or service of theirs, such ' +
        'as Search, AI Overviews, Gemini, Pixel, Android, Chrome, Chromebook, YouTube, Gmail, Workspace, Maps, Waze, ' +
        'Photos, Drive, Cloud, Play, Pay, Wallet, Ads, Nest, Fitbit, Waymo, DeepMind, NotebookLM, Veo or Imagen.',
      false_description: 'An unrelated keyword or homonym: the generic verb ("google it"), Gemini the star sign (season, ' +
        'moon, rising, horoscope, zodiac), Chrome Hearts or chrome wheels and rims, a store badge ("Available on Google ' +
        'Play", "Get it on Google Play"), or posts about something else entirely.',
    },
  };
  q[DEC_Q_RISK_] = {
    type: 'noul',
    instructions: 'Do the posts in `snippets` describe a problem, harm, accusation, security or safety issue, outage, or ' +
      'legal or policy controversy that could damage Google\'s reputation?',
    criteria: {
      true_description: 'A concrete issue for Google: product breakage, an outage or a regression, account lockouts, ' +
        'dangerous or harmful AI or Search output, a security or privacy exposure, a scam or malware using a Google ' +
        'product, a boycott or backlash, misinformation about Google, an executive or employee flashpoint, or a lawsuit, ' +
        'antitrust or layoffs controversy.',
      false_description: 'Praise, promotion, lifestyle or fan content, a how-to, a feature request, an edited or doctored ' +
        'meme, or copy-paste spam making no real claim about Google.',
    },
  };
  q[DEC_Q_INDEPENDENT_] = {
    type: 'noul',
    instructions: 'Are separate accounts in `snippets` reporting the same thing first-hand?',
    criteria: {
      true_description: 'Multiple independent users converge on the same concrete claim, each in their own words or from ' +
        'their own experience.',
      false_description: 'Copies or near-copies of one post, replies in one thread, promotion, or copy-paste spam.',
    },
  };
  q[DEC_Q_NOISE_] = {
    type: 'noul',
    instructions: 'Are the posts in `snippets` routine chatter: support requests, how-to questions, fan or promotional ' +
      'content, or a long-running complaint with nothing new?',
    criteria: {
      true_description: 'Disconnected everyday gripes, routine one-off troubleshooting with no broader incident, how-to ' +
        'questions, fan or promotional content, or a known, long-running complaint with nothing materially new.',
      false_description: 'A new or specific problem, claim or controversy that the accounts raise together.',
    },
  };
  q[DEC_Q_CATEGORY_] = {
    type: 'choice',
    instructions: 'Which of Google\'s brand-safety Exposure Tags best describes what the posts in `snippets` are about?',
    criteria: decCategoryOptions_(),
  };
  q[DEC_Q_SEVERITY_] = {
    type: 'score',
    instructions: 'How severe, for Google\'s reputation, is what the posts in `snippets` describe?',
    criteria: decSeverityLevels_(),
  };
  return q;
}

/** How much of a category answer's probability sits on P0 Exposure Tags (0 to 1, 2 decimals). Pure. */
function decP0Mass_(answer) {
  const probs = (answer && answer.probabilities) || {};
  let sum = 0;
  ((typeof GEN !== 'undefined' && GEN && GEN.exposure_tags) || []).forEach(t => {
    if (t && t.priority === 'P0') sum += Number(probs[String(t.name || '').replace(/\s+/g, ' ').trim()]) || 0;
  });
  return Math.round(Math.min(1, sum) * 100) / 100;
}

/**
 * The six answers as the bot keeps them: {g: about Google, r: brand risk, i: independent reports, n: routine noise
 * (each the probability of yes), c: the category, cp: its probability, p0: the probability on P0 tags, s: the severity
 * score (0-4), l: the most probable level, sc: that level's probability (the answer's confidence), sp: the five
 * levels' probabilities}, 2 decimals; null when an answer is missing. Pure.
 */
function decCompact_(answers) {
  const a = answers || {};
  const r2 = v => Math.round(Number(v) * 100) / 100;
  const yes = k => (a[k] && a[k].type === 'noul' ? r2(a[k].p) : null);
  const cat = a[DEC_Q_CATEGORY_];
  const sev = a[DEC_Q_SEVERITY_];
  const out = { g: yes(DEC_Q_ABOUT_), r: yes(DEC_Q_RISK_), i: yes(DEC_Q_INDEPENDENT_), n: yes(DEC_Q_NOISE_) };
  if ([out.g, out.r, out.i, out.n].some(v => v === null) || !cat || cat.type !== 'choice' || !sev || sev.type !== 'score') return null;
  out.c = truncate_(String(cat.choice), 128);
  out.cp = r2(cat.p);
  out.p0 = decP0Mass_(cat);
  out.s = r2(sev.score);
  out.l = sev.level;
  out.sc = r2(sev.confidence);
  out.sp = sev.probabilities.map(r2);
  return out;
}

/**
 * Many asks at once (step S11, under the open engine): `items` [{input, questions}] (any question set, any input shape)
 * sent side by side in ONE UrlFetchApp.fetchAll, within `session` and decSkipWhy_ (checked once, for the whole batch);
 * each call counted before it is sent. One result an item, as decisionsAsk_ gives it. A failed call (a 429 among
 * them) is not asked again here and pauses nothing, unless more than half the batch failed: then every call pauses
 * as after one failure today. Never throws.
 */
function decisionsAskMany_(items, session) {
  const s = session || decSession_();
  const list = Array.isArray(items) ? items : [];
  const out = list.map(() => null);
  let key = '';
  const clean = v => {
    const t = String(v === undefined || v === null ? '' : v);
    return truncate_((key ? t.split(key).join('[key]') : t).replace(/\s+/g, ' ').trim(), 120);
  };
  try {
    const todo = [];
    list.forEach((it, i) => {
      const text = it && typeof it.input === 'string' ? it.input.trim() : '';
      if (!text || !it.questions || typeof it.questions !== 'object' || !Object.keys(it.questions).length) {
        out[i] = { ok: false, skipped: true, why: 'nothing to ask' };
      } else todo.push(i);
    });
    if (!todo.length) return out;
    const props = PropertiesService.getScriptProperties();
    const now = Date.now();
    const st = decState_(props, now);
    const skip = decSkipWhy_(s, st, now);
    if (skip) {
      todo.forEach(i => { out[i] = { ok: false, skipped: true, why: skip }; });
      return out;
    }
    try {
      key = s.key || decKey_();
      s.key = key;
    } catch (e) {
      todo.forEach(i => { out[i] = { ok: false, why: clean((e && e.message) || e) || 'no API key' }; });
      return out;
    }
    // Counted before the calls are made: a run that dies mid-batch still counts toward every ceiling
    s.asked += todo.length;
    st.asked += todo.length;
    if (typeof openCount_ === 'function') openCount_('ql', todo.length);
    if (typeof engAdd_ === 'function') engAdd_('qAsked', todo.length);
    decSaveState_(props, st);
    if (typeof apiGuardNote_ === 'function') apiGuardNote_('decisions', todo.length);
    const t0 = Date.now();
    let resps = [];
    try {
      resps = UrlFetchApp.fetchAll(todo.map(i => ({ url: decUrl_(), method: 'post', contentType: 'application/json', muteHttpExceptions: true,
        headers: { 'x-goog-api-key': key }, payload: JSON.stringify({ model: DEC_MODEL_, input: list[i].input.trim(), questions: list[i].questions }) })));
    } catch (e) {
      resps = [];
      todo.forEach(i => { out[i] = { ok: false, why: clean((e && e.message) || e) || 'no answer' }; });
    }
    const ms = Date.now() - t0;
    let failed = 0;
    let why = '';
    todo.forEach((i, j) => {
      const r = resps[j];
      if (!r) { if (!out[i]) out[i] = { ok: false, why: 'no answer' }; failed++; why = why || out[i].why; return; }
      const res = decRead_(r.getResponseCode(), r.getContentText(), list[i].questions, ms);
      if (!res.ok) {
        res.why = clean(res.why);
        if (res.refused) st.refused++;
        else { failed++; why = why || res.why; }
      }
      out[i] = res;
    });
    if (failed) {
      st.failed += failed;
      if (failed * 2 > todo.length) {
        const pause = typeof openCheckMs_ === 'function' ? openCheckMs_() : DEC_PAUSE_MS_;
        st.until = Date.now() + pause;
        st.why = why;
        console.warn(`Gemini Decisions: ${failed} of ${todo.length} calls failed (${why}); no calls for ${Math.round(pause / 60000)} minutes`);
      }
    }
    decSaveState_(props, st);
    return out;
  } catch (e) {
    return out.map(x => x || { ok: false, why: clean((e && e.message) || e) || 'no answer' });
  }
}

/** The six questions about many signals (`rows`) at once (decisionsAskMany_): one result a row, as decSignalAsk_. */
function decSignalAskAll_(rows, session) {
  const res = decisionsAskMany_((rows || []).map(r => ({ input: decSignalInput_(r), questions: decSignalQuestions_() })), session);
  return res.map(r => {
    if (!r || !r.ok) return r || { ok: false, why: 'no answer' };
    const dec = decCompact_(r.answers);
    return dec ? { ok: true, dec, answers: r.answers, tokens: r.tokens, ms: r.ms } : { ok: false, why: 'an answer that couldn\'t be read', ms: r.ms };
  });
}

/**
 * Asks the six questions about one signal (`row`) within the check's `session`: {ok: true, dec: decCompact_, answers,
 * tokens, ms}, or {ok: false, why, skipped / refused, ms} (decisionsAsk_). Never throws.
 */
function decSignalAsk_(row, session) {
  try {
    const res = decisionsAsk_(decSignalInput_(row), decSignalQuestions_(), session);
    if (!res.ok) return res;
    const dec = decCompact_(res.answers);
    return dec ? { ok: true, dec, answers: res.answers, tokens: res.tokens, ms: res.ms }
      : { ok: false, why: 'an answer that couldn\'t be read', ms: res.ms };
  } catch (e) {
    return { ok: false, why: truncate_(String((e && e.message) || e), 120) };
  }
}
