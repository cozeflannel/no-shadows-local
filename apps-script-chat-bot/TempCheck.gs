/**
 * TempCheck.gs — Temp checks (Control tab row 36, OFF until a person turns it ON): the Brand Safety team's temperature
 * check (docs.docx, "Brand Safety Temp Check"; the SLRR slides), done by the bot on request.
 *
 * In a thread of a Google-only space the bot works (the Mirror space B9, the Other alerts space B33), an analyst writes
 * "temp check" and the Brandwatch query's name (as the team names them: "[G EVENT] NOV26 Issue name", in [SLRR] Private),
 * its link or its id. After the run's alerts the bot emails the temp check, in the team's UPDATED STANDARD TEMPLATE
 * (docs.docx: the header and BW source link to the query's Brandwatch dashboard when one exists, the TL;DR with the
 * 12-month concern-level placeholder, the inline hourly volume chart, standalone Sentiment / Negativity Drivers / Themes
 * paragraphs with grounded inline post links, Mentions Volume / Mention Types / Engagement Volume breakdowns, and up to
 * seven highest-engaging posts; times in PT), from the bot's account to the testers (B30, else the stand-in: "from me to
 * me", as the Social Alerts go while Testing), and says so in that thread (tcSentText_). The write-up itself is never
 * posted in Chat. "refresh" (or "update", or "temp check" again) in that thread emails the update ("Since the last update
 * at 9am PT, there have been N new mentions (M total mentions)…"), on the same email thread, still counted from the
 * issue's start; "since 9am PT" (or "since 10/28 9am") says where the count starts. One request a thread at a time:
 * another while one waits there replaces it only when it names a query or a time (tempCheckQueue_).
 *
 * The issue's start (the slides): the first hour its query reached TC_SPIKE_+ mentions, looked for from
 * TC_BEFORE_QUERY_MS_ before the query was made (never more than TC_LOOK_MAX_MS_ back); one that never got there counts
 * from the alert in the thread, else from when the query was made. The concern level (the issue's rank against the past
 * 12 months of Google issues in go/bs-database) needs a benchmark table the bot doesn't read directly: the email keeps
 * the template's placeholder and links to the Looker Studio benchmark for the analyst to fill in, instead of guessing.
 *
 * Brandwatch is only read (GETs with the shared token, ProactiveWatch.gs pwBwToken_), in PW_BW_PROJECT_ ([SLRR] Private):
 * the bot never creates, edits or deletes a query. The counts come from Brandwatch's volume and engagementScore endpoints
 * (nothing downloaded); the posts behind the drivers, themes and top posts are at most TC_TOP_ + TC_NEG_ mentions, reposts
 * excluded (the team's export rules: X's allowance is shared by every Google team), X's text from X's public embed data
 * (Post.gs lookupXPosts_).
 *
 * A request is queued (TC_QUEUE_PROP_) when its flow sees it (Bot.gs handleMessage_), is never relayed to S-F Burson
 * (Relay.gs relayAnalyst_), and is worked after the run's alerts (Main.gs poll: runTempChecks_) in what's left of the
 * run; one that can't be done (Brandwatch, Secret Manager or Gmail failing) is tried again next run, TC_TRIES_ runs at
 * most and for TC_MAX_AGE_MS_, then its thread is told why. An email goes once (TC_SENT_PROP_), only to the testers
 * (Mail.gs onlyToGuard_). Posted only where it was asked: never in S-F Burson (B25), the Burson test copy (B26) or a space
 * people outside Google can join (Chat.gs refuses those too).
 */

const TC_ROW_ = 36;                                // the Control tab row (Control.gs CONTROL_SWITCHES_: 'tempChecks')
const TC_QUEUE_PROP_ = 'TC_QUEUE';                 // requests waiting to be worked, after the run's alerts
const TC_THREADS_PROP_ = 'TC_THREADS';             // each thread's last temp check, for "refresh"
const TC_SENT_PROP_ = 'TC_SENT';                   // the temp check emails sent lately ({request: {at, id, th}}): never twice
const TC_SENT_MAX_ = 40;
const TC_QUEUE_MAX_ = 8;
const TC_THREADS_MAX_ = 30;
const TC_THREAD_KEEP_MS_ = 7 * 24 * 3600 * 1000;   // a thread's last temp check is kept a week
const TC_TRIES_ = 3;                               // runs a request is tried in before its thread is told why not
const TC_MAX_AGE_MS_ = 30 * 60 * 1000;             // the team's turnaround is 15-30 minutes
const TC_MIN_LEFT_MS_ = 75 * 1000;                 // with less of the run left than this, a request waits for the next
const TC_JOB_MS_ = 110 * 1000;                     // one request's time at most
const TC_END_MARGIN_MS_ = 40 * 1000;               // ...ending this long before the run's hard stop (Main.gs RUN_HARD_STOP_MS_)
const TC_HOUR_MS_ = 3600 * 1000;
const TC_SPIKE_ = 100;                             // an issue counts from the first hour it reached 100+ mentions...
const TC_BEFORE_QUERY_MS_ = 48 * TC_HOUR_MS_;      // ...looked for from 48 hours before its query was made...
const TC_LOOK_MAX_MS_ = 7 * 24 * TC_HOUR_MS_;      // ...and never more than 7 days back
const TC_SINCE_MAX_MS_ = 31 * 24 * TC_HOUR_MS_;    // "since …" up to a month back
const TC_TOP_ = 25;                                // the most-engaged posts read (reposts excluded)...
const TC_NEG_ = 15;                                // ...and the most-engaged negative ones (the negativity drivers)
const TC_X_MAX_ = 40;                              // X posts whose text is read from X's embed data
const TC_EMAIL_POSTS_ = 7;                         // the template's highest-engaging posts (up to 7)...
const TC_EMAIL_POST_CHARS_ = 400;                  // ...each with up to this much of its words (as the team quotes them)
const TC_GEMINI_POST_CHARS_ = 500;                 // of a post's words for Gemini
const TC_GEMINI_POSTS_ = 25;
const TC_GEMINI_MIN_LEFT_MS_ = 25 * 1000;
const TC_CHAT_CHARS_ = 3900;                       // Chat's limit is 4,096
const TC_LIST_CACHE_KEY_ = 'tc:gevent:v1';         // the [G EVENT] queries' names, cached...
const TC_DASH_CACHE_KEY_ = 'tc:dash:v1';           // queryId -> dashboardId in [SLRR] Private, cached...
const TC_LIST_CACHE_SEC_ = 30 * 60;                // ...for 30 minutes (any other name, or one not found, is looked up afresh)
const TC_LIST_CACHE_MAX_ = 700;                    // ...the newest 700 (the cache holds 100 KB)
const TC_DASH_CACHE_MAX_ = 1200;                   // ...the newest 1,200 dashboards (~28 KB)
const TC_HEAD_ = '\uD83C\uDF21\uFE0F';             // 🌡️: every post of this file's starts "🌡️ *Temp check" (Voice.gs isBotFormattedText_)
const TC_GEVENT_RX_ = /^\s*\[\s*g\s*event\s*\]/i;
const TC_MONTH_TAG_RX_ = /^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\d{2}\b\s*/i;
const TC_ASK_RX_ = /^(?:temp(?:erature)?[\s-]*check|tempcheck)(?![a-z])([\s\S]*)$/i;
const TC_REFRESH_RX_ = /^(?:refresh|update)(?:\s+(?:the\s+|this\s+)?(?:temp(?:erature)?[\s-]*check|tempcheck))?[\s.!]*$/i;
const TC_STOP_WORDS_ = ['the', 'a', 'an', 'and', 'or', 'of', 'on', 'for', 'about', 'in', 'to', 'with', 'query', 'queries',
  'issue', 'please', 'pls', 'bw', 'brandwatch', 'g', 'event', 'temp', 'check'];
// Brandwatch's page types as the team names the sources (others go by Brandwatch's own name)
const TC_SOURCES_ = { twitter: 'X', reddit: 'Reddit', instagram: 'Instagram', instagram_public: 'Instagram',
  facebook: 'Facebook', facebook_public: 'Facebook', youtube: 'YouTube', tiktok: 'TikTok', bluesky: 'Bluesky',
  threads: 'Threads', tumblr: 'Tumblr', news: 'News', blog: 'Blogs', forum: 'Forums', review: 'Reviews', qq: 'QQ',
  linkedin: 'LinkedIn', linkedin_brand_mentions: 'LinkedIn' };
// ...and in a highest-engaging post's line ("couriernewsroom on IG")
const TC_POST_SOURCES_ = { Instagram: 'IG' };
// Brandwatch's threadEntryTypes as the team names them in Mention Types
const TC_MENTION_TYPES_ = { share: 'reposts', reply: 'comments', post: 'original posts' };
// Platform hostnames Brandwatch puts in m.domain / m.unifiedSourceName: never used as a post's author handle
const TC_PLATFORM_DOMAINS_ = ['instagram.com', 'facebook.com', 'fb.com', 'x.com', 'twitter.com', 't.co', 'reddit.com',
  'youtube.com', 'youtu.be', 'tiktok.com', 'threads.net', 'threads.com', 'linkedin.com', 'bsky.app', 'tumblr.com'];
const TC_ZONES_ = { PT: -8, MT: -7, CT: -6, ET: -5, UTC: 0 };  // standard time; US daylight time adds an hour (tcOffsetMin_)
// The 12-month Looker Studio benchmark (go/bs-database): placeholder kept for the analyst to fill in instead of guessing
const TC_BENCHMARK_URL_ = 'https://lookerstudio.google.com/c/u/0/reporting/f3b19d3c-e8d9-401c-b384-f730c4d66af4/page/p_6ur5ole7kd';
const TC_LEVEL_TBD_ = 'Volume is currently [HIGH / MODERATE / LOW] ([top / bottom XX%] of Google issues in the past 12 months).';
const TC_LEVEL_TBD_HTML_ = 'Volume is currently <b>[HIGH / MODERATE / LOW]</b> ' +
  `(<a href="${TC_BENCHMARK_URL_}" style="color:#1155cc">[top / bottom XX%] of Google issues</a> in the past 12 months).`;
// Said once in a request's thread when Brandwatch is busy (runTempChecks_): it waits instead of failing
const TC_BW_BUSY_ = `${TC_HEAD_} *Temp check:* Brandwatch is busy right now (the shared login's limit of calls was reached; other ` +
  'tools use it too), so this one waits: the bot tries again every minute, for up to 30 minutes.';

