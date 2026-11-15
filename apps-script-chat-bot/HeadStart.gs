/**
 * HeadStart.gs — the Head start tab of the bot's sheet: how this app's OWN alerts compare with Burson's alerts and with
 * the IMs' Social Alert emails. How often this app alerted a story before Burson did, how often before the IMs emailed,
 * by how much, and which stories it had first. The Results tab (Speed.gs) can't say: it counts only the alerts Burson
 * posted and leaves this app's own alerts out; the Watch detections scorecard (ProactiveWatch.gs) measures a watch's
 * flag against Burson on the same post only.
 *
 * It only reads the Alert log and writes its own tab. Nothing is posted in any Chat space, nothing is emailed, no Gmail
 * search and no BigQuery read is made, the Alert memory is neither asked nor written, and there is no Control tab row
 * or switch for it.
 *
 * What's counted (headStartReport_, pure: Alert-log rows in, the stories and the numbers out):
 *   own alert    an Alert-log row whose `ingested` column is the Early Detection value (ED_ALERT_INGESTED_), the Watch
 *                alert value (PW_ALERT_INGESTED_) or a Direct BigQuery source label (BQ_SOURCE_LABELS_). Its type:
 *                "Early Detection"; "Early signal" (its Early Detection snapshot's signal type is the early-watch one,
 *                EWS_WATCH_SIGNAL_); "Watch"; "Direct (Sprinklr)", "Direct (BMIE)", "Direct (BSIP)". Rows of another
 *                tool's alerts (Other alert) and of sheet test alerts are neither this app's nor Burson's: left out
 *   story        one own alert and its updates, counted once. An Early Detection card that updates an earlier card
 *                (forwarded_fields.early_detection.update_of names that card's Alert-log id, or its BigQuery alert id)
 *                is part of that card's story, and so are two own alerts that share a post key. The story's time is
 *                its EARLIEST alert
 *   this app     when its alert was posted: the row's source_at (for an own card that is the card's own post time in
 *   alerted      Chat), else created_at
 *   post keys    the row's record_key, plus forwarded_fields.early_detection.post_keys when there are any (8 at most),
 *                over every row of the story
 *   Burson       an Alert-log row with a blank `ingested` that isn't the Other alerts space's and has a link and a
 *   alerted      recorded source_at: exactly what ProactiveWatch.gs pwBursonTimes_ counts. When: the earliest source_at
 *                of Burson's rows for that post key (both test spaces usually hold one row each)
 *   the IMs      the IMs' time for the matched Burson post as the Results tab works it out (Speed.gs speedImAt_: their
 *   emailed      email, else their draft), taken from the Results rebuild made earlier in the same run (Speed.gs
 *                RESULTS_RUN_): never looked up here, and never one of the bot's own emails (Speed.gs leaves those out).
 *                Blank when that rebuild didn't run, or no longer shows the post (it covers settings.speed_days days)
 *
 * Matching a story with a Burson alert (the tab's "Matched on" says which rule gave it, so a person can judge it).
 * Burson may be earlier OR later. The two sure rules come first:
 *   same post    one of the story's post keys is a Burson alert's record key
 *   same story   Burson's alert tells the same story on another post, as the reviews themselves recorded it: one name
 *                per issue (IssueNames.gs existingIssueOf_). A review that recognises an alert as an issue already
 *                alerted, whatever tied them (the email thread, a follow-up, the same story by meaning in the Alert
 *                memory, Gemini's call on the existing issues, a near-identical name), gives it that issue's exact name
 *                and the Ongoing Issue status, and its Alert-log row keeps both (forwarded_fields.issue_name and
 *                issue_status: Review.gs rule 14b for Burson's alerts, OtherAlerts.gs and EarlyDetection.gs for this
 *                app's own). So: the two carry the same issue name (IssueNames.gs issueNameKey_) and the LATER of the
 *                two is an Ongoing Issue. Nothing else on a row is as sure: the Alert memory's story id is never
 *                written on a row, and a decision names an earlier alert's id only when a Social Alert was held back.
 *                Once one of Burson's alerts is tied to the story that way, the name is the story's issue, and Burson's
 *                other alerts under it (never under another exposure tag) are on the same story too. Burson's FIRST
 *                alert under the name is often among them: where this app's alert was only to be watched, Burson's
 *                first alert on the story was a New one, and only its next ones are Ongoing Issues under that name
 * The story is measured against the EARLIEST of Burson's alerts those two rules give, taken together, and the row is
 * labelled with the rule that gave that alert. So Burson's alert on one of the story's posts never hides an earlier
 * alert of Burson's on the same story: the head start is to Burson's first alert on the story, and when that came before
 * this app's, this app was behind, however soon after it Burson alerted the same post.
 *
 * Only when neither sure rule finds an alert, the two weaker rules are tried, taken together in the same way (the
 * earliest alert, labelled with its rule) and labelled apart:
 *   same story   the two carry the same issue name and nothing says more: no review took one of Burson's alerts under
 *   (same issue  that name and this app's alert for one issue. As IssueNames.gs knownIssueName_ takes a name for an
 *   name)        existing issue's: never when the two are under two different exposure tags (a generic name can cover
 *                more than one issue), but a row without a tag can match
 *   same story   the Alert memory's word check (AlertMemory.gs amSameStoryWords_, the one it falls back to when it has
 *   (similar     no vector) on the two rows' issue name, exposure tag and product, as the memory builds a story's view
 *   wording)     from them: the same exposure tag, issue words at least novelty_min_jaccard alike, never with clashing
 *                identifiers in them (a CVE, a long number, an @handle). That check doesn't compare the products
 *                themselves. To keep it quick, it is only run on Burson's alerts under the same tag that share a word
 *                of the name and are at least half that alike (the rest could never pass it)
 * The three same-story rules only look at Burson's alerts within HEAD_START_STORY_DAYS_ (14) days either side of the
 * story's time. alertMemory_().storyMatch is never called and no text is embedded.
 *
 * What the matching can't see, and the tab says so: the sure same-story rule depends on a review having given the later
 * alert the earlier one's name, and a review only does that for an earlier alert that went out (a Social Alert sent,
 * drafted or on its way, or a team's emoji: Escalate.gs earlierOutcome_). Burson's alerts usually did, so "Burson
 * first" is seen well. One of this app's alerts that was only to be watched (an Early Detection card to monitor, a
 * Watch alert with no Social Alert) never gives its name to Burson's later alert; such a story is found again only on
 * its own posts, on an identical issue name, or on similar wording under the same exposure tag, and an Early Detection
 * card has an exposure tag only when its review was sure it is an SLRR matter. So a story with no Burson alert FOUND
 * may still have been alerted by Burson under another name: the count is called "No Burson alert found", never "not
 * alerted", and "this app first" is, if anything, undercounted.
 *
 * The tab, top to bottom: its title in A1 (the bot's mark) and one line saying what's counted and when it was rebuilt
 * (ET); HEADLINE NUMBERS for the last 7 and the last 30 days, by when this app alerted (stories, those Burson alerted
 * too, this app first and its median head start, Burson first and the median time behind, no Burson alert found, this
 * app's alert before the IMs' email and the median time from one to the other, and the reverse view: Burson's alerts and
 * how many of them this app had alerted first: those that came after a story of this app's that was itself ahead of
 * Burson's first alert on it); BIGGEST HEAD STARTS (the ten longest over Burson, last 30 days); EVERY
 * STORY (last 30 days, newest first): Type · This app alerted (ET) · Story (the issue name or the card's headline,
 * linked to the lead post) · Product · Exposure Tag · Burson alerted (ET) · Head start over Burson · IMs emailed (ET) ·
 * Head start over the IMs · Matched on · App alert · Burson alert, then the two head starts in plain minutes at the far
 * right, to sort by (negative when this app was later). A head start is in words ("2 d 15 h", "3 h 10 min", "45 min";
 * "behind by 20 min" when this app was later); a cell is blank, never a zero, where there's no Burson alert or no IM time.
 *
 * poll() calls maybeRefreshHeadStart_() at the end of every run, after the Results tab: the tab is rebuilt at most
 * every 10 minutes, in a run where the Results tab was rebuilt too (it has the IMs' times; 10 more minutes without one
 * and it is rebuilt without them), never with under 30 seconds of the run left, and never in a run that is still
 * catching up on alerts (one of its flows held an alert for the next run, stopped at its limit of messages or ran out
 * of time: headStartRunBusy_). Such a run must end as soon as it can, so the next one starts on time; the tab shows
 * nothing that can't wait, and is rebuilt in the first run that has caught up. It never throws: a failure is logged
 * and the run carries on. refreshHeadStart() rebuilds it now, from the editor (the IMs' times follow at the next run
 * that has them). The tab is made the first time this app has an alert of its own to show.
 *
 * The tab is the bot's own: its title in A1 says so (isHeadStartTab_), checked before every clear and write. A tab
 * named "Head start" that the bot didn't make is never read, cleared or written: the log says so (and
 * headStartBlockedNote_) until it's renamed, and the bot then makes its own. Every cell stays at or under 49,000
 * characters, and text the bot didn't write itself (issue names, headlines, products, tags, alert ids) can never be read
 * as a formula (Speed.gs speedText_, ProactiveWatch.gs pwCell_); the only formulas are the quoted links (Speed.gs
 * resultsLink_).
 */

