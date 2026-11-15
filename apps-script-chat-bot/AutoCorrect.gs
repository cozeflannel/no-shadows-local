/**
 * AutoCorrect.gs — the auto-correct test space: the bot fixes Burson's alerts itself, beside the Mirror space.
 *
 * Set it on the Control tab in B10 ("Auto-correct space"): a Google-only test space. Every minute, right after the
 * Mirror space's run (which this never changes), the bot:
 *   1. reads new top-level Zapier alerts in the live Burson space (S-F Burson: the space in the Control tab's B25),
 *      strictly read only: nothing is ever posted, reacted or answered there (guardedChat_ refuses it, and Bot.gs never
 *      tries). While B25 is blank or can't be found it doesn't run (C10 says so); when B25 changes, it starts from the
 *      new space's last 15 minutes;
 *   2. reviews each alert as it does everywhere (the rules, Gemini, the post itself, the listening feeds), except that the
 *      agentic assistant decides: Gemini's value is applied from settings.autocorrect_min_confidence, with nothing left
 *      for a reader to double-check, and the same review call writes the summary paragraph (Review.gs writeupOf_);
 *   3. posts the corrected alert, in Burson's own format, to the auto-correct space, under the bot's own first line ("✅
 *      *Reviewed and corrected by the agentic assistant* · Original alert", linking to Burson's message: Voice.gs
 *      reviewedLine_), with the write-up in the summary's place and the post's own picture, then a note in its thread on
 *      who changed what ("- Product: Gems to Gemini App") and anything only Burson can add ("Not fixed: …"). It never
 *      asks Burson for fixes: it makes them (with "Never wait on Burson" ON, Control row 23, it doesn't wait on what only
 *      Burson can add either: it goes on without it);
 *   4. works the alert there as an IM would: legend emojis, the Social Alert email (only to the stand-in while testing,
 *      its subject starting "[Auto-correct test]"), the pre-filled T&S test-form link in the alert's thread, the 🧑‍💻 DM
 *      (stand-in), and answers to questions people ask in that space.
 * When the IMs in the live space ask Burson for fixes and Burson resends, the resend is recognized as the same alert
 * (a thread note when it changes something; a new alert when the priority or engagement went up).
 *
 * Its records are kept apart from the Mirror's: its own cursor and memory (AC:), Message-log keys (ac|) and Alerts-log
 * partition ("… (auto-correct)"), so the Results tab can show the two side by side.
 */

const AC_ROW_ = 10;
const AC_LABEL_ = 'Auto-correct space';
const AC_HINT_ = 'Leave blank, or paste a Google-only test space link: live Burson alerts are posted there, corrected by the bot.';
const AC_TAG_ = 'Auto-correct test';              // on its emails and DMs, to tell them apart from the Mirror space's
const AC_PARTITION_SUFFIX_ = ' (auto-correct)';   // on its rows in the Alerts log
const AC_BUDGET_MS_ = 150 * 1000;                 // its share of a run, after the Mirror space's
const AC_STANDALONE_BUDGET_MS_ = 220 * 1000;      // its share when B10 runs standalone (B3/B4/B9 not running ahead of it)
const AC_LATEST_MS_ = 240 * 1000;                 // it stops starting new alerts 4 minutes into a run (Apps Script stops at 6)
const AC_STANDALONE_LATEST_MS_ = 260 * 1000;      // standalone latest stop (leaves 40s before RUN_HARD_STOP_MS_ for watches/Speed)
const AC_MIN_MS_ = 30 * 1000;                     // less than this left: it waits for the next minute
const AC_STATS_PROP_ = 'AC_STATS';
const AC_LIVE_NAME_ = 'Burson space (live, read only)';

/** Sets the auto-correct space on the Control tab (B10) and runs one pass now. From the Apps Script editor or clasp. */
function startAutoCorrect(spaceLinkOrName) {
  const target = String(spaceLinkOrName === undefined || spaceLinkOrName === null ? '' : spaceLinkOrName).trim();
  if (!target) throw new Error('Pass the test space\'s link or name to startAutoCorrect("..."), or paste it in cell B10 on the Control tab.');
  const ss = openStore_(true);
  const control = controlTab_(ss) || ensureControlTab_(ss, Session.getEffectiveUser().getEmail());
  ensureAutoCorrectRow_(control);
  ensureSfBursonRow_(control);
  const space = resolveAutoCorrectSpace_(target);
  const wanted = readControl_(control);
  const problem = autoCorrectProblem_(space, wanted, null, sfBursonFor_(control, wanted, true).space);
  if (problem) throw new Error(problem);
  control.getRange(AC_ROW_, 2).setValue(target);
  poll();
  return { autocorrect: space.id, name: space.name };
}