const TC_SCHEMA_ = {
  type: 'OBJECT',
  properties: { summary: { type: 'STRING' }, negativity_drivers: { type: 'STRING' }, themes: { type: 'STRING' } },
  required: ['summary', 'negativity_drivers', 'themes'],
};
const TC_SYSTEM_ = 'You write the qualitative lines of a temperature check ("temp check"): the quick snapshot Google\'s ' +
  'Brand Safety social listening team sends about an emerging issue. You get the issue\'s Brandwatch query name, its ' +
  'counts, and its most-engaged posts (reposts excluded), each with its network, author, engagement and sentiment. Write ' +
  'as the team does: factual, neutral and specific, in plain English, about what people are saying; no advice, no ' +
  'speculation beyond the posts, and no numbers that aren\'t given. Paraphrase; quote only short phrases. Never repeat ' +
  'slurs, personal attacks or personal details. Name an account only when it is a news outlet, a public figure or a ' +
  'Google account.';

// --------------------------------------------------------------------------------------------------------------
// The request (Bot.gs handleMessage_, Relay.gs relayAnalyst_)
// --------------------------------------------------------------------------------------------------------------

/**
 * A message's text as a temp check request: {refresh, ref, since} or null. "temp check" first (any case; "temperature
 * check", "temp-check" and "tempcheck" too), then the query (its name, link or id; "on", "for" and quotes dropped) and
 * "since …" (where the count starts); or "refresh" / "update" alone (with "since …" or "the temp check" after it).
 * "temp checks are due at 3" is none. Pure.
 */
function tempCheckAsk_(text) {
  const t = String(text === undefined || text === null ? '' : text).replace(/\u00a0/g, ' ').trim();
  if (!t || t.length > 600) return null;
  const head = t.match(TC_ASK_RX_);
  let rest = (head ? head[1] : t).replace(/^[\s:,.\-–—]+/, '');
  let since = '';
  const s = rest.match(/(?:^|\s)since\s+([\s\S]+)$/i);
  if (s) {
    since = s[1].trim().replace(/[.!?]+$/, '');
    rest = rest.slice(0, s.index).trim();
  }
  if (TC_REFRESH_RX_.test(rest)) return { refresh: true, ref: '', since };
  if (!head) return null;
  let ref = rest.replace(/^(?:on|for|of|about)\s+/i, '').replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').replace(/[\s.!?]+$/, '').trim();
  if (!tcWords_(tcCore_(ref)).length && !tcQueryId_(ref)) ref = '';
  return { refresh: false, ref, since };
}

/**
 * Message `m` in this flow is a temp check request to work: Temp checks ON, a person's own message (never the bot's, an
 * app's or one relayed from S-F Burson: those carry an id), in a Google-only space the bot works (tcSpaceOk_), that
 * tempCheckAsk_ reads as one. A bare "refresh" / "update" is one only in a thread the bot did a temp check in. Returns
 * the request, or null. Never throws.
 */
function tempCheckRequestOf_(ctx, m) {
  try {
    if (!switchOn_(ctx, 'tempChecks') || !m || m.senderType !== 'HUMAN' || m.clientId || !tcSpaceOk_(ctx)) return null;
    const ask = tempCheckAsk_(m.text);
    if (!ask) return null;
    if (ask.refresh && !tcThread_(m.thread)) return null;
    return ask;
  } catch (e) {
    return null;
  }
}

/**
 * This flow's space can have temp checks: a one-space flow the bot works itself (the Mirror space, the Other alerts space,
 * or B25 worked directly while only Google people can join it), not read-only, and never S-F Burson, the Burson test copy
 * or a space people outside Google can join.
 */
function tcSpaceOk_(ctx) {
  const sp = ctx && ctx.spaces && ctx.spaces.burson;
  if (!sp || !sp.id || !ctx.outboundBlocked || ctx.sourceReadOnly || sp.externalUserAllowed) return false;
  return tcPostOk_(sp.id) && !isSfBurson_(ctx.sfBurson, sp.id);
}

/** The bot may post a temp check in space `id`: never S-F Burson (B25), the Burson test copy (B26) or an outside space. */
function tcPostOk_(id) {
  const copy = typeof testCopyId_ === 'function' ? testCopyId_() : '';
  return !!id && id !== sfBursonId_() && !outsideSpace_(id) && (!copy || id !== copy);
}

/**
 * Queues request `m` (tempCheckRequestOf_'s `ask`) for after the run's alerts: its space, thread, words, who asked (name
 * and Chat id, for the note's mention), when, and when the alert in its thread came in (the issue's start when it never
 * reached TC_SPIKE_ mentions an hour). One request a thread at a time: while one waits there, a bare "temp check" /
 * "refresh" is left to it (that one answers it), and one naming a query or a time takes its place (keeping that its
 * thread was told Brandwatch is busy: never twice). Each message once; TC_QUEUE_MAX_ waiting at most (the oldest go first).
 */
function tempCheckQueue_(ctx, m, ask) {
  const sp = ctx.spaces.burson.id;
  const th = m.thread || '';
  const all = tcRead_(TC_QUEUE_PROP_, []).filter(j => j && j.m && j.m !== m.name);
  const same = th ? all.find(j => !j.auto && j.sp === sp && j.th === th) : null;
  const what = ask.refresh ? 'refresh' : ask.ref ? `"${truncate_(ask.ref, 80)}"` : 'no query named';
  if (same && !ask.ref && !ask.since) {
    if (ctx.log) ctx.log(`temp check asked (${what}) while one waits in this thread: that one answers it`);
    return;
  }
  let al = 0;
  try {
    const a = m.threadReply && m.thread ? ctx.store.alertByThread(m.thread) : null;
    al = a ? Number(a.source_at || a.created_at) || 0 : 0;
  } catch (e) {
    al = 0;
  }
  const job = { m: m.name, sp, th, tx: String(m.text || ''), who: truncate_(String(m.senderDisplay || ''), 60),
    u: /^users\/[\w-]+$/.test(String(m.senderName || '')) ? String(m.senderName) : '', at: Date.now(), n: 0, al };
  if (same && same.w) job.w = 1;  // its thread was told Brandwatch is busy: not again
  const queue = all.filter(j => j !== same).concat([job]);
  tcWrite_(TC_QUEUE_PROP_, queue.slice(-TC_QUEUE_MAX_));
  if (ctx.log) {
    ctx.log(`temp check asked (${what}): worked after this run's alerts${same ? ' (in place of the one waiting in this thread)' : ''}`);
  }
}

// --------------------------------------------------------------------------------------------------------------
// The run (Main.gs poll, after the alerts)
// --------------------------------------------------------------------------------------------------------------

/**
 * Works the waiting requests in what's left of the run (from `runStart`: none starts with less than TC_MIN_LEFT_MS_
 * before the run's hard stop, less TC_END_MARGIN_MS_): a temp check is emailed (tcSendEmail_: to `opts.testers`, Control
 * tab B30, else the stand-in) and its thread told it was (tcSentText_); any other answer ("which query?") is posted in its
 * thread. One that fails is tried again next run (TC_TRIES_ at most, and for TC_MAX_AGE_MS_), then its thread is told
 * why. Brandwatch busy (its call limit for the shared token, TC_BW_BUSY_: other tools use the token too, or a 5xx) isn't
 * a try: the request waits, tried again every run for TC_MAX_AGE_MS_, its thread told once that it's waiting, and the rest
 * of the queue waits with it that run. Temp checks OFF (`switches`): nothing waits. C36 says how the last one went
 * (noteSwitch_). Never throws.
 */
function runTempChecks_(runStart, switches, opts) {
  try {
    const props = PropertiesService.getScriptProperties();
    if (!(switches && switches.tempChecks)) {
      if (props.getProperty(TC_QUEUE_PROP_)) props.deleteProperty(TC_QUEUE_PROP_);
      return;
    }
    const queue = tcRead_(TC_QUEUE_PROP_, []);
    if (!Array.isArray(queue) || !queue.length) return;
    const until = Number(runStart || Date.now()) + RUN_HARD_STOP_MS_ - TC_END_MARGIN_MS_;
    const keep = [];
    let token = '';
    let busy = false;  // Brandwatch said it's busy this run: the rest wait for the next
    const tokenOf = () => token || (token = pwBwToken_());
    const scrub = s => (token ? String(s).split(token).join('[token]') : String(s));
    queue.forEach(job => {
      if (!job || !job.m || !job.sp) return;
      if (Date.now() - Number(job.at || 0) > TC_MAX_AGE_MS_) {
        tcNote_(job, tcGaveUpText_(job, job.err || 'the bot had no time for it within 30 minutes'), 'tc-note:');
        return;
      }
      if (busy || until - Date.now() < TC_MIN_LEFT_MS_) {
        keep.push(job);
        return;
      }
      try {
        const out = tempCheckDo_(job, Math.min(until, Date.now() + TC_JOB_MS_), tokenOf);
        if (!tcPostOk_(job.sp)) throw new Error(`it can't be posted in ${job.sp}`);
        if (out.email) {
          const sent = tcSendEmail_(job, out, opts);
          chatPostMessage_(job.sp, tcSentText_(job, out, sent), { thread: job.th || null, key: 'tc:' + job.m });
          tcSaveThread_(job.th, Object.assign({}, out.state, { mt: sent.threadId || out.mailThread || '' }));
        } else {
          chatPostMessage_(job.sp, out.text, { thread: job.th || null, key: 'tc:' + job.m });
          if (out.state) tcSaveThread_(job.th, out.state);
        }
        noteSwitch_('tempChecks', out.note || `last ${tcClock_(Date.now())} PT: answered (no temp check)`);
      } catch (e) {
        const why = truncate_(scrub((e && e.message) || e), 200);
        job.err = why;
        if (e && e.bw && (e.code === 429 || Number(e.code) >= 500)) {
          console.warn(`temp check ${job.m}: Brandwatch is busy, waiting: ${why}`);
          busy = true;
          if (!job.w) {
            tcNote_(job, TC_BW_BUSY_, 'tc-wait:');
            job.w = 1;
          }
          keep.push(job);
          noteSwitch_('tempChecks', `⚠️ ${truncate_(why, 140)} (waiting: tried again every run for up to 30 minutes)`);
          return;
        }
        console.error(`temp check ${job.m}: ${scrub((e && e.stack) || e)}`);
        job.n = (Number(job.n) || 0) + 1;
        if (job.n >= TC_TRIES_) tcNote_(job, tcGaveUpText_(job, why), 'tc-note:');
        else keep.push(job);
        noteSwitch_('tempChecks', `⚠️ ${truncate_(why, 140)} (${job.n >= TC_TRIES_ ? 'its thread was told' : 'tried again next run'})`);
      }
    });
    if (keep.length) tcWrite_(TC_QUEUE_PROP_, keep);
    else props.deleteProperty(TC_QUEUE_PROP_);
  } catch (e) {
    console.error('temp checks: ' + ((e && e.stack) || e));
  }
}