const HEAD_START_TAB_ = 'Head start';
// The bot's mark, in A1: how it knows the tab is its own (isHeadStartTab_). A tab people made never has it
const HEAD_START_TITLE_ = 'Head start: how far ahead of Burson\'s alerts and the IMs\' emails this app\'s own alerts were ' +
  '(written by the Burson QA bot)';
const HEAD_START_OWN_TITLES_ = [HEAD_START_TITLE_];
const HEAD_START_HEADER_ = ['Type', 'This app alerted (ET)', 'Story', 'Product', 'Exposure Tag', 'Burson alerted (ET)',
  'Head start over Burson', 'IMs emailed (ET)', 'Head start over the IMs', 'Matched on', 'App alert', 'Burson alert',
  'Head start over Burson (min)', 'Head start over the IMs (min)'];
const HEAD_START_WIDTHS_ = [[1, 330], [2, 140], [3, 320], [4, 140], [5, 220], [6, 140], [7, 160], [8, 140], [9, 160], [10, 190],
  [11, 130], [12, 110], [13, 110], [14, 110]];
const HEAD_START_WIDE_ = 8;                        // the long texts (what's counted, the notes) are merged across A:H
const HEAD_START_MIN_MS_ = 60 * 1000;
const HEAD_START_DAY_MS_ = 24 * 60 * HEAD_START_MIN_MS_;
const HEAD_START_DAYS_ = 30;                       // the tab's stories: the last 30 days, by when this app alerted
const HEAD_START_WEEK_DAYS_ = 7;                   // the headline numbers' shorter window
const HEAD_START_STORY_DAYS_ = 14;                 // same story: Burson's alerts this many days either side of the story
const HEAD_START_TOP_ = 10;                        // BIGGEST HEAD STARTS: this many stories
const HEAD_START_POST_KEYS_ = 8;                   // of an Early Detection card's post keys (BigQuery.gs ED_POSTS_MAX_)
const HEAD_START_EVERY_MS_ = 10 * HEAD_START_MIN_MS_;         // rebuilt at most this often
const HEAD_START_MIN_LEFT_MS_ = 30 * 1000;                    // a rebuild needs this much of the run left
const HEAD_START_WAIT_RESULTS_MS_ = 10 * HEAD_START_MIN_MS_;  // once due, it waits this long for a run with a Results rebuild
const HEAD_START_RUN_MS_ = 6 * HEAD_START_MIN_MS_;            // Apps Script's longest run (when the run's start isn't given)
const HEAD_START_AT_PROP_ = 'HEAD_START_AT';                  // when it was last rebuilt (ms)
const HEAD_START_BLOCKED_PROP_ = 'HEAD_START_BLOCKED';        // 'true' while a "Head start" tab the bot didn't make is in the way
const HEAD_START_READ_ROWS_ = 16000;               // Alert-log rows read at most (as Speed.gs resultsAlertRows_)
const HEAD_START_NAME_CHARS_ = 200;                // a story's name on the tab
const HEAD_START_LINK_CHARS_ = 2000;               // a longer link isn't linked
const HEAD_START_SAME_POST_ = 'same post';
const HEAD_START_SAME_STORY_ = 'same story';
const HEAD_START_SAME_NAME_ = 'same story (same issue name)';
const HEAD_START_SIMILAR_ = 'same story (similar wording)';
// "Matched on", by how sure the rule is (1 the surest): the two sure rules, then the two weaker ones (headStartMatch_)
const HEAD_START_RULES_ = ['', HEAD_START_SAME_POST_, HEAD_START_SAME_STORY_, HEAD_START_SAME_NAME_, HEAD_START_SIMILAR_];

/** Run this to rebuild the Head start tab now (while the bot is ON, poll() keeps it up to date: maybeRefreshHeadStart_). */
function refreshHeadStart() {
  const ss = openStore_(false);
  const now = Date.now();
  const out = refreshHeadStart_(ss, { now, make: true });
  if (out.blocked) {  // a "Head start" tab the bot didn't make: left as it is (refreshHeadStart_ says so in the log)
    console.warn(`Head start tab not rebuilt: ${headStartBlockedText_()}`);
    return null;
  }
  // The IMs' times come with the Results tab's rebuild in the every-minute run: the tab is due again right away, so
  // the next run that has them fills them in
  PropertiesService.getScriptProperties().setProperty(HEAD_START_AT_PROP_, String(now - HEAD_START_EVERY_MS_));
  console.log(JSON.stringify(out.windows, null, 2));
  return out.windows;
}

/**
 * From poll(), at the end of every run, after maybeRefreshSpeed_: rebuilds the Head start tab when it's due. opts:
 * {deadline (ms: when the run must be done), runStart (ms: when this run began), flows (what each flow of this run
 * left: its ctx, or its {ctx, report})}. Due: 10 minutes after the last rebuild, in a run where the Results tab was
 * rebuilt (its posts carry the IMs' times: headStartResultsRun_); when no such run comes for 10 more minutes (or the
 * Results tab is off: settings.speed_tab), it is rebuilt without the IMs' times. Never with under 30 seconds of the run
 * left, and never in a run that is still catching up on alerts (headStartRunBusy_): nothing is read or noted then, and
 * the tab stays due. True when it wrote the tab. Never throws.
 */