/** Clears B10 so the auto-correct space stops (the Mirror space carries on as before). */
function stopAutoCorrect() {
  const ss = openStore_(false);
  const control = controlTab_(ss);
  if (control) {
    ensureAutoCorrectRow_(control);
    control.getRange(AC_ROW_, 2).setValue('');
    writeAutoCorrectNote_(control, AC_HINT_);
  }
  PropertiesService.getScriptProperties().deleteProperty('LAST_AC_SPACE');
  return { stopped: true };
}

/**
 * One pass of the auto-correct space, run by poll() after the main (Mirror) run. Never throws: its status and any
 * problem go in C10, never in the main Status cell. `sfb`: this run's S-F Burson (Control tab B25, sfBursonFor_):
 * while none is known it doesn't run, and C10 says it needs B25. Returns {report, ctx} when it ran, else null.
 */
function runAutoCorrect_(control, wanted, ss, mainCfg, runStart, sfb, opts) {
  const props = PropertiesService.getScriptProperties();
  try {
    ensureAutoCorrectRow_(control);
    const ref = String((wanted && wanted.autocorrect) || '').trim();
    if (!ref) {
      if (props.getProperty('LAST_AC_SPACE')) props.deleteProperty('LAST_AC_SPACE');
      writeAutoCorrectNote_(control, AC_HINT_);
      return null;
    }
    if (!sfb || !sfb.space || !sfb.space.id) {  // no S-F Burson known: paused (fail closed)
      writeAutoCorrectNote_(control, sfbPausedNote_(sfb));
      return null;
    }
    const standalone = Boolean(opts && opts.standalone);
    const latest = (runStart || Date.now()) + (standalone ? AC_STANDALONE_LATEST_MS_ : AC_LATEST_MS_);
    if (latest - Date.now() < AC_MIN_MS_) {
      console.log('auto-correct space: not enough time left in this run; it carries on next minute');
      return null;
    }
    let space;
    try {
      space = resolveAutoCorrectSpace_(ref);
    } catch (e) {
      writeAutoCorrectNote_(control, `\u2717 ${truncate_(String((e && e.message) || e), 220)}`);
      return null;
    }
    const problem = autoCorrectProblem_(space, wanted, mainCfg, sfb.space);
    if (problem) {
      writeAutoCorrectNote_(control, `\u2717 ${problem}`);
      return null;
    }
    const cfg = autoCorrectCfg_(space, sfb.space);
    cfg.testers = mainCfg && Array.isArray(mainCfg.testers) ? mainCfg.testers : testersFor_(wanted ? wanted.testers : '').testers;
    const ctx = buildCtx_(cfg, ss, wanted && wanted.switches);
    ctx.settings.bq_lookback_minutes = (opts && opts.lookbackMinutes) ||
      bqLookbackFrom_(wanted && wanted.bqLookback).minutes;
    ctx.allowEarlyWave = Boolean(opts && opts.allowEarlyWave);
    ctx.allowDirectBq = Boolean(opts && opts.allowDirectBq);
    const budgetMs = standalone ? AC_STANDALONE_BUDGET_MS_ : AC_BUDGET_MS_;
    ctx.deadline = Math.min(Date.now() + budgetMs, latest);
    startFromAutoCorrect_(props, cfg, ctx);
    // Triage existing S-F Burson and B10 alerts FIRST so Direct BigQuery queries never starve aging cards in B10
    const report = runOnce_(ctx);
    const slaBusy = Boolean(report && (report.held > 0 || report.analyst_backlog ||
      report.handled >= ctx.settings.max_messages_per_run ||
      (report.errors || []).some(e => /^time budget/.test(String(e)))));
    ctx.slaBusy = slaBusy;
    let bqPolled = null;
    if (ctx.allowDirectBq && switchOn_(ctx, 'directBq') && !slaBusy) {
      Object.assign(ctx.settings, { bq_direct_poll: true, bq_poll_sprinklr: true, bq_poll_bmie: true, bq_poll_bsip: true });
      if (typeof apiGuardAllowBackground_ !== 'function' || apiGuardAllowBackground_('any', false)) {
        try { bqPolled = pollBigQuerySources_(ctx, space.id); } catch (e) {
          console.error('auto-correct direct BigQuery alerts: ' + ((e && e.message) || e));
        }
      }
    }
    if (bqPolled && (bqPolled.sprinklr || bqPolled.bmie)) {
      report.bq_sprinklr = bqPolled.sprinklr;
      report.bq_bmie = bqPolled.bmie;
    }
    if (bqPolled && bqPolled.bsip) report.bq_bsip = bqPolled.bsip;
    if (ctx.allowEarlyWave && switchOn_(ctx, 'earlyWave') &&
        (typeof apiGuardAllowBackground_ !== 'function' || apiGuardAllowBackground_('any', slaBusy))) {
      ctx._ewBqDeferEvents = true;
      try {
        earlyWaveCheck_(ctx);
      } catch (e) {
        console.error('auto-correct early detection check: ' + ((e && e.message) || e));
      }
      try {
        const drained = edDrainQueue_(ctx, report);
        if (drained && (drained.posted || drained.dropped || drained.dismissed)) console.log(`auto-correct early detection review: ${JSON.stringify(drained)}`);
      } catch (e) {
        console.error('auto-correct early detection review: ' + ((e && e.message) || e));
      } finally {
        delete ctx._ewBqDeferEvents;
        if (Array.isArray(ctx._ewBqEvents) && ctx._ewBqEvents.length) {
          const evs = ctx._ewBqEvents.slice();
          delete ctx._ewBqEvents;
          ewBqFlush_(ctx, props, () => (ctx.deadline ? ctx.deadline - ctx.now() : Infinity), { signal_events: evs });
        }
      }
    }
    ctx.recent.save();
    const today = bumpAutoCorrectStats_(props, report, dayKey_());
    const issues = report.errors.filter(e => !/^time budget/.test(e));
    if (report.handled || report.answers || report.drafts_sent || report.early_detection_alerts || issues.length) {
      console.log('auto-correct space: ' + JSON.stringify(report));
    }
    writeAutoCorrectNote_(control, issues.length
      ? `\u26a0\ufe0f ${truncate_(issues[0], 220)} The bot keeps retrying.`
      : `\u2713 ${space.name} \u00b7 ${autoCorrectTodayText_(today)}`);
    return { report, ctx };
  } catch (e) {
    console.error('auto-correct space failed: ' + ((e && e.stack) || e));
    try {
      writeAutoCorrectNote_(control, `⚠️ ${truncate_(String((e && e.message) || e), 220)} The bot tries again every minute.`);
    } catch (err) {
      console.error('could not update the Control tab: ' + err);
    }
    return null;
  }
}