/** A note in the request's thread (why it waits, or why it couldn't be done), once per `kind` (a key prefix). Never throws. */
function tcNote_(job, text, kind) {
  try {
    if (!tcPostOk_(job.sp)) return;
    chatPostMessage_(job.sp, truncate_(text, TC_CHAT_CHARS_), { thread: job.th || null, key: (kind || 'tc-note:') + job.m });
  } catch (e) {
    console.error(`temp check ${job.m}: couldn't post in its thread: ${(e && e.message) || e}`);
  }
}

/**
 * Emails request `job`'s temp check (`out.email`: {subject, html, text, inline}) from the bot's account to `opts.testers`
 * (B30, else the stand-in), on the issue's email thread when it has one (`out.mailThread`: updates), and returns {to,
 * threadId, id} ({unsure: true} for one an earlier try may have sent). Once only (TC_SENT_PROP_): noted before Gmail is
 * asked (one that can't be noted isn't sent) and again once it's out; a try that stopped mid-send is never sent again.
 * Only ever to the testers (Mail.gs onlyToGuard_). Throws when Gmail refuses it (nothing went out: the next try sends it).
 */
function tcSendEmail_(job, out, opts) {
  const to = onlyToList_(opts && Array.isArray(opts.testers) && opts.testers.length ? opts.testers : (GEN.email.stand_in || ''));
  if (!to.length) throw new Error('there is no one to email it to (B30 is blank and there is no stand-in)');
  const sentAll = tcRead_(TC_SENT_PROP_, {});
  const before = sentAll && typeof sentAll === 'object' ? sentAll[job.m] : null;
  if (before && before.id) return { to, threadId: before.th || '', id: before.id };
  if (before) return { to, threadId: '', id: '', unsure: true };
  const me = Session.getEffectiveUser().getEmail();
  const mime = buildMime_({ from: `${GEN.email.from_name} <${me}>`, to, cc: [], bcc: [], subject: out.email.subject,
    text: out.email.text, html: out.email.html, inline: out.email.inline || [] });
  tcNoteSent_(job.m, { at: Date.now() });  // first: when it can't be noted, this throws and nothing is sent
  let r;
  try {
    r = gmailClient_({ onlyTo: to }).sendMessage(mime, out.mailThread || null);
  } catch (e) {
    tcNoteSent_(job.m, null);  // Gmail refused it: nothing went out, so the next try sends it
    throw e;
  }
  const done = { to, threadId: (r && r.threadId) || out.mailThread || '', id: (r && r.id) || 'sent' };
  try {
    tcNoteSent_(job.m, { at: Date.now(), id: done.id, th: done.threadId });
  } catch (e) {
    console.error(`temp check ${job.m}: couldn't note that its email went out: ${(e && e.message) || e}`);
  }
  return done;
}

/** Notes request `m`'s email (`entry`; null forgets it), keeping the newest TC_SENT_MAX_. Throws when it can't. */
function tcNoteSent_(m, entry) {
  const all = tcRead_(TC_SENT_PROP_, {});
  const cur = all && typeof all === 'object' && !Array.isArray(all) ? all : {};
  if (entry) cur[m] = entry;
  else delete cur[m];
  const kept = Object.keys(cur).sort((a, b) => Number(cur[b].at || 0) - Number(cur[a].at || 0)).slice(0, TC_SENT_MAX_);
  tcWrite_(TC_SENT_PROP_, Object.fromEntries(kept.map(k => [k, cur[k]])));
}

/**
 * The thread's note once the temp check was emailed (`out`: tempCheckDo_'s, `sent`: tcSendEmail_'s): who asked (a
 * mention), the temp check's title, who it went to and a link to the email (it opens for whoever's mailbox it's in). Pure.
 */
function tcSentText_(job, out, sent) {
  const who = job && job.u ? ` <${job.u}>` : '';
  const what = out.update ? 'Temp check update' : 'Temp check';
  if (sent && sent.unsure) {
    return `${TC_HEAD_} *${what}:*${who} ${out.title} may already have been emailed (an earlier try stopped while sending it), ` +
      'so it wasn\'t sent again: check Sent in Gmail.';
  }
  const link = sent && sent.threadId && /^[0-9a-f]{6,24}$/i.test(String(sent.threadId))
    ? ` ${chatLink_(`https://mail.google.com/mail/u/0/#all/${sent.threadId}`, 'Open the email')}.` : '';
  const filling = out.pct !== null && out.pct !== undefined && out.pct < 100
    ? ` Brandwatch is still filling the query (${Math.round(out.pct)}% done), so the counts will grow.` : '';
  return `${TC_HEAD_} *${what} sent:*${who} ${out.title} was emailed to ${testersJoin_((sent && sent.to) || [])}.${link}` +
    `${filling} Reply "refresh" here for an update.`;
}

/**
 * One request: a temp check, {email ({subject, html, text, inline}: tempCheckEmail_), title (its header line, for the
 * thread's note), update (true for an update), pct (Brandwatch's % backfilled, or null), mailThread (the issue's email
 * thread, for an update), state (the thread's temp check, for "refresh"), note (for C36)}; or any other answer, {text
 * (what to post in its thread), note}. `deadline` (ms): this request's time; `tokenOf`: the shared Brandwatch token.
 * Throws when Brandwatch or Secret Manager fails (tried again next run).
 */
function tempCheckDo_(job, deadline, tokenOf) {
  const ask = tempCheckAsk_(job.tx) || { refresh: false, ref: '', since: '' };
  const now = Date.now();
  let since = 0;
  if (ask.since) {
    since = tcParseSince_(ask.since, now);
    if (!since && ask.ref) {  // "since" was part of the query's name
      ask.ref = `${ask.ref} since ${ask.since}`;
      ask.since = '';
    } else if (!since) {
      return { text: `${TC_HEAD_} *Temp check:* couldn't read the time in "since ${truncate_(ask.since, 60)}". Try "since 9am PT" ` +
        'or "since 10/28 9am PT" (within the last month).', note: `last ${tcClock_(now)} PT: couldn't read "since ${truncate_(ask.since, 40)}"` };
    }
  }
  const prev = tcThread_(job.th);
  const again = !ask.ref && prev && String(prev.sp) === String(job.sp) ? prev : null;
  const update = again && !since ? again : null;  // "refresh", or "temp check" again in its thread: the update
  const token = tokenOf();
  let query;
  if (again) {
    query = { id: Number(again.q), name: String(again.n || ''), created: Number(again.c) || 0 };
  } else if (!ask.ref) {
    return { text: tcWhichText_(tcQueryList_(token, true).list, now), note: `last ${tcClock_(now)} PT: asked which Brandwatch query` };
  } else {
    const found = tcFindQuery_(token, ask.ref);
    if (!found.query) {
      return { text: tcNotFoundText_(ask.ref, found, now),
        note: `last ${tcClock_(now)} PT: ${(found.choices || []).length ? 'several queries match' : 'no query matches'} "${truncate_(ask.ref, 50)}"` };
    }
    query = found.query;
  }
  const bwUrl = tcDashboardUrl_(token, query);
  const base = `/projects/${PW_BW_PROJECT_}/data`;
  const iso = ms => encodeURIComponent(new Date(ms).toISOString());
  // Counts by hour, from where the issue could have started (or from where it's asked to)
  let look = since || (update ? Number(update.s) : Math.max(now - TC_LOOK_MAX_MS_, (query.created || now) - TC_BEFORE_QUERY_MS_));
  look = tcFloorHour_(look);
  const hours = tcHourly_(tcBwGet_(token, `${base}/volume/queries/hours?queryId=${query.id}&startDate=${iso(look)}&endDate=${iso(now)}`),
    look, now);
  const start = since ? { at: since, why: 'since' } : update ? { at: look, why: String(update.w || 'spike') }
    : tcStart_(hours, { alertAt: Number(job.al) || 0, created: query.created, look });
  const counted = hours.filter(h => h.at >= start.at);
  const total = counted.reduce((a, h) => a + h.n, 0);
  // Sentiment, mention sources, mention types, engagement sources and the posts, together in one round trip
  const win = `queryId=${query.id}&startDate=${iso(start.at)}&endDate=${iso(now)}`;
  const mentions = `${base}/mentions?${win}&orderBy=engagementScore&orderDirection=desc&xthreadEntryType=share`;
  const got = tcBwAll_(token, [
    `${base}/volume/queries/sentiment?${win}`,
    `${base}/volume/queries/pageTypes?${win}`,
    `${base}/volume/queries/threadEntryTypes?${win}`,
    `${base}/engagementScore/queries/pageTypes?${win}`,
    `${mentions}&pageSize=${TC_TOP_}`,
    `${mentions}&pageSize=${TC_NEG_}&sentiment=negative`,
  ]);
  const sentiment = tcValues_(got[0]);
  const sources = tcSourceCounts_(got[1]);
  const mentionTypes = tcMentionTypeCounts_(got[2]);
  const engSources = tcSourceCounts_(got[3]);
  const top = tcMentions_(got[4]);
  const neg = tcMentions_(got[5]);
  // X's posts come without their words: X's embed data has them (one round trip)
  const all = top.concat(neg);
  const xIds = all.filter(p => p.x && p.id).map(p => p.id).slice(0, TC_X_MAX_);
  const xPosts = xIds.length && deadline - Date.now() > TC_GEMINI_MIN_LEFT_MS_ ? lookupXPosts_(xIds) : {};
  const seen = new Set();
  const withText = all.map(p => tcPostWithText_(p, xPosts)).filter(p => {
    if (!p || !p.text || seen.has(p.key)) return false;
    seen.add(p.key);
    return true;
  });
  const topOrder = new Map();
  top.forEach((p, i) => { if (p && p.key && !topOrder.has(p.key)) topOrder.set(p.key, i); });
  const topRanked = withText.filter(p => topOrder.has(p.key)).sort((a, b) => {
    const ea = tcPostEngVal_(a);
    const eb = tcPostEngVal_(b);
    if (ea !== eb) return eb - ea;
    return (topOrder.get(a.key) || 0) - (topOrder.get(b.key) || 0);
  });
  // Resolve missing authors on top non-X posts (e.g. Brandwatch instagram-graph-hashtag reels have domain="instagram.com" and no author)
  const posts = topRanked.slice(0, TC_EMAIL_POSTS_).map(p => {
    if (p.author || p.x || !p.url || deadline - Date.now() <= TC_GEMINI_MIN_LEFT_MS_ || typeof lookupPost_ !== 'function') return p;
    const looked = lookupPost_(p.url);
    const handle = tcCleanHandle_(looked && looked.author);
    return handle ? Object.assign({}, p, { author: handle }) : p;
  });
  const postKeys = new Set(posts.map(p => p.key));
  const gemPosts = posts.concat(withText.filter(p => !postKeys.has(p.key))).slice(0, TC_GEMINI_POSTS_);
  const d = {
    issue: tcIssueName_(query.name), query, bwUrl, now, start, total, hours: counted,
    velocity: tcVelocity_(counted, start.at, now), sentiment, sources, mentionTypes, engSources, posts,
    linkPosts: gemPosts,
    update: update ? { at: Number(update.at), tot: Number(update.tot) || 0 } : null,
    pct: Number.isFinite(query.pct) ? query.pct : null,
  };
  d.gem = total ? tcGemini_(d, gemPosts, deadline) : null;
  const sameIssue = prev && String(prev.sp) === String(job.sp) && Number(prev.q) === Number(query.id);
  return {
    email: tempCheckEmail_(d),
    title: tcTitle_(d),
    update: !!d.update,
    pct: d.pct,
    mailThread: sameIssue ? String(prev.mt || '') : '',
    state: { sp: job.sp, q: query.id, n: query.name, c: query.created || 0, s: start.at, w: start.why, at: now, tot: total },
    note: `last ${tcClock_(now)} PT: ${truncate_(d.issue, 60)} (${tcNum_(total)} mentions, emailed)`,
  };
}

