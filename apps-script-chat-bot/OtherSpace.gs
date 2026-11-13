/**
 * OtherSpace.gs — the Other alerts space (Control tab B33): a Google-only space the bot works every minute beside the
 * Mirror space, for alerts that aren't Burson's (a campaign space's "🚨 X Alert: …" posts, for example), while the Burson
 * side (S-F Burson in B25, the Mirror, the Relay, the Burson test copy and the Burson outbox) carries on exactly as before.
 *
 * Paste the space in B33 ("Other alerts space"). Every minute, after the main run and before the auto-correct space, the
 * bot works that space directly, as it works B25 with "Work directly in B25" (Control row 32, Main.gs directCfg_):
 *   - every top-level alert there is reviewed: one in Burson's format gets Burson's SLRR review; one in any other format
 *     gets its own triage (OtherAlerts.gs: the SLRR rules first, then the stream's own call), its note in its thread;
 *   - the bot's notes, replies and emojis go right there, and a question in an alert's thread gets the analysts' answer
 *     (Bot.gs directAnswer_);
 *   - always Testing, even while the main run is LIVE: every email only to the testers (B30, else the stand-in), the test
 *     copy of the T&S form, nothing for the leads; its emails and DMs start "[Other alerts space]";
 *   - nothing from it ever reaches S-F Burson, the Burson test copy or the Burson outbox: its run knows no S-F Burson
 *     (otherSpaceCfg_: sfBurson null, so Outbox.gs forwardOwnBurson_ passes nothing on), its chat client writes only to
 *     that space (Main.gs guardedChat_), and Chat.gs still refuses any write to this run's S-F Burson (B25). Its name and
 *     id are on the guards of what goes to S-F Burson (Outbox.gs outboxGuard_, Relay.gs relayGuard_).
 * It refuses the space in B25, a space people outside Google can join, and a space the bot already uses (the main run's
 * spaces, B9, B10 or B26): those keep working as before, and C33 says what to fix. Its status and today's counts are in
 * C33; its problems never reach the main Status (B5). Direct BigQuery alerts, the Early wave check and the Relay never run
 * here, and nothing from it is written to the SLRR tables (BigQuery.gs bqWriteBack_). Its records are its own: its
 * cursor and memory are keyed by its space, as every flow's are, and its Alert-log rows end in " (other alerts)", which
 * the Results, Follow-up and Analysis tabs leave out (Speed.gs resultsFlowOf_: they compare the bot with the IMs on
 * Burson's alerts).
 */

const OS_ROW_ = 33;
const OS_LABEL_ = 'Other alerts space';
const OS_HINT_ = 'Leave blank, or paste a Google-only space with other alerts (a campaign space, say): the bot works it ' +
  'every minute, beside the Mirror space, always Testing.';
const OS_TAG_ = 'Other alerts space';            // on its emails and DMs, to tell them apart from the Mirror space's
const OS_PARTITION_SUFFIX_ = ' (other alerts)';  // on its rows in the Alert log
const OS_BUDGET_MS_ = 150 * 1000;                // its share of a run, after the main run's
const OS_LATEST_MS_ = 260 * 1000;                // it stops starting new alerts 4m20s into a run (Apps Script stops at 6)
const OS_MIN_MS_ = 30 * 1000;                    // less than this left: it waits for the next minute
const OS_STATS_PROP_ = 'OS_STATS';
const OS_NAME_PROP_ = 'LAST_OS_NAME';            // its name, for the guards of what goes to S-F Burson
const OS_MODE_WHY_ = 'the Other alerts space (B33) is always Testing';

/**
 * One pass of the Other alerts space, run by poll() after the main run. Never throws: its status and any problem go in
 * C33, never in the main Status cell. `mainCfg`: the main run's setup (null when it stopped before it had one); `sfb`:
 * this run's B25 (Main.gs sfBursonFor_; null when the main run stopped before reading it: then it waits for the next
 * minute). Returns {report, ctx} when it ran, else null.
 */