/**
 * The run's setup: the live Burson space (S-F Burson, `sfb`: Control tab B25), only read, and the auto-correct space,
 * where everything is posted.
 */
function autoCorrectCfg_(space, sfb) {
  return { burson: { id: sfb.id, name: AC_LIVE_NAME_ }, analyst: space, sourceReadOnly: true, sfBurson: sfb };
}

/** Resolves a space link, id, or exact name for the auto-correct space (cached for an hour). */
function resolveAutoCorrectSpace_(value) {
  const cache = CacheService.getScriptCache();
  const cacheKey = 'ac_space:' + hashText_(String(value));
  const hit = cache.get(cacheKey);
  if (hit) return JSON.parse(hit);
  const ref = parseSpaceRef_(value, 'The auto-correct space');
  try {
    let id = ref.id;
    if (!id) {
      const props = PropertiesService.getScriptProperties();
      const prop = 'SPACE_ID:' + ref.name;
      id = props.getProperty(prop) || findSpaceByName_(ref.name, 'auto-correct space');
      props.setProperty(prop, id);
    }
    const s = chatGetSpace_(id);
    const out = { id: s.name, name: s.displayName || s.name, externalUserAllowed: !!s.externalUserAllowed };
    cache.put(cacheKey, JSON.stringify(out), 3600);
    return out;
  } catch (e) {
    throw new Error(/^No space named|spaces are named/.test(e.message) ? e.message
      : `Can't open the auto-correct space (${ref.id || ref.name}). Check the link, and that ${Session.getEffectiveUser().getEmail()} ` +
        'is a member of that space.');
  }
}

/**
 * Safety checks on the auto-correct space ('' when it's fine): never the live Burson space (S-F Burson, `sfb`: Control
 * tab B25) or a space people outside Google can join, and never a space the bot already uses (the Mirror space, or the
 * main setup's spaces), so the two tests stay apart.
 */
function autoCorrectProblem_(space, wanted, mainCfg, sfb) {
  if (!space) return '';
  if (isSfBurson_(sfb, space.id)) return 'The auto-correct space can\'t be the live Burson space. Paste a separate test space.';
  if (space.externalUserAllowed) {
    return `"${space.name || space.id}" allows people outside Google, so Burson could see it. Use a space only Google people can join.`;
  }
  const taken = [];
  if (mainCfg) ['mirror', 'burson', 'analyst'].forEach(k => { if (mainCfg[k] && mainCfg[k].id) taken.push(mainCfg[k].id); });
  const mirrorRef = String((wanted && wanted.mirror) || '').trim();
  if (mirrorRef) {
    try { taken.push(resolveMirrorSpace_(mirrorRef).id); } catch (e) { /* the Mirror's own check reports a bad link */ }
  }
  if (taken.includes(space.id)) {
    return 'The auto-correct space must be a space of its own, not the Mirror space or a space the bot already posts in.';
  }
  return '';
}