// --------------------------------------------------------------------------------------------------------------
// Brandwatch (read only)
// --------------------------------------------------------------------------------------------------------------

function tcBwParams_(token) {
  return { muteHttpExceptions: true, headers: { Authorization: 'bearer ' + token, Accept: 'application/json' } };
}

/** A Brandwatch answer's JSON; throws with what went wrong (in ProactiveWatch.gs's words) for anything but 200. */
function tcBwBody_(resp) {
  const code = resp.getResponseCode();
  if (code !== 200) {
    const hint = code === 401 ? ' (the shared token was refused)' : code === 429 ? ' (too many calls for now)' : '';
    const err = new Error(`Brandwatch HTTP ${code}${hint}: ${pwHttpWhy_(resp)}`);
    err.code = code;
    err.bw = true;  // Brandwatch's (runTempChecks_: its 429 / 5xx means busy, not a try)
    throw err;
  }
  return JSON.parse(resp.getContentText() || '{}') || {};
}

function tcBwGet_(token, path) { return tcBwBody_(UrlFetchApp.fetch(PW_BW_API_ + path, tcBwParams_(token))); }

/** Several GETs in one round trip (UrlFetchApp.fetchAll), their JSON in order; throws when any fails. */
function tcBwAll_(token, paths) {
  const params = tcBwParams_(token);
  return UrlFetchApp.fetchAll(paths.map(p => Object.assign({ url: PW_BW_API_ + p }, params))).map(tcBwBody_);
}

function tcCache_() {
  try {
    return typeof CacheService !== 'undefined' && CacheService.getScriptCache ? CacheService.getScriptCache() : null;
  } catch (e) {
    return null;
  }
}

/**
 * The Brandwatch URL for `query` (`{id, created}`): its dashboard in [SLRR] Private
 * (`https://app.brandwatch.com/project/<project>/dashboards/<dashId>`) when one points at `query.id`, else the project's
 * queries list. Cached for TC_LIST_CACHE_SEC_ (a brand-new query missing from cache refreshes once); a 403/404 on
 * dashboards/summary falls back cleanly without failing the temp check (429 / 5xx still pauses on busy).
 */
function tcDashboardUrl_(token, query) {
  const fallback = `https://app.brandwatch.com/project/${PW_BW_PROJECT_}/queries`;
  const qid = Number(query && query.id) || 0;
  if (!qid) return fallback;
  const cache = tcCache_();
  let map = null;
  let cached = false;
  if (cache) {
    try {
      const hit = cache.get(TC_DASH_CACHE_KEY_);
      if (hit) { map = JSON.parse(hit); cached = !!map && typeof map === 'object'; }
    } catch (e) { map = null; }
  }
  const readFresh = () => {
    const body = tcBwGet_(token, `/projects/${PW_BW_PROJECT_}/dashboards/summary`);
    const list = Array.isArray(body) ? body : ((body && body.results) || []);
    const pairs = [];
    list.forEach(d => {
      const did = Number(d && d.id) || 0;
      const dq = Number(d && d.settings && d.settings.queryId) || 0;
      if (did && dq) pairs.push([dq, did]);
    });
    pairs.sort((a, b) => b[1] - a[1]);  // newest dashboard id wins when several point at the same query
    const fresh = {};
    for (let i = 0; i < pairs.length && Object.keys(fresh).length < TC_DASH_CACHE_MAX_; i++) {
      const k = String(pairs[i][0]);
      if (!fresh[k]) fresh[k] = pairs[i][1];
    }
    if (cache) {
      try { cache.put(TC_DASH_CACHE_KEY_, JSON.stringify(fresh), TC_LIST_CACHE_SEC_); } catch (e) { /* not cached */ }
    }
    return fresh;
  };
  try {
    if (!cached) {
      map = readFresh();
    } else if (!map[String(qid)] && query && query.created && Date.now() - Number(query.created) < TC_LIST_CACHE_SEC_ * 1000) {
      map = readFresh();
    }
  } catch (e) {
    if (e && e.bw && (e.code === 429 || Number(e.code) >= 500)) throw e;
    return fallback;
  }
  const dashId = map && map[String(qid)];
  return dashId ? `https://app.brandwatch.com/project/${PW_BW_PROJECT_}/dashboards/${dashId}` : fallback;
}

/**
 * The project's queries: {list: [{id, name, created (ms), pct (Brandwatch's % backfilled)}], cached}. Brandwatch's
 * summary of them (one call, ~1 MB) unless `fresh` is false and the [G EVENT] ones are cached (TC_LIST_CACHE_SEC_; pct
 * isn't kept there). Each fresh read caches the newest TC_LIST_CACHE_MAX_ [G EVENT] queries.
 */
function tcQueryList_(token, fresh) {
  const cache = tcCache_();
  if (!fresh && cache) {
    try {
      const hit = cache.get(TC_LIST_CACHE_KEY_);
      if (hit) return { list: JSON.parse(hit), cached: true };
    } catch (e) { /* read afresh */ }
  }
  const body = tcBwGet_(token, `/projects/${PW_BW_PROJECT_}/queries/summary`);
  const list = ((body && body.results) || []).filter(q => q && q.id && q.name).map(q => ({
    id: Number(q.id), name: String(q.name), created: pwBwTime_(q.creationDate),
    pct: q.percentComplete === undefined || q.percentComplete === null ? null : Number(q.percentComplete),
  }));
  if (cache) {
    try {
      const keep = list.filter(q => TC_GEVENT_RX_.test(q.name)).sort((a, b) => b.id - a.id).slice(0, TC_LIST_CACHE_MAX_)
        .map(q => ({ id: q.id, name: q.name, created: q.created }));
      cache.put(TC_LIST_CACHE_KEY_, JSON.stringify(keep), TC_LIST_CACHE_SEC_);
    } catch (e) { /* not cached */ }
  }
  return { list, cached: false };
}

/**
 * The query `ref` names: {query} or tcMatchQuery_'s choices / near ({missing: id} for a link or id the project doesn't
 * have). A link or id is read straight from Brandwatch; a name is matched in the cached [G EVENT] queries, then afresh in
 * all of the project's when that finds none.
 */
function tcFindQuery_(token, ref) {
  const id = tcQueryId_(ref);
  if (id) {
    try {
      const q = tcBwGet_(token, `/projects/${PW_BW_PROJECT_}/queries/${id}`);
      if (q && q.id && q.name) {
        return { query: { id: Number(q.id), name: String(q.name), created: pwBwTime_(q.creationDate),
          pct: q.percentComplete === undefined || q.percentComplete === null ? null : Number(q.percentComplete) } };
      }
    } catch (e) {
      if (!(e && (e.code === 404 || e.code === 400 || e.code === 403))) throw e;
    }
    return { choices: [], near: [], missing: id };
  }
  let lists = tcQueryList_(token, false);
  let got = tcMatchQuery_(ref, lists.list);
  if (!got.query && lists.cached) {
    lists = tcQueryList_(token, true);
    got = tcMatchQuery_(ref, lists.list);
  }
  return got;
}

/** A Brandwatch query id in `ref`: a link's (…/queries/2004162030, ?queryId=…) or a bare 9-12 digit number; else 0. Pure. */
function tcQueryId_(ref) {
  const s = String(ref || '');
  const m = s.match(/(?:queries\/(?:edit\/)?|queries=|queryId=)(\d{6,12})(?!\d)/i) || s.match(/^\s*(\d{9,12})\s*$/);
  return m ? Number(m[1]) : 0;
}