function maybeRefreshHeadStart_(ss, ctx, opts) {
  try {
    const o = opts || {};
    if (!ss) return false;
    if (headStartRunBusy_(ctx, o.flows)) return false;  // alerts are waiting for the next run: it must start on time
    const now = ctx && typeof ctx.now === 'function' ? ctx.now() : Date.now();
    const deadline = Number(o.deadline) || Number(ctx && ctx.deadline) || 0;
    if (deadline && deadline - now < HEAD_START_MIN_LEFT_MS_) return false;
    const props = PropertiesService.getScriptProperties();
    const last = Number(props.getProperty(HEAD_START_AT_PROP_)) || 0;
    if (now - last < HEAD_START_EVERY_MS_) return false;
    const run = headStartResultsRun_(o.runStart, now);
    const resultsOn = ((ctx && ctx.settings) || {}).speed_tab !== false;
    if (!run && last && resultsOn && now - last < HEAD_START_EVERY_MS_ + HEAD_START_WAIT_RESULTS_MS_) return false;
    props.setProperty(HEAD_START_AT_PROP_, String(now));
    const out = refreshHeadStart_(ss, { now, im: run ? headStartImTimes_(run.posts) : null });
    return !!out.written;
  } catch (e) {
    console.error('Head start tab not refreshed: ' + ((e && e.message) || e));
    return false;
  }
}

/**
 * Is this run still catching up on alerts? True when the run's ctx, or one of its flows (`flows`: each a flow's ctx,
 * or the {ctx, report} its run gave: the Mirror space's, the auto-correct space's, the Other alerts space's), says
 * so: the flow marked itself busy (ctx.slaBusy: Main.gs and AutoCorrect.gs set it), or its report shows what they go
 * by: an alert held for the next run (report.held), as many messages handled as a run may handle
 * (settings.max_messages_per_run: more may be waiting), or a stop at its time budget. The next run takes those alerts
 * up, and it only starts when this one has ended (poll() skips a minute while the run before is still going): a
 * rebuild here could make them wait a minute more. Pure; never throws.
 */
function headStartRunBusy_(ctx, flows) {
  const busy = x => {
    try {
      if (!x || typeof x !== 'object') return false;
      const c = x.ctx && typeof x.ctx === 'object' ? x.ctx : x;
      const r = x.report && typeof x.report === 'object' ? x.report : null;
      if (c.slaBusy) return true;
      if (!r) return false;
      const most = Number((c.settings || {}).max_messages_per_run);
      return Number(r.held) > 0 || (most > 0 && Number(r.handled) >= most) ||
        (Array.isArray(r.errors) ? r.errors : []).some(e => /^time budget/.test(String(e)));
    } catch (e) {
      return false;
    }
  };
  return busy(ctx) || (Array.isArray(flows) ? flows : []).some(busy);
}

/**
 * Rebuilds the Head start tab: headStartReport_'s {stories, top, windows, …} plus `written` (the tab was written).
 * opts: now (ms), im (the IMs' time per Burson post, headStartImTimes_; null when it isn't at hand), make (make the tab
 * even with no story to show: refreshHeadStart()); tests: alerts (the Alert log's rows). The tab is made the first time
 * there's a story to show, so a sheet where this app never alerted on its own gets no tab. {blocked: true} when a tab
 * named Head start that the bot didn't make is in the way: that tab is left as it is (never read, cleared or written),
 * nothing else is read, and the log says so.
 */
function refreshHeadStart_(ss, opts) {
  const o = opts || {};
  const now = Number(o.now) || Date.now();
  const blocked = headStartTabForeign_(ss);
  noteHeadStartBlocked_(blocked);
  if (blocked) {
    console.warn(`Head start tab not updated: a "${HEAD_START_TAB_}" tab the bot didn't make is there (left as it is)`);
    return { blocked: true, written: false, stories: [], top: [], windows: null };
  }
  const since = now - (HEAD_START_DAYS_ + HEAD_START_STORY_DAYS_) * HEAD_START_DAY_MS_;
  const report = headStartReport_(o.alerts || headStartAlertRows_(ss, since), o.im || null, now);
  report.written = false;
  if (!ss.getSheetByName(HEAD_START_TAB_) && !o.make && !report.stories.length) return report;  // nothing of its own to show yet
  const sh = ensureHeadStartTab_(ss);
  // null: a tab the bot didn't make took the name since the check above. Left as it is; the next rebuild notes it
  if (!sh) throw new Error(`a "${HEAD_START_TAB_}" tab the bot didn't make is in the way: left as it is`);
  writeHeadStartTab_(sh, report);
  report.written = true;
  return report;
}

/**
 * The Alert log's rows from every partition, back to `since` (ms), 16,000 at most: read only. Unlike the store's
 * reader (Sheets.gs sheetTable_) it never makes the tab or touches its header row: this report writes its own tab and
 * nothing else. One column (created_at) is read first to find how far back to go, then the rows, once. [] when there's
 * no Alert log yet.
 */
function headStartAlertRows_(ss, since) {
  const sh = ss.getSheetByName(ALERT_TAB_);
  const last = sh ? sh.getLastRow() : 0;
  if (last < 2) return [];
  const header = sh.getRange(1, 1, 1, Math.max(1, sh.getLastColumn())).getValues()[0].map(String);
  while (header.length && !header[header.length - 1]) header.pop();
  if (header.indexOf('alert_id') < 0) return [];
  const col = header.indexOf('created_at') + 1;
  let count = Math.min(last - 1, ALERT_READ_ROWS_);
  if (col) {
    const made = sh.getRange(2, col, last - 1, 1).getValues();
    let first = made.length;
    for (let i = 0; i < made.length; i++) {
      const v = made[i][0];
      if ((v instanceof Date ? v.getTime() : Number(v) || 0) >= since) { first = i; break; }
    }
    count = Math.min(made.length - first, HEAD_START_READ_ROWS_);
  }
  return count > 0 ? tableOver_(sheetIO_(sh), header, 'alert_id', count).load() : [];
}

/**
 * The Results rebuild made in THIS run ({at, posts}: Speed.gs RESULTS_RUN_), or null when there was none: its posts
 * carry the IMs' times. `runStart` (ms): when this run began; without it, anything from the last 6 minutes (Apps
 * Script's longest run: each run starts with nothing, so that can only be this run's).
 */
function headStartResultsRun_(runStart, now) {
  const run = typeof RESULTS_RUN_ === 'undefined' ? null : RESULTS_RUN_;
  if (!run || !Array.isArray(run.posts)) return null;
  const from = Number(runStart) || (Number(now) || Date.now()) - HEAD_START_RUN_MS_;
  return Number(run.at) >= from ? run : null;
}

/**
 * The IMs' time per Burson post from the Results tab's posts (Speed.gs speedPosts_, after speedImEmails_): {post key
 * (Speed.gs postKey_): {at (ms), from: 'email' | 'draft'}}, as Speed.gs speedImAt_ gives it (their email, else their
 * draft). Only posts with a time. The bot's own emails and drafts never count as the IMs' (Speed.gs botEmailThreads_,
 * resultsHumanDrafts_). Pure.
 */