/**
 * Like startFrom_: after a pause it starts from a minute ago; a new auto-correct space, or a new S-F Burson space to
 * read (B25 changed), starts a few minutes back.
 */
function startFromAutoCorrect_(props, cfg, ctx) {
  const now = Date.now();
  const floorKey = 'AC:FLOOR:' + cfg.burson.id;  // buildCtx_ reads it back as ctx.floor
  const setFloor = ms => {
    if (!(ctx.cursor.get() >= ms)) ctx.cursor.set(ms);
    if (!(Number(props.getProperty(floorKey)) >= ms)) props.setProperty(floorKey, String(ms));
    ctx.floor = Math.max(ctx.floor || 0, ms);
  };
  if (props.getProperty('AC_PAUSED') === 'true') {
    props.deleteProperty('AC_PAUSED');
    setFloor(now - 60 * 1000);
  }
  if (props.getProperty('LAST_AC_SPACE') !== cfg.analyst.id || props.getProperty('LAST_AC_SOURCE') !== cfg.burson.id) {
    setFloor(now - ctx.settings.start_lookback_minutes * 60 * 1000);
    props.setProperty('LAST_AC_SPACE', cfg.analyst.id);
    props.setProperty('LAST_AC_SOURCE', cfg.burson.id);
  }
}

/** Today's counts for the auto-correct space (shown in C10), with this run's report added. Saved when they change. */
function bumpAutoCorrectStats_(props, report, day) {
  let s = null;
  try { s = JSON.parse(props.getProperty(AC_STATS_PROP_) || 'null'); } catch (e) { s = null; }
  if (!s || s.day !== day) s = { day, alerts: 0, corrected: 0, emails: 0, answers: 0 };
  const add = { alerts: report.alerts || 0, corrected: report.corrected || 0, emails: report.drafts_sent || 0, answers: report.answers || 0 };
  Object.keys(add).forEach(k => { s[k] = (s[k] || 0) + add[k]; });
  if (add.alerts || add.corrected || add.emails || add.answers) props.setProperty(AC_STATS_PROP_, JSON.stringify(s));
  return s;
}

/** "today: 6 alerts, 4 corrected, 1 Social Alert sent, 0 questions answered". Pure. */
function autoCorrectTodayText_(s) {
  if (!s || !(s.alerts || s.answers)) return 'no alerts yet today';
  const n = (count, one, many) => `${count} ${count === 1 ? one : many}`;
  return `today: ${n(s.alerts, 'alert', 'alerts')}, ${s.corrected || 0} corrected, ` +
    `${n(s.emails || 0, 'Social Alert', 'Social Alerts')} sent, ${n(s.answers || 0, 'question', 'questions')} answered`;
}

/**
 * The Control tab's Today (B7) while the bot works alone in the Auto-correct space (Main.gs poll()): this flow's own
 * counts for `day`, the ones C10 shows: "3 alerts, 1 corrected, 3 Social Alerts sent, 0 questions answered (in the
 * Auto-correct space, B10)"; "No alerts yet today" before the first. The main flow's counters (Control.gs todayText_)
 * never move there. Never throws.
 */
function autoCorrectTodayCell_(props, day) {
  let s = null;
  try { s = JSON.parse(props.getProperty(AC_STATS_PROP_) || 'null'); } catch (e) { s = null; }
  if (!s || s.day !== day || !(s.alerts || s.answers)) return 'No alerts yet today';
  return `${autoCorrectTodayText_(s).replace(/^today: /, '')} (in the Auto-correct space, B10)`;
}

/** Row 10 ("Auto-correct space") on the Control tab; on an older tab, "How it works" moves down a row to make room. */
function ensureAutoCorrectRow_(sh) {
  if (!sh) return;
  if (String(sh.getRange(AC_ROW_, 1).getValue() || '').trim() === AC_LABEL_) return;
  const b = sh.getRange(AC_ROW_, 2).getValue();
  sh.getRange(AC_ROW_, 1, 1, 3).setValues([[AC_LABEL_, String(b === undefined || b === null ? '' : b).trim(), AC_HINT_]]);
  sh.getRange(AC_ROW_, 1).setFontWeight('bold');
  sh.getRange(AC_ROW_, 2).setBackground('#fff8e1');
  writeControlHelp_(sh);
}

function writeAutoCorrectNote_(sh, note) {
  if (!sh) return;
  const cell = sh.getRange(AC_ROW_, 3);
  if (String(cell.getValue() || '') !== String(note || '')) cell.setValue(note || '');
}