function runOtherSpace_(control, wanted, ss, mainCfg, runStart, sfb) {
  const props = PropertiesService.getScriptProperties();
  try {
    ensureOtherSpaceRow_(control);
    const ref = String((wanted && wanted.otherSpace) || '').trim();
    if (!ref) {
      if (props.getProperty('LAST_OS_SPACE')) props.deleteProperty('LAST_OS_SPACE');
      if (props.getProperty(OS_NAME_PROP_)) props.deleteProperty(OS_NAME_PROP_);
      writeOtherSpaceNote_(control, OS_HINT_);
      return null;
    }
    if (!sfb) {  // the main run stopped before it read B25: nothing to check the space against yet
      console.log('Other alerts space: the run stopped before it read B25; it carries on next minute');
      return null;
    }
    const latest = (runStart || Date.now()) + OS_LATEST_MS_;
    if (latest - Date.now() < OS_MIN_MS_) {
      console.log('Other alerts space: not enough time left in this run; it carries on next minute');
      return null;
    }
    let space;
    try {
      space = resolveOtherSpace_(ref);
    } catch (e) {
      writeOtherSpaceNote_(control, `✗ ${truncate_(String((e && e.message) || e), 220)}`);
      return null;
    }
    const problem = otherSpaceProblem_(space, wanted, mainCfg, sfb.space);
    if (problem) {
      writeOtherSpaceNote_(control, `✗ ${problem}`);
      return null;
    }
    if (space.name && props.getProperty(OS_NAME_PROP_) !== space.name) props.setProperty(OS_NAME_PROP_, space.name);
    const cfg = otherSpaceCfg_(space);
    cfg.testers = mainCfg && Array.isArray(mainCfg.testers) ? mainCfg.testers : testersFor_(wanted ? wanted.testers : '').testers;
    const mainMode = runLiveSetting_();  // Config.gs: buildCtx_ sets this flow's (Testing); the main run's is put back after
    let ctx;
    let report;
    try {
      ctx = buildCtx_(cfg, ss, wanted && wanted.switches);
      ctx.deadline = Math.min(Date.now() + OS_BUDGET_MS_, latest);
      startFromOtherSpace_(props, cfg, ctx);
      report = runOnce_(ctx);
      ctx.recent.save();
    } finally {
      setRunLive_(mainMode);
    }
    const today = bumpOtherSpaceStats_(props, report, dayKey_());
    const issues = report.errors.filter(e => !/^time budget/.test(e));
    if (report.handled || report.answers || report.drafts_sent || issues.length) console.log('Other alerts space: ' + JSON.stringify(report));
    writeOtherSpaceNote_(control, issues.length
      ? `⚠️ ${truncate_(issues[0], 220)} The bot keeps retrying.`
      : `✓ ${space.name} · 🧪 Testing · ${otherSpaceTodayText_(today)}`);
    return { report, ctx };
  } catch (e) {
    console.error('Other alerts space failed: ' + ((e && e.stack) || e));
    try {
      writeOtherSpaceNote_(control, `⚠️ ${truncate_(String((e && e.message) || e), 220)} The bot tries again every minute.`);
    } catch (err) {
      console.error('could not update the Control tab: ' + err);
    }
    return null;
  }
}

/**
 * The run's setup: one Google-only space, worked directly, as B25 is with row 32 (Main.gs directCfg_), with no S-F
 * Burson (nothing is passed on to it, its test copy or its outbox) and always Testing. Pure.
 */
function otherSpaceCfg_(space) {
  return { burson: space, analyst: space, outboundBlocked: true, sfBurson: null, direct: true, otherSpace: true,
    mode: { live: false, why: OS_MODE_WHY_ } };
}

/** B33 (link, id or exact name) -> {id, name, externalUserAllowed} (cached for an hour), or an error that says what to fix. */
function resolveOtherSpace_(value) {
  const cache = CacheService.getScriptCache();
  const cacheKey = 'os_space:' + hashText_(String(value));
  const hit = cache.get(cacheKey);
  if (hit) return JSON.parse(hit);
  const ref = parseSpaceRef_(value, 'The Other alerts space');
  try {
    let id = ref.id;
    if (!id) {
      const props = PropertiesService.getScriptProperties();
      const prop = 'SPACE_ID:' + ref.name;
      id = props.getProperty(prop) || findSpaceByName_(ref.name, 'Other alerts space');
      props.setProperty(prop, id);
    }
    const s = chatGetSpace_(id);
    const out = { id: s.name, name: s.displayName || s.name, externalUserAllowed: !!s.externalUserAllowed };
    cache.put(cacheKey, JSON.stringify(out), 3600);
    return out;
  } catch (e) {
    throw new Error(/^No space named|spaces are named/.test(e.message) ? e.message
      : `Can't open the Other alerts space (${ref.id || ref.name}). Check the link, and that ${Session.getEffectiveUser().getEmail()} ` +
        'is a member of that space.');
  }
}

/**
 * Safety checks on the Other alerts space ('' when it's fine): never the space in B25 (`sfb`: this run's, else B25 as
 * written) or a space people outside Google can join, and never a space the bot already uses: the main run's spaces
 * (`mainCfg`: the Burson and analyst spaces, B3 and B4, the Mirror space, B9, or B25 with row 32), the Mirror space
 * (B9), the auto-correct space (B10) or the Burson test copy (B26). Those keep working as before; this one waits. Pure
 * but for the Mirror's default (Mirror.gs MIRROR_TARGET_SPACE).
 */