function headStartImTimes_(posts) {
  const out = {};
  (Array.isArray(posts) ? posts : []).forEach(p => {
    if (!p || !p.key) return;
    const at = Number(speedImAt_(p)) || 0;
    if (at > 0) out[String(p.key)] = { at, from: Number(p.im_email_at) > 0 ? 'email' : 'draft' };
  });
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// The report: Alert-log rows in, the stories and the numbers out. Pure.
// ---------------------------------------------------------------------------------------------------------------

/** A JSON object column's value (forwarded_fields, email_input), or {} when the cell holds anything else. Pure. */
function headStartObj_(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

/** A text or a number as one line of text; '' for none, and for anything else a broken cell could hold. Pure. */
function headStartText_(v) {
  return typeof v === 'string' || typeof v === 'number' ? String(v).replace(/\s+/g, ' ').trim() : '';
}

/**
 * The type of an own alert's row, by its `ingested` column: "Early Detection", "Early signal" (the snapshot's signal
 * type is EWS_WATCH_SIGNAL_), "Watch", "Direct (<source label>)"; '' for a row that isn't this app's own alert
 * (Burson's, another tool's, a sheet test alert). Pure.
 */
function headStartOwnType_(row) {
  const ing = headStartText_(row && row.ingested);
  if (!ing) return '';
  if (typeof ED_ALERT_INGESTED_ === 'string' && ing === ED_ALERT_INGESTED_) {
    const sig = headStartText_(headStartObj_(headStartObj_(row.forwarded_fields).early_detection).signal_type).toUpperCase();
    return typeof EWS_WATCH_SIGNAL_ === 'string' && sig === EWS_WATCH_SIGNAL_ ? 'Early signal' : 'Early Detection';
  }
  if (typeof PW_ALERT_INGESTED_ === 'string' && ing === PW_ALERT_INGESTED_) return 'Watch';
  const labels = typeof BQ_SOURCE_LABELS_ === 'object' && BQ_SOURCE_LABELS_
    ? Object.keys(BQ_SOURCE_LABELS_).map(k => BQ_SOURCE_LABELS_[k]) : [];
  return labels.indexOf(ing) >= 0 ? `Direct (${ing})` : '';
}

/**
 * What the report reads from one Alert-log row: {id, at (when it reached the space: source_at, else created_at),
 * source_at, name (the issue name, without a status suffix), name_key (how issue names compare), ongoing (its issue
 * status is Ongoing Issue), headline (an Early Detection card's), product, tag, tag_key (how exposure tags compare: by
 * the tag's current name, in lower case; '' for none), url, key (record_key), ed (the Early Detection snapshot), view
 * (the Alert memory's view of its story, for the word check; null without issue words)}. Never throws: a broken cell
 * reads as blank. Pure.
 */
function headStartRowFacts_(a) {
  const ff = headStartObj_(a.forwarded_fields);
  const ef = headStartObj_(headStartObj_(a.email_input).fields);
  const pick = k => headStartText_(ff[k] === undefined || ff[k] === null || ff[k] === '' ? ef[k] : ff[k]);
  const sourceAt = Number(a.source_at) > 0 ? Number(a.source_at) : 0;
  const name = issueNameText_(pick('issue_name'));
  const out = {
    id: headStartText_(a.alert_id), at: sourceAt || (Number(a.created_at) > 0 ? Number(a.created_at) : 0), source_at: sourceAt,
    name, name_key: issueNameKey_(name), ongoing: pick('issue_status').toLowerCase().indexOf(ONGOING_STATUS_SUFFIX_.toLowerCase()) === 0,
    headline: headStartText_(headStartObj_(ff.early_detection).story_title),
    product: pick('product'), tag: pick('exposure_tag') || headStartText_(a.exposure_tag), url: pick('post_url'),
    key: headStartText_(a.record_key), ed: headStartObj_(ff.early_detection), view: null, tag_key: '',
  };
  out.tag_key = out.tag.toLowerCase();  // as it is written, should the tag's current name not be found below
  try {
    const tag = amTag_(out.tag);  // by its current name, as the Alert memory compares tags
    out.tag_key = String(tag || '').trim().toLowerCase();
    // As AlertMemory.gs builds a story's view (storyView), from the issue name, the exposure tag and the product (the
    // summary is left out): its issue words, its tag, its product, and the identifiers those three name
    const fields = { issue_name: name, product: out.product, exposure_tag: out.tag };
    const author = pick('author') || headStartText_(a.author);
    const tok = issueTokens_(name);
    if (tok.length) {
      out.view = { tag, prod: amProduct_(out.product), tok,
        idt: amIdents_(amStoryText_(fields), [author, out.url ? authorFromUrl_(out.url) : '']) };
    }
  } catch (e) {
    out.view = null;
  }
  return out;
}

/**
 * This app's own alerts as stories: [{type, at, name, url, product, tag, alert_id, alert_ids, alerts, keys, rows (each
 * row's headStartRowFacts_)}]. An update card joins the card it updates (update_of: that card's Alert-log id, or its
 * BigQuery alert id), and own alerts that share a post key are one story; a story's time, type, name and link are its
 * earliest alert's. Rows that aren't own alerts, have no time, or can't be read are left out. Pure.
 */
function headStartStories_(rows) {
  const own = [];
  (Array.isArray(rows) ? rows : []).forEach(a => {
    try {
      if (!a || typeof a !== 'object') return;
      const type = headStartOwnType_(a);
      if (!type) return;
      const f = headStartRowFacts_(a);
      if (!(f.at > 0)) return;
      const keys = [];
      [f.key].concat(Array.isArray(f.ed.post_keys) ? f.ed.post_keys.slice(0, HEAD_START_POST_KEYS_).map(headStartText_) : [])
        .forEach(k => { if (k && keys.indexOf(k) < 0) keys.push(k); });
      own.push({ f, type, keys, update_of: headStartText_(f.ed.update_of), ed_id: headStartText_(f.ed.ed_alert_id) });
    } catch (e) { /* a row that can't be read is left out */ }
  });
  // One story: a card and its updates, and own alerts on the same post
  const parent = own.map((x, i) => i);
  const root = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const join = (i, j) => { const a = root(i); const b = root(j); if (a !== b) parent[Math.max(a, b)] = Math.min(a, b); };
  const byId = new Map();
  const byEd = new Map();
  const byKey = new Map();
  own.forEach((x, i) => {
    if (x.f.id && !byId.has(x.f.id)) byId.set(x.f.id, i);
    if (x.ed_id && !byEd.has(x.ed_id)) byEd.set(x.ed_id, i);
  });
  own.forEach((x, i) => {
    const earlier = x.update_of ? (byId.has(x.update_of) ? byId.get(x.update_of) : byEd.get(x.update_of)) : undefined;
    if (earlier !== undefined) join(i, earlier);
    x.keys.forEach(k => { if (byKey.has(k)) join(i, byKey.get(k)); else byKey.set(k, i); });
  });
  const groups = new Map();
  own.forEach((x, i) => {
    const r = root(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(x);
  });
  return Array.from(groups.values()).map(list => {
    list.sort((x, y) => x.f.at - y.f.at || (x.f.id < y.f.id ? -1 : x.f.id > y.f.id ? 1 : 0));
    const lead = list[0];
    const firstOf = get => { const hit = list.find(x => get(x)); return hit ? get(hit) : ''; };
    const keys = [];
    list.forEach(x => x.keys.forEach(k => { if (keys.indexOf(k) < 0) keys.push(k); }));
    return {
      type: lead.type, at: lead.f.at, name: firstOf(x => x.f.name) || firstOf(x => x.f.headline), url: firstOf(x => x.f.url),
      product: firstOf(x => x.f.product), tag: firstOf(x => x.f.tag), alert_id: lead.f.id,
      alert_ids: list.map(x => x.f.id).filter(Boolean), alerts: list.length, keys, rows: list.map(x => x.f),
    };
  });
}

/**
 * Burson's alerts by post: a Map {record key: {key, at (when Burson alerted: the earliest source_at of its rows),
 * alert_id, url, name, rows (each row's headStartRowFacts_, earliest first)}}. What counts is exactly what
 * ProactiveWatch.gs pwBursonTimes_ counts (a link, a blank `ingested`, not the Other alerts space's partition, a
 * source_at above 0), and the time is the one it gives. Pure.
 */
function headStartBurson_(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const times = pwBursonTimes_(list);
  const out = new Map();
  list.forEach(a => {
    try {
      if (!a || !a.record_key || a.ingested || String(a.space || '').endsWith(OS_PARTITION_SUFFIX_)) return;
      if (!((Number(a.source_at) || 0) > 0)) return;
      const key = String(a.record_key);
      const at = Number(times[key]) || 0;
      if (!(at > 0)) return;
      if (!out.has(key)) out.set(key, { key, at, alert_id: '', url: '', name: '', rows: [] });
      out.get(key).rows.push(headStartRowFacts_(a));
    } catch (e) { /* a row that can't be read is left out */ }
  });
  out.forEach(g => {
    g.rows.sort((x, y) => x.source_at - y.source_at);
    const firstOf = get => { const hit = g.rows.find(x => get(x)); return hit ? get(hit) : ''; };
    g.alert_id = firstOf(x => x.id);
    g.url = firstOf(x => x.url);
    g.name = firstOf(x => x.name);
  });
  return out;
}

/**
 * Matches each story with Burson's alerts: sets story.burson ({key, at, alert_id, url, name} of Burson's alert, or
 * null), story.matched (the rule that gave that alert: HEAD_START_SAME_POST_, HEAD_START_SAME_STORY_,
 * HEAD_START_SAME_NAME_, HEAD_START_SIMILAR_, or '') and story.lead_ms (Burson's time less the story's: above 0 when
 * this app was first; null without a match). The alert is the EARLIEST one the two sure rules give, taken together
 * (same post, same story: Burson's first alert on the story, whichever post it was on); only when they give none, the
 * earliest one the two weaker rules give (same issue name, similar wording). An alert two rules give is labelled with
 * the surer one, and so is the earlier of two at the very same time.
 * The reverse view, on each of Burson's alerts: ahead (1 same post, 2 same story, 3 same issue name, 4 similar wording:
 * the surest rule that ties it to a story of this app's that came before it), set only by a story that was itself
 * first (ahead of the alert it is measured against): where Burson had the story first, Burson's later alerts on it
 * are not ones this app had first. The rules are in this file's header. Pure (changes its arguments).
 */
function headStartMatch_(stories, burson) {
  const byName = new Map();  // issue name -> Burson's rows under it
  // exposure tag and issue word -> Burson's alerts with that word in their name under that tag (once per alert and
  // name). The word check needs the same tag and words alike, so only alerts that share a word are ever compared
  const byWord = new Map();
  const push = (map, k, v) => { if (!map.has(k)) map.set(k, []); map.get(k).push(v); };
  const tagOf = view => (view && view.tag ? String(view.tag).trim().toLowerCase() : '');
  const sameView = (tag, r) => `${tag}\n${r.name_key}\n${JSON.stringify(r.view.idt)}`;  // rows that tell their story alike
  burson.forEach(g => {
    const seen = new Set();
    g.rows.forEach(b => {
      if (b.name_key) push(byName, b.name_key, { g, b });
      const tag = tagOf(b.view);
      if (!tag || seen.has(sameView(tag, b))) return;
      seen.add(sameView(tag, b));
      const entry = { g, b };
      b.view.tok.forEach(t => push(byWord, `${tag}\n${t}`, entry));
    });
  });
  const span = HEAD_START_STORY_DAYS_ * HEAD_START_DAY_MS_;
  const bar = Number(GEN.novelty_min_jaccard) || 0.6;  // how alike two names' words must be (AlertMemory.gs amSameStoryWords_)
  // two exposure tags that differ (one that's blank differs from none): IssueNames.gs knownIssueName_
  const otherTag = (a, b) => !!a.tag_key && !!b.tag_key && a.tag_key !== b.tag_key;
  stories.forEach(s => {
    const near = g => Math.abs(g.at - s.at) <= span;
    const post = new Set();
    s.keys.forEach(k => { if (burson.has(k)) post.add(burson.get(k)); });
    const story = new Set();
    const named = new Set();
    const similar = new Set();
    const compared = new Set();
    s.rows.forEach(r => {
      // Burson's alerts under the same issue name. A review took the later of the two for the earlier one's issue when
      // the later one is an Ongoing Issue
      const sameName = (r.name_key ? byName.get(r.name_key) || [] : []).filter(x => near(x.g));
      const taken = x => (x.b.source_at >= r.at ? x.b.ongoing : r.ongoing);
      const tied = sameName.some(taken);
      sameName.forEach(x => {
        if (taken(x)) story.add(x.g);
        // The same name and no more, never under two different exposure tags. On its own that is the weaker rule. Once
        // a review has tied one of Burson's alerts to this story under the name, the name is this story's issue (one
        // name per issue), and Burson's other alerts under it are on the same story: its first one may be among them
        else if (!otherTag(r, x.b)) (tied ? story : named).add(x.g);
      });
      // the Alert memory's word check, against Burson's alerts under the same tag that share a word of the name
      const tag = tagOf(r.view);
      if (!tag || compared.has(sameView(tag, r))) return;
      compared.add(sameView(tag, r));
      const shared = new Map();  // Burson's alert -> how many of the name's words it shares
      r.view.tok.forEach(t => (byWord.get(`${tag}\n${t}`) || []).forEach(x => {
        if (near(x.g) && !similar.has(x.g)) shared.set(x, (shared.get(x) || 0) + 1);
      }));
      shared.forEach((n, x) => {
        // far under the memory's bar (not half as alike in words): it could never pass, so the check is spared
        if (similar.has(x.g) || 2 * n < bar * (r.view.tok.length + x.b.view.tok.length - n)) return;
        let alike = 0;
        try { alike = amSameStoryWords_(r.view, x.b.view); } catch (e) { alike = 0; }
        if (alike > 0) similar.add(x.g);
      });
    });
    const rules = [post, story, named, similar];  // as HEAD_START_RULES_ numbers them, from 1
    const rank = g => rules.findIndex(set => set.has(g)) + 1;  // the surest rule that gives this alert
    const earliest = sets => {
      const all = new Set();
      sets.forEach(set => set.forEach(g => all.add(g)));
      return Array.from(all).sort((x, y) => x.at - y.at || rank(x) - rank(y) || (x.key < y.key ? -1 : 1))[0] || null;
    };
    // Burson's first alert on the story by the sure rules, whichever post it was on; else by the weaker ones
    const g = earliest([post, story]) || earliest([named, similar]);
    s.burson = g ? { key: g.key, at: g.at, alert_id: g.alert_id, url: g.url, name: g.name } : null;
    s.matched = g ? HEAD_START_RULES_[rank(g)] : '';
    s.lead_ms = g ? g.at - s.at : null;
    // The reverse view: Burson's alerts this story came before, when this story was first. Where Burson had the story
    // first (its alert above is the earlier one), Burson's later alerts on it are not ones this app had first
    if (!(s.lead_ms > 0)) return;
    rules.forEach((set, i) => set.forEach(b => {
      if (s.at < b.at && (!b.ahead || i + 1 < b.ahead)) b.ahead = i + 1;
    }));
  });
}

/**
 * The headline numbers for the stories this app alerted since `since` and Burson's alerts since then: stories; matched
 * (a Burson alert was found for them) and its share; first (this app's alert strictly before Burson's), its share of
 * the matched and the median head start in minutes; behind (Burson strictly first) and the median minutes behind;
 * unmatched (no Burson alert found: not the same as never alerted by Burson, see this file's header); im_known (stories
 * with an IM time), im_first (this app's alert before the IMs' time), its share, im_median_min (the median minutes from
 * this app's alert to the IMs' time, over every story with one: below 0 when this app was later) and im_from_email (how
 * many of those times are their email, not their draft); and the reverse view: burson_alerts, burson_after (those that
 * came after a story of this app's that was first, by any rule: headStartMatch_), its share, and burson_after_by {post,
 * story, name, wording}. A share is a whole percent, null of nothing; a median is to 0.1 minute, null of nothing. Pure.
 */
function headStartWindow_(stories, bursonList, since) {
  const list = stories.filter(s => s.at >= since);
  const pct = (a, b) => (b ? Math.round((100 * a) / b) : null);
  const median = ms => speedQuantile_(ms.map(v => v / HEAD_START_MIN_MS_), 0.5);
  const matched = list.filter(s => s.burson);
  const first = matched.filter(s => s.lead_ms > 0);
  const behind = matched.filter(s => s.lead_ms < 0);
  const withIm = list.filter(s => s.im);
  const imFirst = withIm.filter(s => s.im_lead_ms > 0);
  const theirs = bursonList.filter(g => g.at >= since);
  const after = theirs.filter(g => g.ahead);
  return {
    stories: list.length, matched: matched.length, matched_pct: pct(matched.length, list.length),
    first: first.length, first_pct: pct(first.length, matched.length), first_median_min: median(first.map(s => s.lead_ms)),
    behind: behind.length, behind_median_min: median(behind.map(s => -s.lead_ms)),
    unmatched: list.length - matched.length,
    im_known: withIm.length, im_first: imFirst.length, im_first_pct: pct(imFirst.length, withIm.length),
    im_median_min: median(withIm.map(s => s.im_lead_ms)), im_from_email: withIm.filter(s => s.im.from === 'email').length,
    burson_alerts: theirs.length, burson_after: after.length, burson_after_pct: pct(after.length, theirs.length),
    burson_after_by: { post: after.filter(g => g.ahead === 1).length, story: after.filter(g => g.ahead === 2).length,
      name: after.filter(g => g.ahead === 3).length, wording: after.filter(g => g.ahead === 4).length },
  };
}

/**
 * The whole report from the Alert log's rows (`rows`), the IMs' time per Burson post when it's at hand (`im`:
 * headStartImTimes_, or null) and the time (`now`, ms): {now, im_at_hand, stories (the last 30 days by when this app
 * alerted, newest first: {type, at, name, url, product, tag, alert_id, alert_ids, alerts, keys, burson: {key, at,
 * alert_id, url, name} | null, matched, lead_ms, im: {at, from} | null, im_lead_ms}), top (the ten of them with the
 * longest head start over Burson, longest first), windows: {week, month} (headStartWindow_ for 7 and 30 days)}. A
 * broken row is left out; it never fails the report. Pure.
 */
function headStartReport_(rows, im, now) {
  const t = Number(now) || Date.now();
  const times = im && typeof im === 'object' ? im : null;
  const stories = headStartStories_(rows);
  const burson = headStartBurson_(rows);
  headStartMatch_(stories, burson);
  stories.forEach(s => {
    s.im = null;
    s.im_lead_ms = null;
    const g = s.burson && times ? burson.get(s.burson.key) : null;
    if (!g) return;
    // the IMs' time for Burson's post, by the post's identity on the Results tab (Speed.gs postKey_ of its link)
    for (let i = 0; i < g.rows.length && !s.im; i++) {
      const post = postKey_(g.rows[i].url);
      const hit = post && Object.prototype.hasOwnProperty.call(times, post) ? times[post] : null;
      if (hit && Number(hit.at) > 0) s.im = { at: Number(hit.at), from: hit.from === 'email' ? 'email' : 'draft' };
    }
    if (s.im) s.im_lead_ms = s.im.at - s.at;
  });
  stories.forEach(s => { delete s.rows; });
  const bursonList = Array.from(burson.values());
  const monthStart = t - HEAD_START_DAYS_ * HEAD_START_DAY_MS_;
  const month = stories.filter(s => s.at >= monthStart)
    .sort((x, y) => y.at - x.at || (x.alert_id < y.alert_id ? -1 : x.alert_id > y.alert_id ? 1 : 0));
  const top = month.filter(s => s.lead_ms > 0).sort((x, y) => y.lead_ms - x.lead_ms || y.at - x.at).slice(0, HEAD_START_TOP_);
  return {
    now: t, im_at_hand: !!times, stories: month, top,
    windows: { week: headStartWindow_(stories, bursonList, t - HEAD_START_WEEK_DAYS_ * HEAD_START_DAY_MS_),
      month: headStartWindow_(stories, bursonList, monthStart) },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The tab
// ---------------------------------------------------------------------------------------------------------------

/**
 * A length of time in words, from minutes: "45 min", "3 h 10 min", "2 d 15 h" (a day or more: to the hour), "under 1
 * min"; "behind by 20 min" for minutes below 0 (this app was later); '' for none (never a zero). Pure.
 */
function headStartWords_(minutes) {
  if (minutes === null || minutes === undefined || minutes === '' || !isFinite(Number(minutes))) return '';
  const v = Number(minutes);
  const m = Math.round(Math.abs(v));
  let words;
  if (m < 1) words = v === 0 ? 'the same minute' : 'under 1 min';
  else if (m < 60) words = `${m} min`;
  else if (m < 24 * 60) words = `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
  else {
    const h = Math.round(m / 60);
    words = `${Math.floor(h / 24)} d${h % 24 ? ` ${h % 24} h` : ''}`;
  }
  return v < 0 ? `behind by ${words}` : words;
}

/**
 * A name linked to a post, with the Results tab's quoted link (Speed.gs resultsLink_: =HYPERLINK only for an http(s)
 * link, every double quote doubled, so a name can't end the formula; else the name as text, never a formula). The name
 * is one line and cut short; a link with a space in it, or too long for a cell, isn't linked. Pure.
 */
function headStartLink_(url, label) {
  const name = truncate_(headStartText_(label), HEAD_START_NAME_CHARS_) || '(no name)';
  const link = headStartText_(url);
  const usable = /^https?:\/\/\S+$/i.test(link) && link.length <= HEAD_START_LINK_CHARS_;
  return resultsLink_({ url: usable ? link : '', network: name, author: '' });
}

/** One story's row in a stories table (HEAD_START_HEADER_): blank, never a zero, without a Burson alert or an IM time. */
function headStartRow_(s) {
  const words = ms => headStartWords_(ms / HEAD_START_MIN_MS_);
  const minutes = ms => Math.round(ms / 6000) / 10;
  const b = s.burson;
  const ids = (s.alert_ids || []).slice(0, 4).join(', ') + ((s.alert_ids || []).length > 4 ? ` and ${s.alert_ids.length - 4} more` : '');
  return [s.type, speedTime_(s.at), headStartLink_(s.url, s.name), pwCell_(s.product, HEAD_START_NAME_CHARS_),
    pwCell_(s.tag, HEAD_START_NAME_CHARS_), b ? speedTime_(b.at) : '', b ? words(s.lead_ms) : '',
    s.im ? speedTime_(s.im.at) : '', s.im ? words(s.im_lead_ms) : '', s.matched || '',
    pwCell_(ids, HEAD_START_NAME_CHARS_), b ? headStartLink_(b.url, b.alert_id || 'Burson\'s alert') : '',
    b ? minutes(s.lead_ms) : '', s.im ? minutes(s.im_lead_ms) : ''];
}

/** What's counted and when it was rebuilt (the line under the title). */
function headStartScopeText_(r) {
  return `What's counted: every story this app alerted on its own in the last ${HEAD_START_DAYS_} days (Early Detection ` +
    'cards and early signals, Watch alerts, Direct BigQuery alerts; a card and its updates are one story, timed from the ' +
    'first), next to Burson\'s alert on the same post or the same story and the IMs\' email for that Burson alert. Times ' +
    `are when each alert was posted. Rebuilt ${speedTime_(r.now)} ET.`;
}

/** How the stories are matched and where the IMs' times come from (the note under the headline numbers). */
function headStartNoteText_(r) {
  const m = r.windows.month;
  return `Matched on: "${HEAD_START_SAME_POST_}" (Burson alerted one of the story's posts); "${HEAD_START_SAME_STORY_}" ` +
    '(Burson\'s alert and this app\'s carry the same issue name, and the later of the two was recorded as an Ongoing ' +
    'Issue; Burson\'s other alerts under that name then count too). A story is measured against the earliest of ' +
    'Burson\'s alerts those two give: Burson\'s first alert on the story, even when Burson alerted the story\'s own post ' +
    `later. Only when they give none, two weaker matches are tried (check them): "${HEAD_START_SAME_NAME_}" (the same ` +
    `issue name and no more, never under two different exposure tags) and "${HEAD_START_SIMILAR_}" (the same exposure ` +
    `tag and issue names alike). The same-story rules look ${HEAD_START_STORY_DAYS_} days either side of the story. A ` +
    'head start is from this app\'s alert to Burson\'s alert (or to the IMs\' email: end to end); "behind by" means this ' +
    'app was later. One of Burson\'s alerts counts as alerted first by this app when it came after a story this app was ' +
    'first on, not when Burson already had that story. ' +
    '"No Burson alert found" doesn\'t mean Burson never alerted the story: Burson\'s later alert takes a story\'s issue ' +
    'name only when this app\'s alert went out as a Social Alert. An alert that was only to be watched is found again ' +
    'only on its own posts, on an identical issue name, or on similar wording under the same exposure tag, so "this app ' +
    'alerted first" is, if anything, undercounted. ' +
    (r.im_at_hand
      ? `The IMs' time is their email for Burson's post, else their draft, as the Results tab has it (their email for ${m.im_from_email} ` +
        `of ${m.im_known} in the last ${HEAD_START_DAYS_} days); it is blank for a Burson alert the Results tab no longer shows.`
      : 'The IMs\' times weren\'t at hand for this rebuild (they come with the Results tab\'s rebuild in the every-minute run), ' +
        'so those columns are blank.');
}

/**
 * The tab's cells, top to bottom, every row HEAD_START_HEADER_ wide: {rows, marks: {section, head, merged, numbers,
 * times}} (row numbers for the formats; numbers: the headline numbers' rows; times: [first row, count] of each stories
 * table). Every text cell fits a cell (Sheets.gs capCell_). `r`: headStartReport_'s. Pure.
 */
function headStartTabRows_(r) {
  const width = HEAD_START_HEADER_.length;
  const rows = [];
  const marks = { section: [], head: [], merged: [], numbers: [], times: [] };
  const add = (row, kind) => {
    rows.push(row.map(v => (v === null || v === undefined ? '' : capCell_(v)))
      .concat(new Array(Math.max(0, width - row.length)).fill('')).slice(0, width));
    if (kind) marks[kind].push(rows.length);
    return rows.length;
  };
  const dash = '—';
  const of = (x, y, pct) => (y ? `${x} of ${y}${pct === null || pct === undefined ? '' : ` (${pct}%)`}` : dash);
  const words = min => (min === null || min === undefined ? dash : headStartWords_(min));
  const w = r.windows.week;
  const m = r.windows.month;
  const split = x => (x.burson_after ? `: ${[[x.burson_after_by.post, HEAD_START_SAME_POST_], [x.burson_after_by.story, HEAD_START_SAME_STORY_],
    [x.burson_after_by.name, 'same issue name'], [x.burson_after_by.wording, 'similar wording']].filter(p => p[0])
    .map(p => `${p[0]} ${p[1]}`).join(', ')}` : '');

  add([HEAD_START_TITLE_]);
  add([headStartScopeText_(r)], 'merged');
  add([]);
  add(['HEADLINE NUMBERS', `Last ${HEAD_START_WEEK_DAYS_} days`, `Last ${HEAD_START_DAYS_} days`], 'section');
  [
    ['Stories this app alerted on its own', w.stories, m.stories],
    ['Of those, also alerted by Burson', of(w.matched, w.stories, w.matched_pct), of(m.matched, m.stories, m.matched_pct)],
    ['This app alerted first (of those Burson alerted too)', of(w.first, w.matched, w.first_pct), of(m.first, m.matched, m.first_pct)],
    ['Median head start over Burson (where this app was first)', words(w.first_median_min), words(m.first_median_min)],
    ['Burson alerted first', w.behind, m.behind],
    ['Median time this app was behind (where Burson was first)', words(w.behind_median_min), words(m.behind_median_min)],
    // not "not alerted by Burson": Burson may have alerted it under a name the matching can't tie to it (the note below)
    ['No Burson alert found', w.unmatched, m.unmatched],
    ['This app\'s alert before the IMs\' email (of the stories with an IM email time)', of(w.im_first, w.im_known, w.im_first_pct),
      of(m.im_first, m.im_known, m.im_first_pct)],
    ['Median time from this app\'s alert to the IMs\' email (the end-to-end head start)', words(w.im_median_min), words(m.im_median_min)],
    ['Burson\'s alerts in the same days', w.burson_alerts, m.burson_alerts],
    ['Of Burson\'s alerts, those this app had alerted first (same post or same story)',
      of(w.burson_after, w.burson_alerts, w.burson_after_pct) + split(w), of(m.burson_after, m.burson_alerts, m.burson_after_pct) + split(m)],
  ].forEach(row => add(row, 'numbers'));
  add([headStartNoteText_(r)], 'merged');
  add([]);

  const table = list => {
    const first = rows.length + 1;
    list.forEach(s => add(headStartRow_(s)));
    if (list.length) marks.times.push([first, list.length]);
  };
  add([`BIGGEST HEAD STARTS (last ${HEAD_START_DAYS_} days: the ${HEAD_START_TOP_} stories this app alerted longest before Burson)`], 'section');
  add(HEAD_START_HEADER_, 'head');
  if (!r.top.length) add(['None yet']);
  table(r.top);
  add([]);

  add([`EVERY STORY (last ${HEAD_START_DAYS_} days, newest first; one row per story of this app's own)`], 'section');
  add(HEAD_START_HEADER_, 'head');
  if (!r.stories.length) add(['None yet']);
  table(r.stories);
  return { rows, marks };
}

/**
 * Writes the whole tab (values first, then the formats). `r`: headStartReport_'s. Refuses (throws, nothing cleared or
 * written) unless the tab is the one the bot made (isHeadStartTab_).
 */
function writeHeadStartTab_(sh, r) {
  if (!isHeadStartTab_(sh)) throw new Error(`"${sh && sh.getName()}" isn't the bot's ${HEAD_START_TAB_} tab: left as it is`);
  const built = headStartTabRows_(r);
  const out = built.rows;
  const marks = built.marks;
  const width = HEAD_START_HEADER_.length;
  const prev = sh.getLastRow();
  const prevCols = sh.getLastColumn();
  // The bot's mark (its title in A1: isHeadStartTab_) goes in first and is never cleared, so a rebuild that stops
  // before the values are written leaves a tab the next rebuild still knows as its own. Then every other cell the last
  // rebuild left is cleared
  sh.getRange(1, 1).setValue(HEAD_START_TITLE_);
  if (prevCols > 1) sh.getRange(1, 2, 1, prevCols - 1).clearContent();
  if (prev > 1) sh.getRange(2, 1, prev - 1, Math.max(prevCols, 1)).clearContent();
  const fmt = f => { try { f(); } catch (e) { /* formatting only */ } };
  fmt(() => sh.clearFormats());  // the bold headers and merged notes move with the tables' lengths
  fmt(() => sh.getRange(1, 1, Math.max(prev, out.length, 6), width).breakApart());
  sh.getRange(1, 1, out.length, width).setValues(out);
  fmt(() => sh.getRange(1, 1).setFontWeight('bold').setFontSize(13));
  if (marks.numbers.length) fmt(() => sh.getRange(marks.numbers[0], 1, marks.numbers.length, 1).setWrap(true));  // their labels
  marks.section.forEach(row => fmt(() => sh.getRange(row, 1, 1, HEAD_START_WIDE_).setFontWeight('bold').setBackground('#e8eaed')
    .setWrap(true)));
  marks.head.forEach(row => fmt(() => sh.getRange(row, 1, 1, width).setFontWeight('bold').setBackground('#f1f3f4').setWrap(true)));
  marks.merged.forEach(row => fmt(() => {
    sh.getRange(row, 1, 1, HEAD_START_WIDE_).merge().setWrap(true).setVerticalAlignment('top').setFontColor('#5f6368')
      .setFontStyle('italic');
    sh.setRowHeight(row, resultsRowHeight_(String(out[row - 1][0])));
  }));
  // the three times of each story (this app's, Burson's, the IMs'), as the Results tab shows its times
  marks.times.forEach(([first, count]) => [2, 6, 8].forEach(col => fmt(() => sh.getRange(first, col, count, 1)
    .setNumberFormat('yyyy-mm-dd hh:mm'))));
  return { rows: out.length };
}

/**
 * Is this the Head start tab the bot made? Its A1 is the title the bot writes there (HEAD_START_OWN_TITLES_). A tab
 * people made doesn't have it, and an empty tab isn't the bot's: such a tab is never read, cleared or written.
 */
function isHeadStartTab_(sh) {
  try {
    if (!sh || sh.getLastRow() < 1) return false;
    return HEAD_START_OWN_TITLES_.includes(String(sh.getRange(1, 1).getDisplayValue()).trim());
  } catch (e) {
    return false;
  }
}

/** A tab named Head start that the bot didn't make is in the way (refreshHeadStart_ then leaves it as it is). */
function headStartTabForeign_(ss) {
  const sh = ss.getSheetByName(HEAD_START_TAB_);
  return !!sh && !isHeadStartTab_(sh);
}

/** Why the Head start tab isn't updated while a tab people made has its name (the log, and headStartBlockedNote_). */
function headStartBlockedText_() {
  return `a tab named "${HEAD_START_TAB_}" that the bot didn't make is in the way (or its title in A1 was changed). ` +
    'Rename that tab, and the bot makes its own.';
}

/**
 * Remembers whether a "Head start" tab the bot didn't make is in the way (`blocked`: HEAD_START_BLOCKED_PROP_);
 * forgotten at the first rebuild once it's gone. Never throws.
 */
function noteHeadStartBlocked_(blocked) {
  try {
    const props = PropertiesService.getScriptProperties();
    const was = props.getProperty(HEAD_START_BLOCKED_PROP_) === 'true';
    if (blocked && !was) props.setProperty(HEAD_START_BLOCKED_PROP_, 'true');
    if (!blocked && was) props.deleteProperty(HEAD_START_BLOCKED_PROP_);
  } catch (e) {
    console.error('could not note the Head start tab: ' + ((e && e.message) || e));
  }
}

/** Why the Head start tab isn't being updated ('' when it is): for a status line. Never throws. */
function headStartBlockedNote_() {
  try {
    if (PropertiesService.getScriptProperties().getProperty(HEAD_START_BLOCKED_PROP_) !== 'true') return '';
    return `The Head start tab isn't being updated: ${headStartBlockedText_()}`;
  } catch (e) {
    return '';
  }
}

/**
 * The Head start tab, made if missing (after the last of the Results, Learned precedents, Follow-up and Analysis tabs,
 * so none of them moves; at the end when there's none), with its title in A1 at once (the bot's mark: isHeadStartTab_)
 * and protected with a warning. null when a tab named Head start exists that the bot didn't make: that tab is never
 * cleared or written.
 */
function ensureHeadStartTab_(ss) {
  let sh = ss.getSheetByName(HEAD_START_TAB_);
  if (sh) return isHeadStartTab_(sh) ? sh : null;
  const names = ss.getSheets().map(s => s.getName());
  const reports = [RESULTS_TAB_, LEARNED_TAB_, FOLLOWUP_TAB_, ANALYSIS_TAB_].map(n => names.indexOf(n)).filter(i => i >= 0);
  sh = ss.insertSheet(HEAD_START_TAB_, reports.length ? Math.max.apply(null, reports) + 1 : names.length);
  sh.getRange(1, 1).setValue(HEAD_START_TITLE_);
  try { sh.protect().setDescription('Written by the Burson QA bot').setWarningOnly(true); } catch (e) { /* the tab works unprotected */ }
  try { HEAD_START_WIDTHS_.forEach(([c, px]) => sh.setColumnWidth(c, px)); } catch (e) { /* the tab works unformatted */ }
  return sh;
}