function tcNorm_(s) { return String(s || '').toLowerCase().replace(/[“”"'‘’`]/g, '').replace(/\s+/g, ' ').trim(); }

/** A query name without "[G EVENT]" and the month tag ("OCT26"): "2020 election query results". Pure. */
function tcCore_(s) { return tcNorm_(s).replace(/^\[\s*g\s*event\s*\]\s*/, '').replace(TC_MONTH_TAG_RX_, ''); }

/** The words that tell queries apart (stop words and punctuation dropped). Pure. */
function tcWords_(s) {
  return tcNorm_(s).replace(/[^a-z0-9$#@&]+/g, ' ').split(' ').filter(w => w && TC_STOP_WORDS_.indexOf(w) < 0);
}

/** The issue's name for the write-up: the query's without "[G EVENT]" and the month tag. Pure. */
function tcIssueName_(name) {
  const s = String(name || '').trim().replace(/^\[\s*G\s*EVENT\s*\]\s*/i, '').replace(TC_MONTH_TAG_RX_, '').trim();
  return s || String(name || '').trim();
}

/**
 * The query `ref` names in `list` ([{id, name, created}]): {query} for the same name (any case or spacing; "[G EVENT]"
 * and the month tag optional; the newest of several), or the one [G EVENT] query (else the one query) whose name has
 * every word of `ref`; {choices} (newest first, 5 at most) when several do; {choices: [], near} when none does: the [G
 * EVENT] names with the most of its words (newest first). Pure.
 */
function tcMatchQuery_(ref, list) {
  const qs = (list || []).filter(q => q && q.id && q.name);
  const newest = (a, b) => Number(b.id) - Number(a.id);  // Brandwatch's ids grow with time
  const want = tcNorm_(ref);
  const wantCore = tcCore_(ref);
  const exact = qs.filter(q => tcNorm_(q.name) === want || (wantCore && tcCore_(q.name) === wantCore));
  if (exact.length) return { query: exact.sort(newest)[0] };
  const words = tcWords_(wantCore);
  if (!words.length) return { choices: [], near: [] };
  const wordsOf = q => new Set(tcWords_(q.name));
  const hasAll = q => { const w = wordsOf(q); return words.every(x => w.has(x)); };
  let hits = qs.filter(q => TC_GEVENT_RX_.test(q.name) && hasAll(q));
  if (!hits.length) hits = qs.filter(hasAll);
  if (hits.length === 1) return { query: hits[0] };
  if (hits.length > 1) return { choices: hits.sort(newest).slice(0, 5) };
  const score = q => { const w = wordsOf(q); return words.filter(x => w.has(x)).length; };
  const near = qs.filter(q => TC_GEVENT_RX_.test(q.name) && score(q) > 0)
    .sort((a, b) => score(b) - score(a) || newest(a, b)).slice(0, 5);
  return { choices: [], near };
}

/** Brandwatch's hourly volume -> [{at (ms), n}], one per hour from `from` to `to` (an hour with nothing: 0). Pure. */
function tcHourly_(body, from, to) {
  const by = new Map();
  ((((body && body.results) || [])[0] || {}).values || []).forEach(v => {
    const at = pwBwTime_(v && v.id);
    if (at) by.set(at, (by.get(at) || 0) + (Number(v.value) || 0));
  });
  const out = [];
  for (let at = tcFloorHour_(from); at < to; at += TC_HOUR_MS_) out.push({ at, n: by.get(at) || 0 });
  return out;
}

/** A volume answer's counts by its values' ids ({positive: 185, …}). Pure. */
function tcValues_(body) {
  const out = {};
  ((((body && body.results) || [])[0] || {}).values || []).forEach(v => {
    if (v && v.id !== undefined) out[String(v.id)] = (out[String(v.id)] || 0) + (Number(v.value) || 0);
  });
  return out;
}

/** The page types' counts (mentions or engagementScore) as the team names the sources ([{label, n}], most first, none with 0). Pure. */
function tcSourceCounts_(body) {
  const by = {};
  ((((body && body.results) || [])[0] || {}).values || []).forEach(v => {
    const n = Number(v && v.value) || 0;
    if (!n) return;
    const label = TC_SOURCES_[String(v.id)] || String(v.name || v.id);
    by[label] = (by[label] || 0) + n;
  });
  return Object.keys(by).map(label => ({ label, n: by[label] })).sort((a, b) => b.n - a.n);
}

/** Brandwatch's threadEntryTypes volume -> [{label, n}] ("reposts", "comments", "original posts"), most first, none with 0. Pure. */
function tcMentionTypeCounts_(body) {
  const by = {};
  ((((body && body.results) || [])[0] || {}).values || []).forEach(v => {
    const n = Number(v && v.value) || 0;
    const label = TC_MENTION_TYPES_[String(v && v.id)];
    if (!n || !label) return;
    by[label] = (by[label] || 0) + n;
  });
  return Object.keys(by).map(label => ({ label, n: by[label] })).sort((a, b) => b.n - a.n);
}

/** Cleans an author handle or display name, rejecting bare platform domains ("instagram.com") and "unknown". Pure. */
function tcCleanHandle_(raw, domain, unified) {
  const s = String(raw || '').trim().replace(/^@+/, '').trim();
  if (!s) return '';
  const low = s.toLowerCase().replace(/^www\./, '');
  if (low === 'unknown' || TC_PLATFORM_DOMAINS_.indexOf(low) >= 0) return '';
  if (domain && low === String(domain).trim().toLowerCase().replace(/^www\./, '')) return '';
  if (unified && low === String(unified).trim().toLowerCase().replace(/^www\./, '')) return '';
  return s;
}

/** Extracts a post's author from Brandwatch's mention fields or URL, never falling back to m.domain ("instagram.com"). Pure. */
function tcMentionAuthor_(m) {
  const dom = m && m.domain;
  const uni = m && m.unifiedSourceName;
  const fields = [m && m.author, m && m.fullname, m && m.threadAuthor];
  for (let i = 0; i < fields.length; i++) {
    const hit = tcCleanHandle_(fields[i], dom, uni);
    if (hit) return hit;
  }
  const u = String((m && (m.url || m.originalUrl)) || '');
  const ig = u.match(/^https?:\/\/(?:www\.|m\.)?instagram\.com\/([A-Za-z0-9_.]+)\/(?:p|reels?|tv)\//i);
  if (ig && !/^(?:p|reels?|tv|stories|explore)$/i.test(ig[1])) return ig[1];
  const bsky = u.match(/^https?:\/\/(?:www\.)?bsky\.app\/profile\/([^/?#]+)/i);
  if (bsky && !/^did:/i.test(bsky[1])) return decodeURIComponent(bsky[1]);
  const atHandle = u.match(/^https?:\/\/(?:www\.)?(?:tiktok\.com|threads\.(?:net|com)|youtube\.com)\/@([^/?#]+)/i);
  if (atHandle) return decodeURIComponent(atHandle[1]);
  return '';
}

/** Numeric engagement for sorting top posts descending (X likes+replies, else Brandwatch engagementScore; -1 when unknown). Pure. */
function tcPostEngVal_(p) {
  if (!p) return -1;
  if (p.x) return (Number(p.likes) || 0) + (Number(p.replies) || 0);
  return p.eng === null || p.eng === undefined ? -1 : Number(p.eng) || 0;
}

/**
 * A mentions answer as posts: [{key, x (an X post: its words come from X's embed data), id (X's post id), source, author,
 * text, url, eng (Brandwatch's engagement; none for X), negative}], in Brandwatch's order (the most engagement first). Pure.
 */
function tcMentions_(body) {
  return ((body && body.results) || []).filter(Boolean).map(m => {
    const x = String(m.pageType || '') === 'twitter';
    const id = x ? String(m.guid || '').replace(/\D/g, '') : '';
    const title = String(m.title || '').trim();
    const snippet = String(m.snippet || m.fullText || '').trim();
    const text = title && snippet && snippet.indexOf(title) !== 0 ? `${title}: ${snippet}` : (title || snippet);
    const url = x ? '' : String(m.url || m.originalUrl || '');
    return {
      key: String(m.guid || url || m.resourceId || ''), x, id,
      source: TC_SOURCES_[String(m.pageType)] || String(m.pageTypeName || m.pageType || 'Web'),
      author: tcMentionAuthor_(m), text: x ? '' : text, url,
      eng: m.engagementScore === null || m.engagementScore === undefined ? null : Number(m.engagementScore) || 0,
      negative: String(m.sentiment || '') === 'negative',
    };
  });
}

/** A post with its words: an X post's from X's embed data (`xPosts`: lookupXPosts_), else as Brandwatch gave them. Pure. */
function tcPostWithText_(p, xPosts) {
  if (!p) return null;
  if (!p.x) return p.text ? p : null;
  const post = (xPosts || {})[p.id];
  if (!post || !post.text) return null;
  return Object.assign({}, p, { author: tcCleanHandle_(post.author) || p.author, text: post.text, url: post.url || '',
    likes: Number(post.likes) || 0, replies: Number(post.replies) || 0 });
}

// --------------------------------------------------------------------------------------------------------------
// The numbers (pure)
// --------------------------------------------------------------------------------------------------------------

function tcFloorHour_(ms) { return Math.floor(Number(ms) / TC_HOUR_MS_) * TC_HOUR_MS_; }

/**
 * Where the count starts: the first hour (from `o.look`) with TC_SPIKE_+ mentions ('spike': the slides' rule); else when
 * the alert in the thread came in ('alert', `o.alertAt`, when it's after `o.look`); else when the query was made
 * ('query'); else `o.look` ('look'). {at, why}. Pure.
 */
function tcStart_(hours, o) {
  const spike = (hours || []).find(h => h.n >= TC_SPIKE_);
  if (spike) return { at: spike.at, why: 'spike' };
  if (o.alertAt && o.alertAt >= o.look) return { at: tcFloorHour_(o.alertAt), why: 'alert' };
  if (o.created && o.created >= o.look) return { at: tcFloorHour_(o.created), why: 'query' };
  return { at: o.look, why: 'look' };
}

/**
 * The full hours from `start` (before `now`'s hour): the peak (the first of the most), the last, and the change from the
 * peak to the last (%, rounded; -100 only for a last hour with none, so 1 against 796 is -99). null before the first full
 * hour. Pure.
 */
function tcVelocity_(hours, start, now) {
  const cur = tcFloorHour_(now);
  const full = (hours || []).filter(h => h.at >= start && h.at < cur);
  if (!full.length) return null;
  const peak = full.reduce((a, b) => (b.n > a.n ? b : a));
  const last = full[full.length - 1];
  const pct = peak.n ? Math.round(((last.n - peak.n) / peak.n) * 100) : 0;
  return { peak, last, pct: pct <= -100 && last.n > 0 ? -99 : pct };
}

/** Whole percents of `counts` that add up to 100 (largest remainders; all 0 for none). Pure. */
function tcPcts_(counts) {
  const total = counts.reduce((a, b) => a + b, 0);
  if (!total) return counts.map(() => 0);
  const raw = counts.map(n => (n * 100) / total);
  const out = raw.map(Math.floor);
  let left = 100 - out.reduce((a, b) => a + b, 0);
  raw.map((r, i) => [r - out[i], i]).sort((a, b) => b[0] - a[0]).forEach(([, i]) => {
    if (left > 0) { out[i]++; left--; }
  });
  return out;
}

/** "37%", or "<1%" for a few. Pure. */
function tcPct_(pct, n) { return !pct && n > 0 ? '<1%' : `${pct}%`; }

/** 6030 -> "6,030". Pure. */
function tcNum_(n) { return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

/** 18368 -> "18.4K", 1137140 -> "1.1M", 944 -> "944". Pure. */
function tcCompact_(n) {
  const v = Number(n) || 0;
  const cut = (x, unit) => `${(Math.round(x * 10) / 10).toFixed(1).replace(/\.0$/, '')}${unit}`;
  if (v >= 1e6 || Math.round(v / 100) >= 10000) return cut(v / 1e6, 'M');
  if (v >= 1e3) return cut(v / 1e3, 'K');
  return String(Math.round(v));
}

// --------------------------------------------------------------------------------------------------------------
// Times: PT for the write-up (as the team writes them); "since …" in any US zone or UTC (pure)
// --------------------------------------------------------------------------------------------------------------

/** The UTC offset (minutes) of `zone` (PT, MT, CT, ET or UTC) at `ms`: US daylight time from the 2nd Sunday of March to the 1st Sunday of November, 2am local. Pure. */
function tcOffsetMin_(ms, zone) {
  if (zone === 'UTC') return 0;
  const base = (TC_ZONES_[zone] === undefined ? TC_ZONES_.PT : TC_ZONES_[zone]) * 60;
  const y = new Date(ms + base * 60000).getUTCFullYear();
  const sunday = (month, nth) => 1 + ((7 - new Date(Date.UTC(y, month, 1)).getUTCDay()) % 7) + 7 * (nth - 1);
  const from = Date.UTC(y, 2, sunday(2, 2), 2) - base * 60000;
  const to = Date.UTC(y, 10, sunday(10, 1), 2) - (base + 60) * 60000;
  return ms >= from && ms < to ? base + 60 : base;
}

/** `ms` in `zone`: {y, mo, d, h, mi}. Pure. */
function tcLocal_(ms, zone) {
  const d = new Date(ms + tcOffsetMin_(ms, zone) * 60000);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes() };
}

/** A time in `zone` as ms. Pure. */
function tcFromLocal_(y, mo, d, h, mi, zone) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const at = guess - tcOffsetMin_(guess, zone) * 60000;
  return guess - tcOffsetMin_(at, zone) * 60000;
}

/** "10am" / "6:05am" (PT). Pure. */
function tcClock_(ms) {
  const l = tcLocal_(ms, 'PT');
  return `${l.h % 12 || 12}${l.mi ? ':' + String(l.mi).padStart(2, '0') : ''}${l.h < 12 ? 'am' : 'pm'}`;
}

/** "11/2" (PT). Pure. */
function tcDay_(ms) {
  const l = tcLocal_(ms, 'PT');
  return `${l.mo}/${l.d}`;
}

/** "10am PT" on `now`'s day (PT), else "10am PT on 10/28". Pure. */
function tcWhen_(ms, now) { return `${tcClock_(ms)} PT${tcDay_(ms) === tcDay_(now) ? '' : ' on ' + tcDay_(ms)}`; }

/**
 * "since …" -> the start of that hour (ms; Brandwatch counts by hour), or 0 when it can't be read or isn't within the
 * last TC_SINCE_MAX_MS_. PT unless another US zone or UTC is named: "9am", "9:30 am ET", "14:00", "noon", "10/28 9am",
 * "9am on 10/28/26", "10/28" (its midnight), "yesterday 9pm". A time with no date is the latest one not in the future. Pure.
 */
function tcParseSince_(raw, now) {
  const s = String(raw || '').toLowerCase().replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return 0;
  const z = (s.match(/\b(pt|pst|pdt|pacific|mt|mst|mdt|mountain|ct|cst|cdt|central|et|est|edt|eastern|utc|gmt)\b/) || [])[1] || 'pt';
  const zone = /^(?:pt|pst|pdt|pacific)$/.test(z) ? 'PT' : /^(?:mt|mst|mdt|mountain)$/.test(z) ? 'MT'
    : /^(?:ct|cst|cdt|central)$/.test(z) ? 'CT' : /^(?:et|est|edt|eastern)$/.test(z) ? 'ET' : 'UTC';
  let h = -1;
  let mi = 0;
  const ampm = s.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
  const h24 = s.match(/\b(\d{1,2}):(\d{2})\b/);
  if (ampm) {
    const hh = Number(ampm[1]);
    if (hh < 1 || hh > 12) return 0;
    h = (hh % 12) + (ampm[3] === 'pm' ? 12 : 0);
    mi = Number(ampm[2] || 0);
  } else if (h24) {
    h = Number(h24[1]);
    mi = Number(h24[2]);
  } else if (/\bnoon\b/.test(s)) {
    h = 12;
  } else if (/\bmidnight\b/.test(s)) {
    h = 0;
  }
  const date = s.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?\b/);
  if ((h < 0 && !date) || h > 23 || mi > 59) return 0;
  if (h < 0) h = 0;
  let at;
  if (date) {
    const mo = Number(date[1]);
    const d = Number(date[2]);
    let y = date[3] ? Number(date[3]) + (date[3].length === 2 ? 2000 : 0) : tcLocal_(now, zone).y;
    at = tcFromLocal_(y, mo, d, h, mi, zone);
    if (!date[3] && at > now) at = tcFromLocal_(--y, mo, d, h, mi, zone);  // "12/31" asked on 1/1
    const back = tcLocal_(at, zone);
    if (back.mo !== mo || back.d !== d) return 0;  // 2/31
  } else {
    const day = tcLocal_(/\byesterday\b/.test(s) ? now - 24 * TC_HOUR_MS_ : now, zone);
    at = tcFromLocal_(day.y, day.mo, day.d, h, mi, zone);
    if (at > now && !/\byesterday\b/.test(s)) {
      const before = tcLocal_(now - 24 * TC_HOUR_MS_, zone);
      at = tcFromLocal_(before.y, before.mo, before.d, h, mi, zone);
    }
  }
  if (!(at > 0) || at > now || now - at > TC_SINCE_MAX_MS_) return 0;
  return tcFloorHour_(at);
}

// --------------------------------------------------------------------------------------------------------------
// Gemini: the summary sentence, the negativity drivers and the themes
// --------------------------------------------------------------------------------------------------------------

/**
 * Gemini's {summary, drivers, themes} from the write-up's numbers (`d`) and the posts read (`posts`, with their words),
 * or {why} (no posts, no time, or Gemini failed: the write-up goes out without them, saying why). Never throws.
 */
function tcGemini_(d, posts, deadline) {
  if (!posts.length) return { why: 'no posts with words to read' };
  if (deadline - Date.now() < TC_GEMINI_MIN_LEFT_MS_) return { why: 'not enough time left in this run' };
  try {
    const out = geminiGenerate_(TC_SYSTEM_, tcPrompt_(d, posts), TC_SCHEMA_, { deadline, tries: 2 }) || {};
    const clean = v => truncate_(String(v === undefined || v === null ? '' : v).replace(/\s+/g, ' ').trim(), 900);
    const g = { summary: clean(out.summary), drivers: clean(out.negativity_drivers), themes: clean(out.themes) };
    if (!g.summary && !g.drivers && !g.themes) return { why: 'Gemini gave no answer' };
    return g;
  } catch (e) {
    return { why: `Gemini: ${truncate_(String((e && e.message) || e), 120)}` };
  }
}

/** What Gemini is asked: the issue, its numbers, and the numbered posts (for grounded [phrase](#N) links). Pure. */
function tcPrompt_(d, posts) {
  const s = d.sentiment || {};
  const sent = ['negative', 'neutral', 'positive'];
  const pcts = tcPcts_(sent.map(k => Number(s[k]) || 0));
  const srcPcts = tcPcts_((d.sources || []).map(x => x.n));
  const lines = [
    `Issue: ${d.issue} (Brandwatch query "${d.query.name}")`,
    `Counted from ${tcWhen_(d.start.at, d.now)} to ${tcWhen_(d.now, d.now)}: ${tcNum_(d.total)} mentions; sentiment ` +
      sent.map((k, i) => `${pcts[i]}% ${k}`).join(', ') + '; sources ' +
      (d.sources || []).slice(0, 5).map((x, i) => `${x.label} ${srcPcts[i]}%`).join(', ') + '.',
    tcVelocityText_(d.velocity, d.now),
  ];
  if (d.update) lines.push(`This is an update: the last one was at ${tcWhen_(d.update.at, d.now)}, with ${tcNum_(d.update.tot)} mentions.`);
  lines.push('', 'Posts (the most engagement first; "negative" is Brandwatch\'s sentiment):');
  posts.forEach((p, i) => {
    lines.push(`${i + 1}. [${p.source}] ${p.author || 'unknown'} (${tcEngText_(p)}${p.negative ? ', negative' : ''}): ` +
      truncate_(String(p.text).replace(/\s+/g, ' '), TC_GEMINI_POST_CHARS_));
  });
  lines.push('', 'Return JSON:',
    '- summary: one or two sentences (at most 60 words) on where the conversation is now: what most posts say and where it is heading. ' +
      'No numbers: the write-up already gives the counts, the peak and the velocity.',
    '- negativity_drivers: two to three sentences (at most 85 words) on what drives the negative posts; "No clear negativity ' +
      'drivers in the posts read." when there are none.',
    '- themes: two to three sentences (at most 85 words) on the other themes (questions, technical discussion, jokes, defenses ' +
      'of Google, official responses, press coverage).',
    `- Inline post links: when attributing a specific reaction, claim, or outlet/public-figure post in negativity_drivers or themes ` +
      `(and optionally summary) to one of the numbered posts above, weave 1 to 3 short inline references using [short phrase](#N) ` +
      `where N is the post's number above (1..${posts.length}), e.g. "users criticized [the incident response](#3)" or ` +
      `"[SkyNews](#2) reported the outage". Never invent URLs or cite numbers outside 1..${posts.length}.`);
  return lines.join('\n');
}

/**
 * Turns Gemini's prose with grounded `[phrase](#N)` post references into `{html, text}`: links `phrase` in HTML when
 * `posts[N - 1].url` is an http(s) URL (otherwise plain escaped `phrase`), and strips the `(#N)` marker in plain text. Pure.
 */
function tcRichText_(raw, posts) {
  const s = String(raw || '');
  if (!s) return { html: '', text: '' };
  const rx = /\[([^\[\]\r\n]{1,80})\]\(#(?:post-?)?(\d+)\)/gi;
  let html = '';
  let text = '';
  let last = 0;
  let m;
  while ((m = rx.exec(s)) !== null) {
    const before = s.slice(last, m.index);
    html += htmlEsc_(before);
    text += before;
    const phrase = m[1];
    const idx = Number(m[2]) - 1;
    const item = idx >= 0 && Array.isArray(posts) ? posts[idx] : null;
    const url = item && /^https?:\/\/\S+$/i.test(String(item.url || '')) ? String(item.url) : '';
    html += url ? `<a href="${htmlEsc_(url)}" style="color:#1155cc">${htmlEsc_(phrase)}</a>` : htmlEsc_(phrase);
    text += phrase;
    last = m.index + m[0].length;
  }
  const tail = s.slice(last);
  html += htmlEsc_(tail);
  text += tail;
  return { html, text };
}

// --------------------------------------------------------------------------------------------------------------
// The email (the team's UPDATED STANDARD TEMPLATE, docs.docx) and the bot's replies in Chat
// --------------------------------------------------------------------------------------------------------------

/** A post's engagement for Gemini: X's likes and replies (X's embed data), else Brandwatch's engagements ("1 reply", not "1 replies"). Pure. */
function tcEngText_(p) {
  const n = (v, one, many) => `${tcCompact_(v)} ${Number(v) === 1 ? one : many}`;
  if (p.x) return `${n(p.likes, 'like', 'likes')}, ${n(p.replies, 'reply', 'replies')}`;
  return p.eng === null || p.eng === undefined ? 'no engagement data' : n(p.eng, 'engagement', 'engagements');
}

/** Velocity with its numbers, for Gemini (the email's own words: tcTemplateVelocity_). Pure. */
function tcVelocityText_(v, now) {
  if (!v) return 'Velocity: too early to tell (its first full hour isn\'t over).';
  if (v.last.n >= v.peak.n) return `Velocity is at its peak (${tcNum_(v.last.n)} mentions in the last full hour, ${tcClock_(v.last.at)} PT).`;
  return `Velocity is ${v.pct}% since the peak at ${tcWhen_(v.peak.at, now)} (${tcNum_(v.peak.n)} mentions that hour; ` +
    `${tcNum_(v.last.n)} in the last full hour).`;
}

/** "58% neutral, 38% negative, and 4% positive." (the most first, as the team writes it). Pure. */
function tcSentimentText_(s) {
  const keys = ['negative', 'neutral', 'positive'];
  const counts = keys.map(k => Number((s || {})[k]) || 0);
  if (!counts.some(Boolean)) return 'not scored yet.';
  const pcts = tcPcts_(counts);
  const parts = keys.map((k, i) => ({ k, n: counts[i], p: pcts[i] })).sort((a, b) => b.n - a.n)
    .map(x => `${tcPct_(x.p, x.n)} ${x.k}`);
  return `${parts[0]}, ${parts[1]}, and ${parts[2]}.`;
}

/**
 * Shared ranked source breakdown ("<lead> X (84%), followed by Bluesky (7%) and Reddit (5%), (other sources: 4%)."):
 * top 3 sources plus `(other sources: X%)` when 4+ non-zero sources exist, percents summing to 100. Pure.
 */
function tcRankedSourcesText_(lead, sources) {
  const list = (sources || []).filter(x => x && x.n > 0);
  if (!list.length) return 'none yet.';
  if (list.length === 1) return `${lead} ${list[0].label} (100%).`;
  if (list.length === 2) {
    const pcts = tcPcts_([list[0].n, list[1].n]);
    return `${lead} ${list[0].label} (${tcPct_(pcts[0], list[0].n)}), followed by ${list[1].label} (${tcPct_(pcts[1], list[1].n)}).`;
  }
  const rest = list.slice(3).reduce((a, x) => a + x.n, 0);
  const pcts = tcPcts_(rest > 0 ? [list[0].n, list[1].n, list[2].n, rest] : [list[0].n, list[1].n, list[2].n]);
  const top3 = `${lead} ${list[0].label} (${tcPct_(pcts[0], list[0].n)}), followed by ${list[1].label} ` +
    `(${tcPct_(pcts[1], list[1].n)}) and ${list[2].label} (${tcPct_(pcts[2], list[2].n)})`;
  return rest > 0 ? `${top3}, (other sources: ${tcPct_(pcts[3], rest)}).` : `${top3}.`;
}

/** Mentions Volume line ("Mentions are highest on X (84%), followed by Bluesky (7%) and Reddit (5%), (other sources: 4%)."). Pure. */
function tcMentionsVolumeText_(sources) {
  return tcRankedSourcesText_('Mentions are highest on', sources);
}

/** Engagement Volume line ("Engagement (likes, comments, shares) is highest on X (54%), followed by Instagram (36%) and Facebook (8%)."). Pure. */
function tcEngagementVolumeText_(sources) {
  return tcRankedSourcesText_('Engagement (likes, comments, shares) is highest on', sources);
}

/**
 * Mention Types line ("Mentions are primarily reposts (58%), followed by comments (28%), with original posts accounting
 * for 14% of all mentions."). Pure.
 */
function tcMentionTypesText_(types) {
  const list = (types || []).filter(x => x && x.n > 0).slice(0, 3);
  if (!list.length) return 'none yet.';
  if (list.length === 1) return `Mentions are primarily ${list[0].label} (100%).`;
  const pcts = tcPcts_(list.map(x => x.n));
  if (list.length === 2) {
    return `Mentions are primarily ${list[0].label} (${tcPct_(pcts[0], list[0].n)}), with ${list[1].label} accounting for ` +
      `${tcPct_(pcts[1], list[1].n)} of all mentions.`;
  }
  return `Mentions are primarily ${list[0].label} (${tcPct_(pcts[0], list[0].n)}), followed by ${list[1].label} ` +
    `(${tcPct_(pcts[1], list[1].n)}), with ${list[2].label} accounting for ${tcPct_(pcts[2], list[2].n)} of all mentions.`;
}

/** "2am" (PT, the hour: the team's titles name the hour the data runs to). Pure. */
function tcHourLabel_(ms) {
  const l = tcLocal_(ms, 'PT');
  return `${l.h % 12 || 12}${l.h < 12 ? 'am' : 'pm'}`;
}

/** The template's title: "(11/2) 2020 Election Query Results (2am PT)". Pure. */
function tcTitle_(d) { return `(${tcDay_(d.now)}) ${d.issue} (${tcHourLabel_(d.now)} PT)`; }

/** The hourly chart's title: "(10/21) Cloud Service Outage 9am PT". Pure. */
function tcChartTitle_(d) { return `(${tcDay_(d.now)}) ${d.issue} ${tcHourLabel_(d.now)} PT`; }

/** An hour's X-axis label on the volume chart: "(10/20) 6AM" (PT). Pure. */
function tcChartTick_(ms) {
  const l = tcLocal_(ms, 'PT');
  return `(${l.mo}/${l.d}) ${l.h % 12 || 12}${l.h < 12 ? 'AM' : 'PM'}`;
}

/**
 * Builds the inline hourly mentions PNG chart (`[{cid: 'tc-chart', mime: 'image/png', name, base64}]`) using Apps Script's
 * zero-scope `Charts` service (`960 x 270`, well inside its 400,000-pixel cap). Returns `[]` when fewer than 2 hours exist
 * or `Charts` is unavailable / fails (never throws).
 */
function tcChartInline_(d) {
  try {
    if (typeof Charts === 'undefined' || !Charts || !Charts.newLineChart || !Charts.newDataTable) return [];
    const cur = tcFloorHour_(d.now);
    let pts = (d.hours || []).filter(h => h && h.at < cur);
    if (pts.length < 2) pts = (d.hours || []).filter(Boolean);
    if (pts.length < 2) return [];
    const step = pts.length <= 8 ? 1 : pts.length <= 18 ? 3 : pts.length <= 42 ? 6 : pts.length <= 84 ? 12 : 24;
    const table = Charts.newDataTable()
      .addColumn(Charts.ColumnType.STRING, 'Hour')
      .addColumn(Charts.ColumnType.NUMBER, 'Mentions');
    pts.forEach(h => table.addRow([tcChartTick_(h.at), Number(h.n) || 0]));
    const builder = Charts.newLineChart()
      .setDataTable(table.build())
      .setDimensions(960, 270)
      .setTitle(tcChartTitle_(d))
      .setLegendPosition(Charts.Position.NONE)
      .setColors(['#4285f4'])
      .setBackgroundColor('#ffffff')
      .setOption('lineWidth', 3)
      .setOption('chartArea', { left: 68, right: 18, top: 44, bottom: 42 })
      .setOption('hAxis', { showTextEvery: step, slantedText: false, maxAlternation: 1,
        textStyle: { color: '#000000', fontSize: 11 }, gridlines: { color: '#cccccc' } })
      .setOption('vAxis', { minValue: 0, baselineColor: '#202124',
        gridlines: { color: '#cccccc', count: 6 }, textStyle: { color: '#000000', fontSize: 12 } });
    if (Charts.newTextStyle && builder.setTitleTextStyle) {
      builder.setTitleTextStyle(Charts.newTextStyle().setColor('#000000').setFontSize(15).setBold(true).build());
    }
    const bytes = builder.build().getAs('image/png').getBytes();
    if (!bytes || !bytes.length) return [];
    return [{ cid: 'tc-chart', mime: 'image/png', name: 'temp-check-volume.png', base64: Utilities.base64Encode(bytes) }];
  } catch (e) {
    console.warn(`temp check chart: ${(e && e.message) || e}`);
    return [];
  }
}

/** The template's velocity: "Velocity is -76% since the peak at 12pm PT today." / "… on 10/28." / "Velocity is at its peak (520 mentions/hr)." Pure. */
function tcTemplateVelocity_(v, now) {
  if (!v) return 'Velocity is at its peak (its first full hour isn\'t over yet).';
  if (v.last.n >= v.peak.n) return `Velocity is at its peak (${tcNum_(v.last.n)} mentions/hr).`;
  const day = tcDay_(v.peak.at) === tcDay_(now) ? 'today' : `on ${tcDay_(v.peak.at)}`;
  return `Velocity is ${v.pct}% since the peak at ${tcClock_(v.peak.at)} PT ${day}.`;
}

/**
 * The TL;DR's first sentence, as the team writes it: "There have been 7,322 total mentions regarding <issue>."; "Since
 * 12pm PT on 10/29 there have been 346 total mentions regarding <issue>." (a count from a time asked for); "Since the
 * last update at 9am PT, there have been 654 new mentions (25.1K total mentions) regarding <issue>." Pure.
 */
function tcLead_(d) {
  if (d.update) {
    const day = tcDay_(d.update.at) === tcDay_(d.now) ? '' : ` on ${tcDay_(d.update.at)}`;
    const total = d.total >= 10000 ? tcCompact_(d.total) : tcNum_(d.total);
    return `Since the last update at ${tcHourLabel_(d.update.at)} PT${day}, there have been ` +
      `${tcNum_(Math.max(0, d.total - d.update.tot))} new mentions (${total} total mentions) regarding ${d.issue}.`;
  }
  if (d.start && d.start.why === 'since') {
    return `Since ${tcWhen_(d.start.at, d.now)} there have been ${tcNum_(d.total)} total mentions regarding ${d.issue}.`;
  }
  return `There have been ${tcNum_(d.total)} total mentions regarding ${d.issue}.`;
}

/** HTML form of tcLead_ with bold mention counts, matching the team's email styling. Pure. */
function tcLeadHtml_(d) {
  const issue = htmlEsc_(d.issue);
  if (d.update) {
    const day = tcDay_(d.update.at) === tcDay_(d.now) ? '' : ` on ${tcDay_(d.update.at)}`;
    const total = d.total >= 10000 ? tcCompact_(d.total) : tcNum_(d.total);
    return `Since the last update at ${tcHourLabel_(d.update.at)} PT${day}, there have been ` +
      `<b>${tcNum_(Math.max(0, d.total - d.update.tot))} new mentions</b> (<b>${total} total mentions</b>) regarding ${issue}.`;
  }
  if (d.start && d.start.why === 'since') {
    return `Since ${htmlEsc_(tcWhen_(d.start.at, d.now))} there have been <b>${tcNum_(d.total)} total mentions</b> regarding ${issue}.`;
  }
  return `There have been <b>${tcNum_(d.total)} total mentions</b> regarding ${issue}.`;
}

/**
 * A highest-engaging post as the template writes it, "[Author on Source]: \"[Post Text]\" (# Engagements)": {html, text},
 * the bold underlined source ("bbcnews on IG") linking to the post. Falls back to "Post on IG" (never a bare domain) when
 * no author handle is available. X's engagement is its likes and replies (X's embed data); others', Brandwatch's. Pure.
 */
function tcEmailPost_(p) {
  const src = TC_POST_SOURCES_[p.source] || p.source;
  const who = tcCleanHandle_(p.author);
  const source = who ? `${who} on ${src}` : `Post on ${src}`;
  const n = p.x ? (Number(p.likes) || 0) + (Number(p.replies) || 0) : p.eng;
  const eng = n === null || n === undefined ? 'Engagements not available' : `${tcCompact_(n)} Engagements`;
  const words = truncate_(String(p.text).replace(/\s+/g, ' ').trim(), TC_EMAIL_POST_CHARS_);
  const labelHtml = p.url
    ? `<a href="${htmlEsc_(p.url)}" style="color:#202124;font-weight:bold;text-decoration:underline">${htmlEsc_(source)}</a>`
    : `<b>${htmlEsc_(source)}</b>`;
  return {
    html: `${labelHtml}: "${htmlEsc_(words)}" (${eng})`,
    text: `${source}: "${words}" (${eng})${p.url ? ` <${p.url}>` : ''}`,
  };
}

/**
 * The temp check email in the team's UPDATED STANDARD TEMPLATE (docs.docx): the title and BW source (linked to the
 * Brandwatch dashboard when available); the TL;DR (total mentions, the 12-month benchmark placeholder linked to
 * go/bs-database, velocity, Gemini's summary); the inline hourly mentions chart (`cid:tc-chart`); standalone Sentiment,
 * Negativity Drivers and Themes paragraphs (with grounded inline post links); Mentions Volume, Mention Types and
 * Engagement Volume breakdowns; and up to 7 Highest Engaging Posts. Returns `{subject, html, text, inline}`.
 */
function tempCheckEmail_(d) {
  const g = d.gem || {};
  const linkPosts = d.linkPosts || d.posts || [];
  const summary = g.summary ? tcRichText_(g.summary, linkPosts) : { html: '', text: '' };
  const tldrText = [tcLead_(d), TC_LEVEL_TBD_, tcTemplateVelocity_(d.velocity, d.now), summary.text].filter(Boolean).join(' ');
  const tldrHtml = [tcLeadHtml_(d), TC_LEVEL_TBD_HTML_, htmlEsc_(tcTemplateVelocity_(d.velocity, d.now)), summary.html]
    .filter(Boolean).join(' ');
  const drivers = g.drivers ? tcRichText_(g.drivers, linkPosts)
    : { html: htmlEsc_('[example 1, example 2, etc.]'), text: '[example 1, example 2, etc.]' };
  const themes = g.themes ? tcRichText_(g.themes, linkPosts)
    : { html: htmlEsc_('[Highlight any major positive / neutral themes here].'), text: '[Highlight any major positive / neutral themes here].' };
  const posts = (d.posts || []).slice(0, TC_EMAIL_POSTS_).map(tcEmailPost_);
  if (!posts.length) {
    posts.push({ html: '[Author on Source]: "[Post Text]" (# Engagements)', text: '[Author on Source]: "[Post Text]" (# Engagements)' });
  }
  const bw = d.bwUrl || `https://app.brandwatch.com/project/${PW_BW_PROJECT_}/queries`;
  const sentiment = tcSentimentText_(d.sentiment);
  const mentionsVol = tcMentionsVolumeText_(d.sources);
  const mentionTypes = tcMentionTypesText_(d.mentionTypes);
  const engVol = tcEngagementVolumeText_(d.engSources);
  const inline = Number(d.total) === 0 ? [] : tcChartInline_(d);
  const e = htmlEsc_;
  const p = (body, last) => `<p style="margin:0 0 ${last ? 4 : 14}px">${body}</p>`;
  const ul = items => `<ul style="margin:0 0 14px 0;padding-left:28px">${items.map(i => `<li style="margin:0 0 4px">${i}</li>`).join('')}</ul>`;
  const chartHtml = inline.length
    ? p(`<img src="cid:tc-chart" alt="${e(tcChartTitle_(d))}" width="680" style="display:block;max-width:100%;height:auto;border:0">`)
    : '';
  const html = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#202124">' +
    p(`<b>${e(tcTitle_(d))}</b><br><b>BW source:</b> <a href="${e(bw)}" style="color:#1155cc"><b>Link</b></a>`) +
    p(`<b>TL;DR:</b> ${tldrHtml}`) +
    chartHtml +
    p(`<b>Sentiment:</b> ${e(sentiment)}`) +
    p(`<b>Negativity Drivers:</b> ${drivers.html}`) +
    p(`<b>Themes:</b> ${themes.html}`) +
    p(`<b>Mentions Volume:</b> ${e(mentionsVol)}`) +
    p(`<b>Mention Types:</b> ${e(mentionTypes)}`) +
    p(`<b>Engagement Volume:</b> ${e(engVol)}`) +
    p('<b>Highest Engaging Posts:</b>', true) +
    ul(posts.map(x => x.html)) +
    '</div>';
  const text = [
    tcTitle_(d),
    `BW source: Link <${bw}>`,
    '',
    `TL;DR: ${tldrText}`,
    '',
    `Sentiment: ${sentiment}`,
    '',
    `Negativity Drivers: ${drivers.text}`,
    '',
    `Themes: ${themes.text}`,
    '',
    `Mentions Volume: ${mentionsVol}`,
    '',
    `Mention Types: ${mentionTypes}`,
    '',
    `Engagement Volume: ${engVol}`,
    '',
    'Highest Engaging Posts:',
  ].concat(posts.map(x => `  • ${x.text}`)).join('\n');
  return { subject: `Temp Check: ${d.issue}`, html, text, inline };
}

/** "which query?": the newest [G EVENT] queries, to copy. Pure. */
function tcWhichText_(list, now) {
  const newest = (list || []).filter(q => TC_GEVENT_RX_.test(q.name)).sort((a, b) => Number(b.id) - Number(a.id)).slice(0, 5);
  return [`${TC_HEAD_} *Temp check:* which Brandwatch query? Reply here with "temp check" and its name (or its link).` +
    (newest.length ? ' The newest [G EVENT] queries:' : '')]
    .concat(newest.map(q => `• ${q.name}${q.created ? ` (made ${tcWhen_(q.created, now)})` : ''}`)).join('\n');
}

/** No query, or several, for `ref` (tcFindQuery_'s answer `found`). Pure. */
function tcNotFoundText_(ref, found, now) {
  const r = truncate_(String(ref).replace(/\s+/g, ' '), 100);
  const list = q => `• ${q.name}${q.created ? ` (made ${tcWhen_(q.created, now)})` : ''}`;
  if (found.missing) {
    return `${TC_HEAD_} *Temp check:* there's no query ${found.missing} in [SLRR] Private (the project the team's [G EVENT] ` +
      'queries are in). Reply with "temp check" and the query\'s name.';
  }
  if ((found.choices || []).length) {
    return [`${TC_HEAD_} *Temp check:* more than one Brandwatch query matches "${r}". Reply with "temp check" and the exact name:`]
      .concat(found.choices.map(list)).join('\n');
  }
  return [`${TC_HEAD_} *Temp check:* no Brandwatch query in [SLRR] Private matches "${r}". Reply with "temp check" and the ` +
    `exact name (or the query's link).${(found.near || []).length ? ' The closest:' : ''}`]
    .concat((found.near || []).map(list)).join('\n');
}

/** Why a request couldn't be done (after TC_TRIES_ runs, or TC_MAX_AGE_MS_). Pure. */
function tcGaveUpText_(job, why) {
  const ask = tempCheckAsk_(job && job.tx);
  const what = ask && ask.ref ? ` for "${truncate_(ask.ref, 80)}"` : '';
  const reason = /Brandwatch HTTP (?:429|5\d\d)/.test(String(why || ''))
    ? 'Brandwatch stayed busy for 30 minutes (the shared login\'s limit of calls; other tools use it too)'
    : truncate_(String(why || 'unknown'), 200);
  return `${TC_HEAD_} *Temp check:* couldn't do it${what}: ${reason}. Ask again to try again.`;
}

// --------------------------------------------------------------------------------------------------------------
// What's kept (script properties)
// --------------------------------------------------------------------------------------------------------------

function tcRead_(prop, fallback) {
  try {
    const v = JSON.parse(PropertiesService.getScriptProperties().getProperty(prop) || 'null');
    return v === null || v === undefined ? fallback : v;
  } catch (e) {
    return fallback;
  }
}

function tcWrite_(prop, value) { PropertiesService.getScriptProperties().setProperty(prop, JSON.stringify(value)); }

/** Thread `thread`'s last temp check ({sp, q, n, c, s, w, at, tot}), or null. Never throws. */
function tcThread_(thread) {
  if (!thread) return null;
  const all = tcRead_(TC_THREADS_PROP_, {});
  const st = all && typeof all === 'object' ? all[thread] : null;
  return st && Date.now() - Number(st.at || 0) < TC_THREAD_KEEP_MS_ ? st : null;
}

/** Keeps thread `thread`'s temp check (the newest TC_THREADS_MAX_ threads, for TC_THREAD_KEEP_MS_). */
function tcSaveThread_(thread, state) {
  if (!thread) return;
  const all = tcRead_(TC_THREADS_PROP_, {});
  const cur = all && typeof all === 'object' && !Array.isArray(all) ? all : {};
  cur[thread] = state;
  const kept = Object.keys(cur).filter(k => cur[k] && Date.now() - Number(cur[k].at || 0) < TC_THREAD_KEEP_MS_)
    .sort((a, b) => Number(cur[b].at) - Number(cur[a].at)).slice(0, TC_THREADS_MAX_);
  tcWrite_(TC_THREADS_PROP_, Object.fromEntries(kept.map(k => [k, cur[k]])));
}