function otherSpaceProblem_(space, wanted, mainCfg, sfb) {
  if (!space) return '';
  if (isSfBurson_(sfb, space.id) || sameSpaceRef_(wanted && wanted.sfBurson, space)) {
    return 'The Other alerts space can\'t be the space in B25 (S-F Burson). Paste a separate Google-only space.';
  }
  if (space.externalUserAllowed) {
    return `"${space.name || space.id}" allows people outside Google, so Burson could see it. Use a space only Google people can join.`;
  }
  const cells = [[(wanted && wanted.mirror) || MIRROR_TARGET_SPACE, 'the Mirror space (B9)'],
    [wanted && wanted.autocorrect, 'the Auto-correct space (B10)'], [wanted && wanted.testCopy, 'the Burson test copy (B26)']];
  const same = cells.find(([v]) => sameSpaceRef_(v, space));
  if (same) return `The Other alerts space must be a space of its own, not ${same[1]}. Paste a separate Google-only space.`;
  const main = mainCfg ? [['mirror', 'the Mirror space (B9)'], ['burson', mainCfg.direct ? 'B25' : 'the Burson space (B3)'],
    ['analyst', 'the analyst space (B4)']].find(([k]) => mainCfg[k] && mainCfg[k].id === space.id) : null;
  return main ? `The Other alerts space must be a space of its own, not ${main[1]}, which the bot already works in. Paste a ` +
    'separate Google-only space.' : '';
}

/**
 * Like startFrom_: after a pause it starts from a minute ago; a new Other alerts space starts from its last few minutes
 * (start_lookback_minutes), never its whole history.
 */
function startFromOtherSpace_(props, cfg, ctx) {
  const now = Date.now();
  const floorKey = 'FLOOR:' + cfg.burson.id;  // buildCtx_ reads it back as ctx.floor
  const setFloor = ms => {
    if (!(ctx.cursor.get() >= ms)) ctx.cursor.set(ms);
    if (!(Number(props.getProperty(floorKey)) >= ms)) props.setProperty(floorKey, String(ms));
    ctx.floor = Math.max(ctx.floor || 0, ms);
  };
  if (props.getProperty('OS_PAUSED') === 'true') {
    props.deleteProperty('OS_PAUSED');
    setFloor(now - 60 * 1000);
  }
  if (props.getProperty('LAST_OS_SPACE') !== cfg.burson.id) {
    setFloor(now - ctx.settings.start_lookback_minutes * 60 * 1000);
    props.setProperty('LAST_OS_SPACE', cfg.burson.id);
  }
}

/** Today's counts for the Other alerts space (shown in C33), with this run's report added. Saved when they change. */
function bumpOtherSpaceStats_(props, report, day) {
  let s = null;
  try { s = JSON.parse(props.getProperty(OS_STATS_PROP_) || 'null'); } catch (e) { s = null; }
  if (!s || s.day !== day) s = { day, alerts: 0, triaged: 0, emails: 0, answers: 0 };
  const add = { alerts: report.alerts || 0, triaged: report.other_alerts || 0, emails: report.drafts_sent || 0,
    answers: report.answers || 0 };
  Object.keys(add).forEach(k => { s[k] = (s[k] || 0) + add[k]; });
  if (add.alerts || add.triaged || add.emails || add.answers) props.setProperty(OS_STATS_PROP_, JSON.stringify(s));
  return s;
}

/** "today: 7 alerts (6 in other formats), 1 Social Alert to the testers, 2 questions answered". Pure. */
function otherSpaceTodayText_(s) {
  if (!s || !(s.alerts || s.answers)) return 'no alerts yet today';
  const n = (count, one, many) => `${count} ${count === 1 ? one : many}`;
  return `today: ${n(s.alerts || 0, 'alert', 'alerts')} (${s.triaged || 0} in other formats), ` +
    `${n(s.emails || 0, 'Social Alert', 'Social Alerts')} to the testers, ${n(s.answers || 0, 'question', 'questions')} answered`;
}

/**
 * Row 33 ("Other alerts space") on the Control tab. A tab from before it gets it on its next run, without setup(): blank
 * unless a person pasted a space in B33 (kept); "How it works" moves down to make room (row 42, below the Proactive watch
 * switch in row 34, Watch alerts in row 35, WatchAlerts.gs, and the switches in rows 36-40: Temp checks, Group test
 * emails and the three Fast triage ones).
 */
function ensureOtherSpaceRow_(sh) {
  if (!sh) return;
  if (String(sh.getRange(OS_ROW_, 1).getValue() || '').trim() === OS_LABEL_) return;
  const b = sh.getRange(OS_ROW_, 2).getValue();  // blank on every older tab: its help text used column A only
  const value = String(b === undefined || b === null ? '' : b).trim();
  sh.getRange(OS_ROW_, 1, 1, 3).setValues([[OS_LABEL_, value, value ? '' : OS_HINT_]]);
  sh.getRange(OS_ROW_, 1).setFontWeight('bold');
  sh.getRange(OS_ROW_, 2).setBackground('#fff8e1');
  writeControlHelp_(sh);
}

/** C33: how the Other alerts space is doing (written only when it changes). */
function writeOtherSpaceNote_(sh, note) {
  if (!sh) return;
  const cell = sh.getRange(OS_ROW_, 3);
  if (String(cell.getValue() || '') !== String(note || '')) cell.setValue(note || '');
}
