/**
 * ProactiveWatch.gs — Proactive watch (Control tab row 34, proactiveWatch, OFF unless switched ON): catching Google
 * brand-safety issues before Burson's alert space does. Nothing here posts in Chat, emails anyone or writes outside the
 * bot's own sheet (Watch alerts, WatchAlerts.gs, posts its flags where Control row 35 says): it records what it flagged,
 * for people to rate and for its scorecard to compare with Burson's alerts.
 *
 * Every PW_EVERY_MS_ (Main.gs poll()'s finally, after the other spaces, while the bot and the switch are ON), a look
 * reads what is new in each of its sources (PW_SOURCES_) since the last look, read-only, where the data already is: no
 * table, view or pipeline is made (a script's temporary table is gone when the script ends). BigQuery reads one location
 * a job, so a look is two jobs (PW_LANES_):
 *   us-central1  Pendulum's `sonar_raw` (current to the minute): the posts it first saw since the last look (none it saw
 *                in the 24 hours before), posted within the last 24 hours, with at least one risk smart tag (not only
 *                praise, use-case or other positive ones), from an account with PW_MIN_FOLLOWERS_+ followers or with
 *                PW_MIN_ENGAGEMENT_+ engagements already, and what wasn't noticeable at first (posts that grew past
 *                that floor later, and posts already checked that broke out: PW_BREAKOUT_X_ times the engagements,
 *                PW_BREAKOUT_MIN_+), the biggest accounts first; and Tubular's videos that mention Google (each run's
 *                new ones).
 *   US           Brandwatch's mentions of Google's products (`raw_data.brandwatch_raw_mentions_base`: loaded in a
 *                nightly batch, 1-6 days after posting; read only when the table changed): the Google product configs
 *                (PW_BWM_CONFIGS_), English, negative only, tagged by Brandwatch with an SLRR exposure tag
 *                (PW_BWM_EXPOSURE_GROUP_), Reddit, Bluesky, Facebook and Instagram only (PW_BWM_NETWORKS_: X comes
 *                from Sonar live, YouTube and TikTok from Tubular and Sonar), no shares, the reach floor, each mention
 *                once, the biggest first: PW_BWM_LOOK_MAX_ a look, a bigger batch handed over across the next looks,
 *                and PW_BWM_DAY_MAX_ a day at most, so a night's batch never holds a look past PW_JOB_MAX_MS_; Google's
 *                own posts whose comments turned negative (Sprinklr's `reporting_data.sprinklr_outbound_reporting`,
 *                loaded once a day; read only when it changed; English, on the networks in PW_NETWORKS_); comments on
 *                Google's own posts (Sprinklr's `reporting_data.sprinklr_inbound_comments`: a pile-on of
 *                PW_PILEUP_NEG_+ negative comments within an hour, or a negative comment from a PW_BIG_VOICE_+
 *                account); the DSD story selection feed (Brandwatch's HIGH and KOF alert emails, the DSD desk's story
 *                pool); the alerts in other formats (Brandwatch's) the bot read in the Other alerts space (Control
 *                B33, e.g. Midterms 2026), from the Alert log, handed to the query as a parameter; and the Brandwatch
 *                query "2026 Election Alerts" read straight from Brandwatch's API (PW_BW_*: the shared token
 *                slrr-campaigns keeps in Secret Manager; what Brandwatch added since the last look, usually minutes
 *                after posting; X posts' text from X's embed data, which Brandwatch's API leaves out), handed to the
 *                query as a parameter too. (Dropped Nov 1 as stale: the daily Brandwatch export, nothing since Sep 20;
 *                the DSD content vectors, since Sep 24; Reddit Pulse, since Oct 25. Dropped Nov 11, as not on the
 *                team's list of approved tables: BMIE's alert mentions and Sprinklr's older export of Google's own
 *                posts.) The owner asked on 16 Nov 2026 for BMIE's alert mentions (the AMIE table) to be read again:
 *                with Control row 50 ON (and row 34) the US look also reads it (PW_AMIE_SOURCE_, pwSources_), each
 *                row once, after a check of its columns (step 1c's ewsAmiMeta_), and while row 50 is ON a flag from
 *                it, or from Brandwatch's mentions table, asks the alert memory about the last 7 days.
 * In each job, every source's new rows go, as the same columns, in a temporary table (a source that fails is noted and
 * the others carry on). Sonar and the comments go by the look's window; the others keep their own place, the newest
 * item they handed over (PW_MARKS). Then, for each watch ON on the Watches tab (PW_MAX_WATCHES_ at most), Gemini inside
 * BigQuery: AI.IF, the watch's yes/no question, then for the posts that match AI.SCORE (how likely it is to become a
 * brand-safety issue in the next 6 hours, 1-10, by the watch's rubric) and AI.CLASSIFY (its topic, from the watches'
 * topics). They use the script's own cloud-platform token (end-user credentials): no connection, no new permission.
 * Each job also returns one row a source (what was new, what Gemini checked, its newest item, when its table last
 * changed, any error): the Watch sources tab says which sources are live and which are stale.
 * Measured on Burson's 655 alerts of Oct 19-30: Sonar saw 54% of their posts, 88% of those before Burson (a median 2.5
 * hours sooner), and its filter keeps 84% of those it saw first while cutting ~22,000 new posts a day to ~4,200.
 * Brandwatch's mentions table loads a night's batch 1-6 days after posting (Nov 11: ~255 of that night's mentions
 * passed its filters, in one load), Sprinklr's report loads about 10 AM ET and Tubular finds most videos a day or two
 * after: they add reach, not speed. The comments on Google's own posts reach BigQuery a median ~22 minutes after
 * they're written. A US look that gave Gemini ~70 posts for one watch took up to ~2 minutes (Nov 10).
 *
 * Each job is sent in one run and collected in a later one, so it never holds a run up; a failing job is tried again
 * (PW_MAX_TRIES_, then its window is skipped), each location on its own, and until a job of that location succeeds again
 * C34 says since when its look has failed and why, and the Watch sources tab shows its sources as failing (pwFailed_).
 * Posts at or above a watch's bar, and the near
 * misses (within PW_NEAR_ of it, to tune the bar), go on the Watch detections tab, each post once a watch (whichever
 * source handed it over first), with a Rating column for people. The tab's scorecard compares them with Burson's alerts
 * in the Alert log, day by day: how many of Burson's posts a watch flagged, how many before Burson's alert reached S-F
 * Burson and by how much, and the ratings. The three tabs are the bot's (made the first time the switch is ON): a tab
 * with one of their names that the bot didn't make is never read or written.
 */

const PW_EVERY_MS_ = 5 * 60 * 1000;          // a look at most every 5 minutes (recorded when the query is sent)
const PW_START_MS_ = 15 * 60 * 1000;         // a first look (switched ON, back from a pause, a watch turned ON): the last 15 min
const PW_MAX_WINDOW_MS_ = 30 * 60 * 1000;    // never more than the last 30 minutes at once: no backlog after a gap
const PW_MIN_WINDOW_MS_ = 60 * 1000;         // a window shorter than this waits for the next run
const PW_SETTLE_MS_ = 60 * 1000;             // what the sources got in the last minute waits for the next look
const PW_NEW_HOURS_ = 24;                    // "new": not seen in the 24 hours before the window, and posted within 24 hours
const PW_MIN_FOLLOWERS_ = 1000;              // reach floor: 1,000+ followers...
const PW_MIN_ENGAGEMENT_ = 100;              // ...or 100+ engagements (likes + comments + shares) already
const PW_MAX_POSTS_ = 150;                   // Sonar's posts asked about in a look at most (the biggest accounts first)
const PW_MAX_WATCHES_ = 5;                   // watches ON at once at most (each post costs one AI.IF a watch)
const PW_TEXT_CHARS_ = 1500;                 // of each post (Pendulum's summary and the post's text) given to Gemini
const PW_PROMPT_CHARS_ = 2000;               // of a watch's question or rubric
const PW_NEAR_ = 2;                          // rows kept below a watch's bar: scores within 2 of it (to tune the bar)
const PW_DEFAULT_BAR_ = 7;                   // a watch's bar when its "Flag at score" is blank or unreadable
const PW_MAX_TOPICS_ = 20;                   // topics AI.CLASSIFY chooses from (the watches' together), plus "Other"
const PW_SUBMIT_WAIT_MS_ = 2000;             // how long sending the query waits for it (a later run collects it)
const PW_COLLECT_WAIT_MS_ = 3000;            // how long collecting waits for it
const PW_JOB_MAX_MS_ = 4 * 60 * 1000;        // a query still running after 4 minutes is cancelled; the window is tried again
const PW_MAX_TRIES_ = 3;                     // a window that failed 3 times is skipped (noted), so one bad window can't stop it
const PW_MAX_BYTES_ = String(5 * 1024 * 1024 * 1024);  // BigQuery refuses a look that would read more than 5 GB (~0.4 GB is usual)
const PW_MIN_LEFT_MS_ = 20 * 1000;           // with less of the run left than this, nothing is sent, collected or scored
const PW_SCORE_EVERY_MS_ = 10 * 60 * 1000;   // the scorecard: at most every 10 minutes, and right after new rows
const PW_SCORE_DAYS_ = 7;                    // its days (today first), then their total
const PW_DET_MAX_ROWS_ = 5000;               // rows kept on the Watch detections tab (the oldest go first)...
const PW_DET_TRIM_SLACK_ = 500;              // ...trimmed once there are this many more, so it isn't rewritten every look
const PW_DET_READ_ROWS_ = 3000;              // the newest read to skip a post already there and for the scorecard
const PW_WATCHES_MAX_ROWS_ = 30;             // rows of the Watches tab read
const PW_PILEUP_NEG_ = 5;                    // Sprinklr comments: this many negative comments on a Google post within an hour...
const PW_BIG_VOICE_ = 100000;                // ...or one negative comment from an account with this many followers
const PW_CHAT_READ_ROWS_ = 600;              // the Alert log's newest rows read for the Other alerts space's alerts
const PW_ERR_CHARS_ = 300;                   // of a source's error kept
const PW_NOTE_CHARS_ = 200;                  // a switch's note (C34 after its fixed text) is cut at this (Control.gs noteSwitch_)
const PW_FAIL_WHY_MIN_ = 16;                 // of a failed look's reason C34 keeps this much: the last look's numbers give way first
const PW_HOUR_MS_ = 60 * 60 * 1000;
// The Brandwatch query read straight from Brandwatch's API (source 'bwq'), with the token slrr-campaigns mints and keeps
// in Secret Manager (read each look; never kept, logged or written anywhere)
const PW_BW_API_ = 'https://api.brandwatch.com';
const PW_BW_PROJECT_ = 1998344909;           // the Brandwatch project...
const PW_BW_QUERY_ = 2004167929;             // ...and its query
const PW_BW_QUERY_NAME_ = '2026 Election Alerts';
const PW_BW_SECRET_ = 'slrr-campaigns-bw-token';  // the shared token's secret (in GCP_PROJECT)
const PW_BW_FIRST_PAGE_ = 20;                // a look's first page: on a quiet look all it reads...
const PW_BW_PAGE_ = 100;                     // ...else mentions a Brandwatch page (the newest added first)...
const PW_BW_MAX_PAGES_ = 3;                  // ...pages a look at most (Brandwatch allows the client 600 calls in 10 minutes)
const PW_BW_HOURS_ = 72;                     // only posts from the last 72 hours
const PW_BW_X_MAX_ = 60;                     // X posts a look whose text is read from X's embed data (the biggest accounts first)
// Networks where Brandwatch's potential audience is the author's followers (elsewhere it's a site's audience)
const PW_BW_SOCIAL_ = ['twitter', 'bluesky', 'instagram', 'facebook', 'threads', 'tiktok', 'youtube', 'linkedin'];
// Posts by Grok (X's AI account, @grok) are left out of the watch, from every source (pwGrokSql_ before Gemini, pwByGrok_
// when recording): its answers to people's questions are no one's post to flag. People's replies to Grok stay in.
const PW_GROK_URL_RX_ = /^https?:\/\/(?:www\.|m\.|mobile\.)?(?:x|twitter)\.com\/grok\//i;
const PW_GROK_WHY_ = 'Grok left out';        // how the Watch sources tab counts them
const PW_GROWTH_HOURS_ = 72;                 // Sonar: a post that grew past the floor, or broke out, posted within 72 hours...
const PW_BREAKOUT_X_ = 10;                   // ...broke out: checked before, and its engagements have since gone up 10 times...
const PW_BREAKOUT_MIN_ = 1000;               // ...to at least this many
// Brandwatch's mentions table (source 'bwm') covers 35 product configs, most of them Google's competitors: these are Google's
const PW_BWM_CONFIGS_ = ['Google Search', 'Google AI', 'Google Cloud', 'Gemini', 'Google Pixel', 'Google Glasses', 'Googlebook'];
// Sprinklr's report of Google's own posts (source 'owned'): a post whose comments turned negative, that is this many
// negative comments, or this share of them negative once it has this many
const PW_OWNED_NEG_ = 25;
const PW_OWNED_PCT_ = 0.3;
const PW_OWNED_MIN_COMMENTS_ = 20;
// The team's list of networks (Nov 10), as Sonar names them (pwNetSql_): Sprinklr's report of Google's own posts is read
// for these only
const PW_NETWORKS_ = ['twitter', 'reddit', 'bluesky', 'facebook', 'instagram', 'youtube', 'tiktok'];
// Brandwatch's mentions table: only these networks (its X mentions come without their text and Sonar has X live; YouTube
// and TikTok come from Tubular and Sonar), only negative mentions Brandwatch itself tagged with an SLRR exposure tag (this
// category group: "Risk - Child Safety", "Product - Dangerous results"...), no shares. Gemini gets PW_BWM_LOOK_MAX_ of
// them a look at most, a bigger batch over the next looks (a night's batch is one load: ~255 passed on Nov 11, and a US
// look with ~70 posts for one watch took up to ~2 minutes, so a whole batch in one look could run past PW_JOB_MAX_MS_ and
// be cancelled), and PW_BWM_DAY_MAX_ a day at most (ET; counted on PW_TODAY, so switching OFF and ON keeps the count)
const PW_BWM_NETWORKS_ = ['reddit', 'bluesky', 'facebook', 'instagram'];
const PW_BWM_EXPOSURE_GROUP_ = 'V2 [MAIN] EN BSafety Landscape: Exposure & Risk Tags';
const PW_BWM_LOOK_MAX_ = 60;                 // with the US look's other sources: 300 posts a look at most, as with BMIE
const PW_BWM_DAY_MAX_ = 1000;

const PW_JOB_PROP_ = 'PW_JOB';               // the us-central1 query waiting to be collected: {id, project, location, since, until, at, tries}
const PW_SINCE_PROP_ = 'PW_SINCE';           // where its next window starts (ms): the last collected window's end
const PW_AT_PROP_ = 'PW_AT';                 // when it was last sent (ms)
const PW_TRIES_PROP_ = 'PW_TRIES';           // its failed tries at the window starting at PW_SINCE
const PW_DAY_PROP_ = 'PW_TODAY';             // today's numbers: {day, looks, checked, flagged, near, w: {watch: [flagged, near]}, src: {source: [checked, flagged]}}
const PW_PAUSED_PROP_ = 'PW_PAUSED';         // set while the bot is paused: the next look starts afresh
const PW_SCORE_AT_PROP_ = 'PW_SCORE_AT';     // when the scorecard was last written (ms)
// The last looks collected: {at, checked, flagged, near, lanes: {c1|us: {at, checked, flagged, near}}}: each lane's
// latest, and their sum. A lane whose look failed as a whole has {fail: {since (ms: its first failed try), why (its
// latest try's, 160 characters at most), ok (ms: when its last good look was collected; left out when it had none)}}
// as its entry instead, with no numbers, until a look of it succeeds again (pwFailed_, pwDone_, pwLastWith_)
const PW_LAST_PROP_ = 'PW_LAST';
const PW_MARKS_PROP_ = 'PW_MARKS';           // each source's place (ms): the newest item it handed over; <source>_mod: when its
                                             // table was read; <source>_snap: a batch it is still handing over (pwSnap_)
const PW_SOURCES_PROP_ = 'PW_SOURCES';       // each source's last look: {source: {at, found, checked, newest, mod, err, flagged}}

const PW_SONAR_RAW_ = '`bsip-s-bsip-gg-26-2cf3.google_bg.sonar_raw`';
const PW_LOCATION_ = 'us-central1';

/** The two jobs of a look, one a BigQuery location, each with its own window, tries and waiting job. */
const PW_LANES_ = [
  { key: 'c1', location: PW_LOCATION_, jobProp: PW_JOB_PROP_, sinceProp: PW_SINCE_PROP_, atProp: PW_AT_PROP_, triesProp: PW_TRIES_PROP_ },
  { key: 'us', location: 'US', jobProp: 'PW_US_JOB', sinceProp: 'PW_US_SINCE', atProp: 'PW_US_AT', triesProp: 'PW_US_TRIES' },
];

/**
 * Where the watch looks, read-only, in the order of the Watch sources tab. lane: its job (PW_LANES_); bq: its table
 * (when it last changed is read from the dataset's __TABLES__, which costs nothing); cap: rows a look gives Gemini at
 * most (each source's most-followed or most-engaged first); window: it goes by the look's window, else it keeps its own
 * place (PW_MARKS: firstMs back on a first look, maxMs back at most); gate: read only when its table changed (its
 * "<key>_mod" mark: when it was last read); dayMax: rows a day (ET) it gives Gemini at most, counted on PW_TODAY (so
 * switching OFF and ON again doesn't start the day's count over); spread: a batch bigger than its cap is handed over
 * across the next looks, in the same order, as its table stood when the first of them read it (its "<key>_snap" mark:
 * pwSnap_; one not handed over within maxMs is let go); staleMs: no change to its table for longer than this and the
 * tab calls it stale (0: never); plainWhy: the usual reason its rows are asked about (any other reason is shown beside
 * the source on the Watch detections tab).
 */
const PW_SOURCES_ = [
  { key: 'sonar', lane: 'c1', name: 'Sonar', window: true, cap: PW_MAX_POSTS_, staleMs: 30 * 60 * 1000, plainWhy: 'new',
    bq: 'bsip-s-bsip-gg-26-2cf3.google_bg.sonar_raw',
    what: 'Posts Pendulum collects for Google (X, Instagram, TikTok, YouTube, Reddit and more), current to the minute: new ' +
      `posts at first sight, posts that went unnoticed at first and grew past the reach floor later, and posts that broke out ` +
      `(${PW_BREAKOUT_X_}x the engagements, ${PW_BREAKOUT_MIN_.toLocaleString('en-US')}+)` },  // no other file's function at load time
  { key: 'tubular', lane: 'c1', name: 'Tubular', cap: 60, firstMs: 24 * PW_HOUR_MS_, maxMs: 24 * PW_HOUR_MS_, staleMs: 12 * PW_HOUR_MS_,
    bq: 'brand-social-central-data.google_tubular_mentions.tubular_videos',
    what: 'Videos that mention Google (YouTube, Instagram, Facebook, TikTok), each run\'s new ones; Tubular finds most a day or two after they go up' },
  { key: 'bwm', lane: 'us', name: 'Brandwatch mentions', gate: true, spread: true, cap: PW_BWM_LOOK_MAX_, dayMax: PW_BWM_DAY_MAX_,
    firstMs: 2 * PW_HOUR_MS_, maxMs: 6 * PW_HOUR_MS_, staleMs: 30 * PW_HOUR_MS_, plainWhy: 'negative',
    bq: 'brand-social-central-data.raw_data.brandwatch_raw_mentions_base',
    what: `Brandwatch's mentions of Google's products (${PW_BWM_CONFIGS_.join(', ')}) on Reddit, Bluesky, Facebook and ` +
      'Instagram that Brandwatch rates negative and tags with an SLRR exposure tag: loaded in a nightly batch (1-6 days ' +
      `after posting), read when the table changes; English, no shares, ${PW_MIN_FOLLOWERS_.toLocaleString('en-US')}+ reach ` +
      `or ${PW_MIN_ENGAGEMENT_}+ engagements, posted within 72 hours, each mention once, the biggest first, ` +
      `${PW_BWM_LOOK_MAX_} a look (a bigger batch over the next looks) and ${PW_BWM_DAY_MAX_.toLocaleString('en-US')} a day ` +
      'at most (X comes from Sonar; YouTube and TikTok from Tubular and Sonar)' },
  { key: 'owned', lane: 'us', name: 'Sprinklr owned posts', gate: true, cap: 40, firstMs: 30 * PW_HOUR_MS_, maxMs: 48 * PW_HOUR_MS_,
    staleMs: 36 * PW_HOUR_MS_, plainWhy: 'negative comments', bq: 'brand-social-central-data.reporting_data.sprinklr_outbound_reporting',
    what: `Google's own posts in English from the last 72 hours whose comments turned negative (${PW_OWNED_NEG_}+ negative ` +
      `comments, or ${Math.round(PW_OWNED_PCT_ * 100)}%+ negative once there are ${PW_OWNED_MIN_COMMENTS_}+), on X, Reddit, ` +
      'Bluesky, Facebook, Instagram, YouTube and TikTok, from Sprinklr\'s report (loaded once a day, ~10 AM ET), the most ' +
      'negative first' },
  { key: 'comments', lane: 'us', name: 'Sprinklr comments', window: true, cap: 30, staleMs: 2 * PW_HOUR_MS_,
    bq: 'brand-social-central-data.reporting_data.sprinklr_inbound_comments',
    what: `Comments on Google's own posts: a pile-on (${PW_PILEUP_NEG_}+ negative within an hour) or a negative comment from a 100K+ account` },
  { key: 'story', lane: 'us', name: 'DSD story selection', cap: 40, firstMs: 2 * PW_HOUR_MS_, maxMs: 6 * PW_HOUR_MS_, staleMs: 6 * PW_HOUR_MS_,
    bq: 'brand-social-central-data.DSD.DSD-story-selection',
    what: 'Brandwatch\'s HIGH and KOF alert emails about Google, one row a post (the DSD desk\'s story pool), every ~30 minutes, ' +
      'a median ~2.4 hours after posting' },
  { key: 'chat', lane: 'us', name: 'Other alerts space', cap: 30, firstMs: 60 * 60 * 1000, maxMs: 6 * PW_HOUR_MS_, staleMs: 0,
    where: 'The Alert log (the Other alerts space\'s alerts, Control B33)',
    what: 'The Brandwatch alerts (and other tools\' alerts) posted in the Other alerts space, as the bot reads them' },
  { key: 'bwq', lane: 'us', name: `Brandwatch: ${PW_BW_QUERY_NAME_}`, cap: 100, firstMs: 60 * 60 * 1000, maxMs: 6 * PW_HOUR_MS_,
    staleMs: 0, plainWhy: 'new',
    where: `Brandwatch's API: project ${PW_BW_PROJECT_}, query ${PW_BW_QUERY_} (with the shared token in Secret Manager)`,
    what: `The "${PW_BW_QUERY_NAME_}" query's mentions (news, Reddit, X, Bluesky, YouTube...) as Brandwatch adds them, ` +
      `usually minutes after posting, posted within ${PW_BW_HOURS_} hours; X posts' text comes from X's public embed data ` +
      '(Brandwatch\'s API leaves it out); an X post X won\'t show is counted as not sent' },
];

// --------------------------------------------------------------------------------------------------------------
// The AMIE table as a source of the Watch (Control row 50, key watchAmie; step 3b of the new sources, the plan's Q10).
// The owner asked on 16 Nov 2026 for this table to be read again (it was dropped on Nov 11 as not on the approved
// list). It is not in PW_SOURCES_: pwSources_ adds it, last, only while row 50 is ON, so with row 50 OFF every look,
// tab and mark is what it was.
// --------------------------------------------------------------------------------------------------------------

const PW_AMIE_PROP_ = 'PW_AMIE';            // the table's checks (EarlyWaveSource.gs ewsAmiMeta_'s record), while row 50 is ON
const PW_AMIE_KEYS_ = 'pw:amie:k';          // the keys (hashes) of the rows handed over in the last 24 hours (cache)
const PW_AMIE_KEYS_MAX_ = 5000;             // the newest this many at most: the cache item stays under 95,000 characters
const PW_AMIE_KEYS_MS_ = 24 * PW_HOUR_MS_;
const PW_AMIE_OVERLAP_MS_ = 40 * 60 * 1000;  // each look reads from this long before the newest row handed over
const PW_AMIE_SAMPLE_PCT_ = 5;              // the other feeds: about this share of what has no sign of trouble is checked anyway
// The feeds whose every row is checked (alert_source, lower case): brand safety and criticism, Google's executives,
// people and own posts, policy and elections, and Google's products. The rest (regional, sports, culture, competitors,
// general AI news) only with a sign something's wrong (Brandwatch negative, a KOF author, PW_AMIE_RISK_RX_)
const PW_AMIE_FULL_RX_ = 'slrr|sundar|spike|critic|ethic|safety|accuracy|replacement|sustainab|environment|policy|election|' +
  'execs|googlers|posts by google|ai digest - google|chrome overall|today in android|^search$|^gemini$|antigravity|g4d';
// Words that say something may be wrong (RE2, on the lower-cased text)
const PW_AMIE_RISK_RX_ = '\\b(lawsuits?|sued|suing|class action|antitrust|monopol\\w*|fined|fines|penalt\\w+|regulators?|' +
  'investigat\\w+|probes?|banned|bans|boycott\\w*|outages?|is down|went down|not working|glitch\\w*|scams?|scammers?|fraud\\w*|' +
  'phishing|malware|hack(ed|ers?)|breach\\w*|leak(s|ed)?|exploit\\w*|vulnerab\\w+|zero[- ]day|privacy|surveil\\w*|spying|' +
  'data harvest\\w*|misinformation|disinformation|deepfakes?|biased|bias|censor\\w*|shadowban\\w*|propaganda|election|ballots?|' +
  'voters?|racis\\w+|sexis\\w+|offensive|harass\\w*|unsafe|dangerous|harmful|layoffs?|walkout|protest\\w*|deforest\\w*|' +
  'pollut\\w+|emissions|hallucinat\\w+)\\b';
const PW_AMIE_SOURCE_ = { key: 'amie', lane: 'us', name: 'Brandwatch alert feeds (AMIE)', cap: 100, firstMs: 60 * 60 * 1000,
  maxMs: 6 * PW_HOUR_MS_, overlapMs: PW_AMIE_OVERLAP_MS_, staleMs: 2 * PW_HOUR_MS_, plainWhy: 'brand-safety query',
  bq: 'brand-social-central-data.social_alerts_dataset.all_sundar_mentions',
  what: 'Brandwatch\'s alert feeds (AMIE: X posts with their words too), most a day after posting: every row from the brand-safety ' +
    'and Google product feeds; from the other feeds (regional, sports, culture, competitors) those with a sign something is ' +
    `wrong (Brandwatch negative, a KOF author, risk words), plus a ${PW_AMIE_SAMPLE_PCT_}% sample of the rest; each row once, ` +
    '100 a look at most, read from 40 minutes before the newest row handed over so a row that lands late is caught' };

/** The Watch's sources this run, in the order of the Watch sources tab: PW_SOURCES_, and the AMIE table last while Control row 50 is ON. */
function pwSources_() {
  try {
    const sw = typeof ewsRunSwitches_ === 'function' ? ewsRunSwitches_() : {};
    return sw.watchAmie === true ? PW_SOURCES_.concat([PW_AMIE_SOURCE_]) : PW_SOURCES_;
  } catch (e) {
    return PW_SOURCES_;
  }
}

/** The AMIE table's check record (PW_AMIE: ewsAmiMeta_'s q), {} when none. Never throws. */
function pwAmieQ_(props) {
  try {
    const q = JSON.parse(props.getProperty(PW_AMIE_PROP_) || '{}');
    return q && typeof q === 'object' && !Array.isArray(q) ? q : {};
  } catch (e) {
    return {};
  }
}

/** Whether a look may read the AMIE table: row 50 ON, and its last check found it as the source needs it. Never throws. */
function pwAmieReadable_() {
  try {
    if (!pwSources_().some(s => s.key === 'amie')) return false;
    const q = pwAmieQ_(PropertiesService.getScriptProperties());
    return !q.prob && Number(q.mt) > 0;
  } catch (e) {
    return false;
  }
}

/**
 * The AMIE table's check before a look (row 50 ON): its metadata (step 1c's ewsAmiMeta_: the needed columns and their
 * types, the optional ones there, the day partitioning), at most hourly, and not again the same UTC day after a stop or
 * within an hour after a failure. A table the source can't read stops this source alone: its row on the Watch sources
 * tab says why, in the tab's words for an error. Never throws.
 */
function pwAmieCheck_(props, now) {
  try {
    const q = pwAmieQ_(props);
    if (q.sd === ewsUtcDay_(now) || Number(q.pu) > now) return;
    if (Number(q.mt) > 0 && now - Number(q.mt) < EWS_AMI_CHECK_MS_ && !q.prob) return;
    if (ewsAmiMeta_(q, now)) { delete q.prob; delete q.pu; delete q.sd; delete q.nd; }
    props.setProperty(PW_AMIE_PROP_, JSON.stringify(q));
    if (q.prob) {
      const all = pwSourceStats_(props);
      all.amie = Object.assign({}, all.amie || {}, { at: now, err: truncate_(String(q.prob.w || ''), PW_ERR_CHARS_) });
      props.setProperty(PW_SOURCES_PROP_, JSON.stringify(all));
    }
  } catch (e) { /* tried again at the next look */ }
}

/** The keys handed over in the last 24 hours ([{h: the hour, k: 'hash,hash,…'}], oldest first). Never throws. */
function pwAmieKeys_(now) {
  try {
    const raw = CacheService.getScriptCache().get(PW_AMIE_KEYS_);
    const list = raw ? JSON.parse(raw) : [];
    return (Array.isArray(list) ? list : []).filter(b => b && typeof b.k === 'string' && b.k && now - Number(b.h) < PW_AMIE_KEYS_MS_);
  } catch (e) {
    return [];
  }
}

/**
 * Adds the keys (12 hex characters each: pwAmieHashSql_) of the rows a look handed over to PW_AMIE_KEYS_, keeping the
 * last 24 hours and the newest PW_AMIE_KEYS_MAX_ at most, so the item never passes 95,000 characters. Each look writes it
 * again, so it lives on while the Watch looks (a cache item lives 6 hours at most). Never throws.
 */
function pwAmieKeysAdd_(hashes, now) {
  try {
    const add = (hashes || []).map(h => String(h || '').toLowerCase()).filter(h => /^[0-9a-f]{12}$/.test(h));
    const list = pwAmieKeys_(now);
    if (!add.length && !list.length) return;
    const hour = Math.floor(now / PW_HOUR_MS_) * PW_HOUR_MS_;
    let last = list[list.length - 1];
    if (add.length) {
      if (!last || Number(last.h) !== hour) { last = { h: hour, k: '' }; list.push(last); }
      last.k = last.k ? `${last.k},${add.join(',')}` : add.join(',');
    }
    let total = list.reduce((n, b) => n + b.k.split(',').length, 0);
    while (total > PW_AMIE_KEYS_MAX_ && list.length) {
      const ks = list[0].k.split(',');
      const drop = Math.min(ks.length, total - PW_AMIE_KEYS_MAX_);
      total -= drop;
      if (drop < ks.length) list[0].k = ks.slice(drop).join(','); else list.shift();
    }
    CacheService.getScriptCache().put(PW_AMIE_KEYS_, JSON.stringify(list), 21600);
  } catch (e) { /* a row read again is left out by its 24 hours' check (checked_before) */ }
}

/** What a look needs to read the AMIE table (pwSql_'s froms): {amie_opt, amie_seen}, or {} with row 50 OFF. Never throws. */
function pwAmieFroms_(props, now) {
  try {
    if (!pwSources_().some(s => s.key === 'amie')) return {};
    const q = pwAmieQ_(props);
    return { amie_opt: Array.isArray(q.opt) ? q.opt : [], amie_seen: [].concat(...pwAmieKeys_(now).map(b => b.k.split(','))) };
  } catch (e) {
    return {};
  }
}

/**
 * Row 50 OFF: the AMIE table's check, its keys, its mark and its row's numbers go, so ON again checks the table afresh
 * and reads from the last hour (its row on the Watch sources tab is cleared at the next write of the tab). Writes only
 * what is there. Never throws.
 */
function pwAmieOff_() {
  try {
    const props = PropertiesService.getScriptProperties();
    if (props.getProperty(PW_AMIE_PROP_)) props.deleteProperty(PW_AMIE_PROP_);
    try { if (CacheService.getScriptCache().get(PW_AMIE_KEYS_)) CacheService.getScriptCache().remove(PW_AMIE_KEYS_); } catch (e) { /* it expires */ }
    const marks = pwMarks_(props);
    if ('amie' in marks) { delete marks.amie; props.setProperty(PW_MARKS_PROP_, JSON.stringify(marks)); }
    const all = pwSourceStats_(props);
    if ('amie' in all) { delete all.amie; props.setProperty(PW_SOURCES_PROP_, JSON.stringify(all)); }
  } catch (e) { /* the next OFF run tries again */ }
}

/**
 * A post's key in SQL (Q8): an X post by its status id ("x:<id>", whatever the link: x.com or twitter.com, /status/ or
 * /statuses/, a handle or i), any other link lower-cased without its scheme, www., m. or mobile., a trailing slash or #.
 * Used only while row 50 is ON (with it OFF a look's SQL is what it was). Pure.
 */
function pwKeySql_(col) {
  const low = `LOWER(TRIM(IFNULL(${col}, '')))`;
  return `IF(REGEXP_CONTAINS(${low}, r'^(?:https?://)?(?:www\\.|m\\.|mobile\\.)?(?:x|twitter)\\.com/[^?#]*/status(?:es)?/[0-9]+'), ` +
    `CONCAT('x:', REGEXP_EXTRACT(${low}, r'/status(?:es)?/([0-9]+)')), ` +
    `REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(${low}, r'^https?://(?:www\\.|m\\.|mobile\\.)?', ''), r'^twitter\\.com/', 'x.com/'), r'#.*$|/+$', ''))`;
}

/** A key's hash as PW_AMIE_KEYS_ keeps it (12 hex characters of its SHA-256), in SQL. Pure. */
function pwAmieHashSql_(keyExpr) { return `SUBSTR(TO_HEX(SHA256(${keyExpr})), 1, 12)`; }

const PW_CHAT_FIELDS_ = [['u', 'STRING'], ['n', 'STRING'], ['a', 'STRING'], ['f', 'INT64'], ['e', 'INT64'], ['p', 'INT64'],
  ['s', 'INT64'], ['i', 'STRING'], ['m', 'STRING'], ['t', 'STRING']];
const PW_NEW_COLS_ = 'source, rk, post_url, platform, author, followers, eng, posted, first_seen, issue, issue_new, summary, txt';

// --------------------------------------------------------------------------------------------------------------
// The Watches tab: what to look for. People edit it; the bot writes only the Status column of a watch's row.
// --------------------------------------------------------------------------------------------------------------

const PW_WATCHES_TAB_ = 'Watches';
const PW_WATCHES_HEADER_ = ['Watch', 'On', 'What to look for (a yes/no question for Gemini)', 'How to score impact (1-10)',
  'Topics (comma-separated)', 'Flag at score', 'Networks (blank: all)', 'Status (written by the bot)'];
const PW_STATUS_COL_ = 8;
const PW_DEFAULT_RUBRIC_ = 'Score from 1 to 10 how likely this post is to become a brand-safety issue for Google in the ' +
  'next 6 hours: 10 = journalists, officials, campaigns or very large accounts are about to amplify it; 7 = a credible, ' +
  'serious claim with growing reach; 4 = a niche complaint; 1 = harmless or not really about Google. Weigh the author\'s ' +
  'reach, how serious and credible the claim is, and whether it is a new issue.';
const PW_DEFAULT_TOPICS_ = ['AI answers and Gemini', 'Privacy and security', 'Scams and fraud', 'Product failure or outage',
  'Legal and regulation', 'Bias or censorship claims', 'Executives and workplace', 'Elections and civics'];
// The two watches the tab starts with, both OFF: only a person turns a watch ON
const PW_WATCH_SEEDS_ = [
  ['Midterms 2026 × Google', 'OFF',
    'Does this post connect Google or its products, services or executives (Search, AI Overviews, Gemini, YouTube, ' +
    'Android, Chrome, Maps, Waymo, Google ads, Sundar Pichai) to the 2026 US midterm elections, voting, candidates or ' +
    'election officials, for example election information or results Google shows, political ads, claims of bias, ' +
    'censorship or election interference, election misinformation spreading on Google\'s platforms, or election-day ' +
    'failures, in a way that could hurt Google\'s reputation or call for a response? Answer no for posts about the ' +
    'elections that don\'t involve Google.',
    'Score from 1 to 10 how likely this post is to become a brand-safety issue for Google about the 2026 midterms in the ' +
    'next 6 hours: 10 = officials, journalists, campaigns or very large accounts are about to amplify it, or it alleges ' +
    'Google interfered with the election; 7 = a credible claim with growing reach; 4 = a niche complaint; 1 = harmless ' +
    'or not really about Google. Weigh the author\'s reach, how serious and credible the claim is, and whether it is a ' +
    'new issue.',
    'Election info and results, Political ads, Bias or censorship claims, Election misinformation, Candidates and ' +
    'officials, Voting-day failures', PW_DEFAULT_BAR_, '', ''],
  ['Google brand safety (all)', 'OFF',
    'Does this post involve Google or its products, services or executives in a way that could hurt Google\'s ' +
    'reputation or call for a communications response, for example a serious product failure, a dangerous or offensive ' +
    'AI answer, a privacy or security claim, a scam using Google\'s name, a legal or regulatory issue, a boycott or a ' +
    'claim of bias? Answer no for jokes, ordinary praise, tips, how-to posts and passing mentions.',
    PW_DEFAULT_RUBRIC_, PW_DEFAULT_TOPICS_.join(', '), PW_DEFAULT_BAR_, '', ''],
];

// --------------------------------------------------------------------------------------------------------------
// The Watch detections tab: what the watches flagged, and the scorecard at its top. The bot's; people rate the rows.
// --------------------------------------------------------------------------------------------------------------

const PW_DET_TAB_ = 'Watch detections';
const PW_DET_TITLE_ = 'Proactive watch: what the watches flagged (posted only where Watch alerts, Control row 35, says)';
// The tab's earlier titles (before Nov 11, and Nov 10-11): still the bot's own tab, its title brought up to date on its
// next look
const PW_DET_OLD_TITLES_ = ['Proactive watch: what the bot would have flagged',
  'Watch detections: what the watches and the classification flagged'];
const PW_DET_NOTE_ = 'Scorecard (updated every 10 minutes): Burson\'s alerts are the posts in the Alert log that reached ' +
  'S-F Burson that day; caught means a watch flagged the same post at its bar; lead is how much sooner the watch flagged ' +
  'it than Burson\'s alert reached S-F Burson. Rate the rows below (Useful or Noise) to tune the watches.';
const PW_SCORE_HEAD_ROW_ = 3;                // the scorecard's header; its days below, then the total
const PW_SCORE_HEADER_ = ['Day (ET)', 'Burson\'s alerts', 'Caught by a watch', 'Caught first', 'Median lead (min)',
  'Flagged', 'Near misses', 'Rated useful', 'Rated noise'];
const PW_DET_HEAD_ROW_ = 13;                 // the detections' header (rows 4-11: the scorecard; row 12 blank)
const PW_DET_HEADER_ = ['Seen (ET)', 'Watch', 'Score', 'At the bar', 'Topic', 'Post', 'Source', 'Network', 'Author',
  'Followers', 'Engagements', 'Posted (ET)', 'Issue or query', 'New issue', 'Summary', 'Burson alerted (ET)',
  'Lead over Burson (min)', 'Rating', 'Key'];
const PW_COL_ = { seen: 1, watch: 2, score: 3, bar: 4, topic: 5, post: 6, source: 7, network: 8, author: 9, followers: 10,
  eng: 11, posted: 12, issue: 13, isNew: 14, summary: 15, bursonAt: 16, lead: 17, rating: 18, key: 19 };
const PW_RATINGS_ = ['Useful', 'Noise'];

// --------------------------------------------------------------------------------------------------------------
// The Watch sources tab: one row a source, whether it's live or stale. The bot's.
// --------------------------------------------------------------------------------------------------------------

const PW_SRC_TAB_ = 'Watch sources';
const PW_SRC_TITLE_ = 'Proactive watch: where it looks (read-only, only what is new since the last look; written by the bot)';
const PW_SRC_NOTE_ = 'Stale: the source\'s table hasn\'t changed for longer than it usually goes; its rows count again as soon ' +
  'as it has new ones. Checked: what Gemini was asked about (each source\'s most-followed or most-engaged first).';
const PW_SRC_HEAD_ROW_ = 3;
const PW_SRC_HEADER_ = ['Source', 'What it adds', 'Where it reads (BigQuery, read-only)', 'Status', 'Table last changed (ET)',
  'Newest item seen (ET)', 'Last look: new / checked', 'Today: checked', 'Today: flagged', 'Last look (ET)'];

/** A cell the bot writes from text it didn't write itself: one line, capped, never read as a formula. Pure. */
function pwCell_(s, max) {
  const v = truncate_(String(s === undefined || s === null ? '' : s).replace(/\s+/g, ' ').trim(), max || 500);
  return /^[=+\-@]/.test(v) ? '\'' + v : v;
}

/** A time (ms) as the tabs show it, in ET ("2026-10-31 00:55"); '' for none. */
function pwTime_(ms) {
  const n = Number(ms);
  return n > 0 ? Utilities.formatDate(new Date(n), GEN.timezone || 'America/New_York', 'yyyy-MM-dd HH:mm') : '';
}

/** The day (ET) a time (ms) falls on ("2026-10-31"). */
function pwDay_(ms) { return Utilities.formatDate(new Date(Number(ms)), GEN.timezone || 'America/New_York', 'yyyy-MM-dd'); }

/** A time or day the bot writes, as text (a leading apostrophe): Sheets would make it a date otherwise. Pure. */
function pwText_(s) { return s ? '\'' + s : ''; }

/** A cell as the bot would write it (`want`) and as the sheet hands it back (`have`): the same? Pure. */
function pwSame_(want, have) {
  return String(want === undefined || want === null ? '' : want).replace(/^'/, '') ===
    String(have === undefined || have === null ? '' : have);
}

/** Sonar's platform name for a network a person typed ("X" -> twitter); '' for none. Pure. */
function pwPlatform_(s) {
  const v = String(s || '').trim().toLowerCase().replace(/[^a-z]/g, '');
  const map = { x: 'twitter', twitter: 'twitter', xtwitter: 'twitter', twitterx: 'twitter', ig: 'instagram', insta: 'instagram',
    instagram: 'instagram', tiktok: 'tiktok', yt: 'youtube', youtube: 'youtube', reddit: 'reddit', bsky: 'bluesky',
    bluesky: 'bluesky', fb: 'facebook', facebook: 'facebook', threads: 'threads', linkedin: 'linkedin' };
  return map[v] || v;
}

/** A network as people write it, from Sonar's platform and the post's link ("X", "Instagram"). */
function pwNetwork_(platform, url) {
  const names = { twitter: 'X', instagram: 'Instagram', tiktok: 'TikTok', youtube: 'YouTube', reddit: 'Reddit',
    bluesky: 'Bluesky', facebook: 'Facebook', threads: 'Threads', linkedin: 'LinkedIn' };
  let byLink = null;
  try { byLink = linkNetwork_({ url, network: '' }); } catch (e) { byLink = null; }
  return byLink || names[String(platform || '').toLowerCase()] || String(platform || '');
}

/** A topic AI.CLASSIFY may choose: one line, no quotes or backslashes (it goes in the query as written), capped. Pure. */
function pwTopic_(s) { return String(s || '').replace(/['"`\\\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60); }

/** A source by its key (PW_SOURCES_), or null. Pure. */
function pwSource_(key) { return pwSources_().find(s => s.key === key) || null; }

/** A lane by its key (PW_LANES_), or null. Pure. */
function pwLane_(key) { return PW_LANES_.find(l => l.key === key) || null; }

/** A lane's sources, in the tab's order (the AMIE table only while its check lets it be read: pwAmieReadable_). */
function pwLaneSources_(laneKey) { return pwSources_().filter(s => s.lane === laneKey && (s.key !== 'amie' || pwAmieReadable_())); }

/** A lane's sources by name ("Sonar and Tubular"), for the notes. Pure. */
function pwLaneNames_(laneKey) {
  const n = pwLaneSources_(laneKey).map(s => s.name);
  return n.length > 1 ? `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}` : (n[0] || '');
}

/** A lane's sources in few words, for a note with 200 characters ("Sonar and Tubular"; "Brandwatch mentions and 5 more"). Pure. */
function pwLaneShort_(laneKey) {
  const n = pwLaneSources_(laneKey).map(s => s.name);
  return n.length > 2 ? `${n[0]} and ${n.length - 1} more` : pwLaneNames_(laneKey);
}

/**
 * The start of what C34 and the Watch sources tab say while a look fails as a whole (`laneKeys`: the failing lanes):
 * "the look at Sonar and Tubular has failed since"; with every lane failing, "the looks at all 8 sources have failed
 * since". When and why follow it. Pure.
 */
function pwFailWords_(laneKeys) {
  return laneKeys.length >= PW_LANES_.length ? `the looks at all ${pwSources_().length} sources have failed since`
    : `the look at ${laneKeys.map(pwLaneShort_).join(' and ')} has failed since`;
}

/** A time (ms) as a note writes it ("Oct 14, 8:04 AM"; with `zone`, "Oct 14, 8:04 AM EDT", as Main.gs nowLabel_). */
function pwWhen_(ms, zone) {
  return Utilities.formatDate(new Date(Number(ms)), GEN.timezone || 'America/New_York', `MMM d, h:mm a${zone ? ' z' : ''}`);
}

/**
 * Why a look failed as a whole, in plain words for C34 and the Watch sources tab (`what`: the error's own text, which
 * only the run log keeps): "BigQuery refused access (a permission is missing)", "BigQuery could
 * not find a table the look reads", "BigQuery reached a quota or rate limit", "BigQuery had a problem of its own",
 * "BigQuery refused the look's query", "BigQuery could not be reached", "the shared Brandwatch key could not be read"
 * or "... is empty"; the bot's own words ("BigQuery took more than 4 minutes", "BigQuery gave no job to collect") as
 * they are; anything else "an unexpected error (the run log has its words)". Pure.
 */
function pwPlainWhy_(what) {
  const s = String(what === null || what === undefined ? '' : what).replace(/\s+/g, ' ').trim();
  if (/^BigQuery took more than \d+ minutes?$/.test(s) || s === 'BigQuery gave no job to collect') return s;
  if (/^Secret Manager HTTP /.test(s)) return 'the shared Brandwatch key could not be read';
  if (/Brandwatch token in Secret Manager is empty/.test(s)) return 'the shared Brandwatch key is empty';
  const http = s.match(/^BigQuery HTTP (\d{3})(?::|$)/);
  if (http) {
    const code = Number(http[1]);
    if (code === 401 || code === 403 || /access denied|permission|forbidden/i.test(s)) {
      return 'BigQuery refused access (a permission is missing)';
    }
    if (code === 404 || /not found/i.test(s)) return 'BigQuery could not find a table the look reads';
    if (code === 429 || /quota|rate limit|exceeded|too many/i.test(s)) return 'BigQuery reached a quota or rate limit';
    if (code >= 500) return 'BigQuery had a problem of its own';
    return 'BigQuery refused the look\'s query';
  }
  if (/timed? ?out|address unavailable|dns|connection|unreachable/i.test(s)) return 'BigQuery could not be reached';
  return 'an unexpected error (the run log has its words)';
}

/**
 * A watch from its row on the Watches tab ([Watch, On, question, rubric, topics, bar, networks, status]; `row` its row
 * number): {row, name, on, cond, rubric, topics, bar, nets, problem ('' when it can be watched)}; null for a row with no
 * name. A blank rubric or topics take the defaults; a bar outside 1-10 or unreadable is PW_DEFAULT_BAR_. Pure.
 */
function pwWatchFrom_(r, row) {
  const cell = i => String(r[i] === undefined || r[i] === null ? '' : r[i]).trim();
  const name = truncate_(cell(0).replace(/\s+/g, ' '), 80);
  if (!name) return null;
  const on = r[1] === true || cell(1).toUpperCase() === 'ON';
  const cond = truncate_(cell(2), PW_PROMPT_CHARS_);
  const rubric = truncate_(cell(3), PW_PROMPT_CHARS_) || PW_DEFAULT_RUBRIC_;
  const seen = new Set();
  const topics = (cell(4) ? cell(4).split(/[,;\n]+/) : PW_DEFAULT_TOPICS_).map(pwTopic_)
    .filter(t => t && t.toLowerCase() !== 'other' && !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase())).slice(0, 12);
  const n = Number(cell(5));
  const bar = cell(5) !== '' && isFinite(n) && n >= 1 && n <= 10 ? Math.round(n * 10) / 10 : PW_DEFAULT_BAR_;
  const nets = cell(6) ? Array.from(new Set(cell(6).split(/[,;\n]+/).map(pwPlatform_).filter(Boolean))) : [];
  const problem = !cond ? 'its question (column C) is empty' : '';
  return { row, name, on, cond, rubric, topics, bar, nets, problem };
}

/** The watches on the Watches tab, in its order (rows without a name left out). */
function pwWatches_(sh) {
  const last = Math.min(sh.getLastRow(), 1 + PW_WATCHES_MAX_ROWS_);
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, PW_WATCHES_HEADER_.length).getValues()
    .map((r, i) => pwWatchFrom_(r, i + 2)).filter(Boolean);
}

/** The watches a look asks about: ON, usable, the first PW_MAX_WATCHES_ of them, each name once. Pure. */
function pwActive_(watches) {
  const names = new Set();
  return (watches || []).filter(w => w.on && !w.problem && !names.has(w.name) && names.add(w.name)).slice(0, PW_MAX_WATCHES_);
}

/** The bot's own Watches tab: its first three header cells are the bot's (a tab people made never has them). */
function isPwWatchesTab_(sh) {
  if (!sh || sh.getLastRow() < 1 || sh.getLastColumn() < 3) return false;
  const h = sh.getRange(1, 1, 1, 3).getValues()[0].map(v => String(v).trim());
  return h[0] === PW_WATCHES_HEADER_[0] && h[1] === PW_WATCHES_HEADER_[1] && h[2] === PW_WATCHES_HEADER_[2];
}

/** The bot's own Watch detections tab: its A1 is the title the bot writes there (or one of its earlier titles). */
function isPwDetectionsTab_(sh) {
  try {
    const a1 = String(sh.getRange(1, 1).getDisplayValue()).trim();
    return a1 === PW_DET_TITLE_ || PW_DET_OLD_TITLES_.some(t => a1.startsWith(t));
  } catch (e) { return false; }
}

/** The bot's own Watch sources tab: its A1 is the title the bot writes there. */
function isPwSourcesTab_(sh) {
  try { return String(sh.getRange(1, 1).getDisplayValue()).trim() === PW_SRC_TITLE_; } catch (e) { return false; }
}

/**
 * The Watches tab ({sh, foreign}): made, with its two watches OFF, when missing and `create`; foreign (sh null) when a
 * tab with its name exists that the bot didn't make: that tab is never read or written.
 */
function pwWatchesTab_(ss, create) {
  let sh = ss.getSheetByName(PW_WATCHES_TAB_);
  if (sh) return isPwWatchesTab_(sh) ? { sh, foreign: false } : { sh: null, foreign: true };
  if (!create) return { sh: null, foreign: false };
  sh = ss.insertSheet(PW_WATCHES_TAB_);
  const rows = [PW_WATCHES_HEADER_].concat(PW_WATCH_SEEDS_);
  sh.getRange(1, 1, rows.length, PW_WATCHES_HEADER_.length).setValues(rows);
  try {
    sh.getRange(1, 1, 1, PW_WATCHES_HEADER_.length).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.getRange(2, 2, PW_WATCHES_MAX_ROWS_, 1)
      .setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['ON', 'OFF'], true).build());
    sh.getRange(2, 1, PW_WATCHES_MAX_ROWS_, PW_WATCHES_HEADER_.length).setWrap(true).setVerticalAlignment('top');
    [200, 60, 420, 360, 260, 80, 140, 320].forEach((w, i) => sh.setColumnWidth(i + 1, w));
  } catch (e) { /* the tab works unformatted */ }
  return { sh, foreign: false };
}

/**
 * The Watch detections tab ({sh, foreign}), after the Watches tab: made when missing and `create`, its title in A1 at
 * once (the bot's mark), the scorecard's header and the detections' header, protected with a warning but for the
 * Rating column; foreign (sh null) when a tab with its name exists that the bot didn't make.
 */
function pwDetectionsTab_(ss, create) {
  let sh = ss.getSheetByName(PW_DET_TAB_);
  if (sh) {
    if (!isPwDetectionsTab_(sh)) return { sh: null, foreign: true };
    // under an earlier title: the bot's own tab still, its title brought up to date (only by a look, which writes)
    if (create && String(sh.getRange(1, 1).getDisplayValue()).trim() !== PW_DET_TITLE_) {
      sh.getRange(1, 1).setValue(PW_DET_TITLE_);
    }
    return { sh, foreign: false };
  }
  if (!create) return { sh: null, foreign: false };
  const watches = ss.getSheetByName(PW_WATCHES_TAB_);
  const sheets = ss.getSheets();
  sh = ss.insertSheet(PW_DET_TAB_, watches ? sheets.indexOf(watches) + 1 : sheets.length);
  sh.getRange(1, 1).setValue(PW_DET_TITLE_);
  sh.getRange(2, 1).setValue(PW_DET_NOTE_);
  sh.getRange(PW_SCORE_HEAD_ROW_, 1, 1, PW_SCORE_HEADER_.length).setValues([PW_SCORE_HEADER_]);
  sh.getRange(PW_DET_HEAD_ROW_, 1, 1, PW_DET_HEADER_.length).setValues([PW_DET_HEADER_]);
  try {
    sh.getRange(1, 1).setFontWeight('bold').setFontSize(12);
    sh.getRange(PW_SCORE_HEAD_ROW_, 1, 1, PW_SCORE_HEADER_.length).setFontWeight('bold');
    sh.getRange(PW_DET_HEAD_ROW_, 1, 1, PW_DET_HEADER_.length).setFontWeight('bold');
    sh.hideColumns(PW_COL_.key);
    [130, 170, 60, 80, 170, 300, 140, 90, 150, 90, 100, 130, 220, 80, 420, 130, 120, 90]
      .forEach((w, i) => sh.setColumnWidth(i + 1, w));
  } catch (e) { /* the tab works unformatted */ }
  try {
    sh.protect().setDescription('Written by the Burson QA bot (the Rating column is yours to fill in)').setWarningOnly(true)
      .setUnprotectedRanges([sh.getRange(PW_DET_HEAD_ROW_ + 1, PW_COL_.rating, PW_DET_MAX_ROWS_ + PW_DET_TRIM_SLACK_ + 200, 1)]);
  } catch (e) { /* the tab works unprotected */ }
  return { sh, foreign: false };
}

/**
 * The Watch sources tab ({sh, foreign}), after the Watch detections tab: made when missing and `create` (its title in
 * A1, the bot's mark, its note, header and one row a source), protected with a warning; foreign (sh null) when a tab
 * with its name exists that the bot didn't make: that tab is left alone, and the watch carries on without it.
 */
function pwSourcesTab_(ss, create) {
  let sh = ss.getSheetByName(PW_SRC_TAB_);
  if (sh) return isPwSourcesTab_(sh) ? { sh, foreign: false } : { sh: null, foreign: true };
  if (!create) return { sh: null, foreign: false };
  const det = ss.getSheetByName(PW_DET_TAB_);
  const sheets = ss.getSheets();
  sh = ss.insertSheet(PW_SRC_TAB_, det ? sheets.indexOf(det) + 1 : sheets.length);
  sh.getRange(1, 1).setValue(PW_SRC_TITLE_);
  sh.getRange(2, 1).setValue(PW_SRC_NOTE_);
  sh.getRange(PW_SRC_HEAD_ROW_, 1, 1, PW_SRC_HEADER_.length).setValues([PW_SRC_HEADER_]);
  const list = pwSources_();
  sh.getRange(PW_SRC_HEAD_ROW_ + 1, 1, list.length, 3)
    .setValues(list.map(s => [s.name, s.what, s.bq || s.where || '']));
  try {
    sh.getRange(1, 1).setFontWeight('bold').setFontSize(12);
    sh.getRange(PW_SRC_HEAD_ROW_, 1, 1, PW_SRC_HEADER_.length).setFontWeight('bold');
    sh.setFrozenRows(PW_SRC_HEAD_ROW_);
    sh.getRange(PW_SRC_HEAD_ROW_ + 1, 1, list.length, PW_SRC_HEADER_.length).setWrap(true).setVerticalAlignment('top');
    [150, 360, 300, 300, 130, 130, 120, 90, 90, 130].forEach((w, i) => sh.setColumnWidth(i + 1, w));
  } catch (e) { /* the tab works unformatted */ }
  try { sh.protect().setDescription('Written by the Burson QA bot').setWarningOnly(true); } catch (e) { /* unprotected */ }
  return { sh, foreign: false };
}

// --------------------------------------------------------------------------------------------------------------
// The look: two BigQuery jobs (one a location), each a temporary table of what's new in its sources, then Gemini
// --------------------------------------------------------------------------------------------------------------

/** A source's SQL in a block of its own: an error is noted on its row (pw_src) and the next source carries on. Pure. */
function pwGuard_(key, lines) {
  return ['BEGIN'].concat(lines, ['EXCEPTION WHEN ERROR THEN',
    `  INSERT INTO pw_src (source, err) VALUES ('${key}', SUBSTR(@@error.message, 1, ${PW_ERR_CHARS_}));`, 'END;']);
}

/** Sonar's platform name, in SQL, from a network a source writes its own way ("X" -> twitter). Pure. */
function pwNetSql_(expr) {
  const v = `REGEXP_REPLACE(LOWER(IFNULL(${expr}, '')), r'[^a-z]', '')`;
  return `CASE ${v} WHEN 'x' THEN 'twitter' WHEN 'xtwitter' THEN 'twitter' WHEN 'twitterx' THEN 'twitter' ` +
    `WHEN 'ig' THEN 'instagram' WHEN 'fb' THEN 'facebook' WHEN 'yt' THEN 'youtube' ` +
    `WHEN 'facebookpublic' THEN 'facebook' WHEN 'instagrampublic' THEN 'instagram' ELSE ${v} END`;
}

/** The network in `expr` (pwNetSql_) is one of `nets` (default: the team's list, PW_NETWORKS_), in SQL. Pure. */
function pwNetsInSql_(expr, nets) {
  return `${pwNetSql_(expr)} IN (${(nets || PW_NETWORKS_).map(n => `'${n}'`).join(', ')})`;
}

/** A source's table, quoted for the query. Pure. */
function pwTable_(key) { return '`' + pwSource_(key).bq + '`'; }

/** Each source's rows as pw_new's columns (source, rk, post_url, ..., txt), by key. Pure. */
const PW_SOURCE_SQL_ = {
  // The AMIE table's rows (row 50 ON; restored from ace865c^'s BMIE source with the plan's changes): ingested since 40
  // minutes before the newest row handed over (@amie_from), so a row that lands late is caught, and none whose key was
  // handed over in the last 24 hours (@amie_seen: pw:amie:k), so none goes twice; one row a post by its key (an X post by
  // its status id), its link kept as it came; not all positive, the reach floor, posted within 72 hours, none already
  // checked in the 24 hours before (another feed's copy), each with why: every one from a brand-safety or Google product
  // feed (PW_AMIE_FULL_RX_: 'brand-safety query'); from the other feeds only those with a sign something's wrong
  // ('negative', a 'KOF author', 'risk words': PW_AMIE_RISK_RX_) and a PW_AMIE_SAMPLE_PCT_% 'sample' of the rest (by the
  // post's key, the same post every time); the others 'skipped' (counted, never asked about). An optional column the
  // table's check didn't find (froms.amie_opt: followers, KOF, product, engagement) is NULL. English only.
  amie: f => {
    const opt = new Set(((f && f.amie_opt) || []).map(String));
    const col = (name, type) => (opt.has(name) ? `SAFE_CAST(${name} AS ${type})` : `CAST(NULL AS ${type})`);
    const from = 'TIMESTAMP_MILLIS(@amie_from)';
    const sample = `ABS(MOD(FARM_FINGERPRINT(k), 100)) < ${PW_AMIE_SAMPLE_PCT_}`;  // MOD first: ABS of the smallest INT64 overflows
    return [
      `INSERT INTO pw_new (${PW_NEW_COLS_}, why, tax)`,
      "SELECT 'amie', ROW_NUMBER() OVER (ORDER BY CASE why WHEN 'brand-safety query' THEN 0 WHEN 'sample' THEN 2 WHEN 'skipped' THEN 9",
      '    ELSE 1 END, IFNULL(followers, 0) DESC),',
      '  url, ' + pwNetSql_('net') + ', author, followers, eng, posted, first_seen,',
      "  CONCAT('Brandwatch: ', IFNULL(q, '')), CAST(NULL AS BOOL), SUBSTR(snippet, 1, 400),",
      "  SUBSTR(CONCAT('Post text: ', IFNULL(snippet, ''), IF(IFNULL(kof, '') = '', '', CONCAT('\\nKOF: ', kof)),",
      `    IF(IFNULL(product, '') = '', '', CONCAT('\\nProduct: ', product))), 1, ${PW_TEXT_CHARS_}), why,`,
      "  TO_JSON_STRING(JSON_OBJECT('p', product, 'kv', kof)) AS tax",
      'FROM (',
      "  SELECT m.*, CASE WHEN full_q THEN 'brand-safety query' WHEN neg THEN 'negative' WHEN kof_author THEN 'KOF author'",
      `      WHEN risk THEN 'risk words' WHEN ${sample} THEN 'sample' ELSE 'skipped' END AS why`,
      '  FROM (',
      '    SELECT k, ANY_VALUE(IF(cur, url, NULL)) AS url, MIN(IF(cur, t, NULL)) AS first_seen, ANY_VALUE(IF(cur, snippet, NULL)) AS snippet,',
      '      MAX(IF(cur, followers, NULL)) AS followers, ANY_VALUE(IF(cur, authorHandle, NULL)) AS author,',
      '      ANY_VALUE(IF(cur, SocialNetwork, NULL)) AS net, MAX(IF(cur, eng, NULL)) AS eng,',
      "      STRING_AGG(DISTINCT IF(cur, alert_source, NULL), ', ' LIMIT 3) AS q, MIN(IF(cur, postTime, NULL)) AS posted,",
      '      ANY_VALUE(IF(cur, kof, NULL)) AS kof, ANY_VALUE(IF(cur, product, NULL)) AS product,',
      '      LOGICAL_AND(IF(cur, positive, TRUE)) AS positive, LOGICAL_OR(cur AND full_q) AS full_q, LOGICAL_OR(cur AND neg) AS neg,',
      '      LOGICAL_OR(cur AND kof_author) AS kof_author, LOGICAL_OR(cur AND risk) AS risk,',
      `      LOGICAL_OR(NOT cur AND NOT positive AND IFNULL(followers, 0) >= ${PW_MIN_FOLLOWERS_}`,
      `        AND (full_q OR neg OR kof_author OR risk OR ${sample})) AS checked_before`,
      '    FROM (',
      `      SELECT ${pwKeySql_('url')} AS k, url, alert_source, snippet, authorHandle, SocialNetwork, postTime,`,
      `        ${col('followers', 'INT64')} AS followers, ${col('engagement', 'INT64')} AS eng,`,
      `        ${col('KOF', 'STRING')} AS kof, ${col('product', 'STRING')} AS product,`,
      `        ingestionTimestamp AS t, ingestionTimestamp > ${from} AS cur,`,
      "        LOWER(IFNULL(Sentiment, '')) = 'positive' AS positive, LOWER(IFNULL(Sentiment, '')) = 'negative' AS neg,",
      `        REGEXP_CONTAINS(LOWER(IFNULL(alert_source, '')), r'${PW_AMIE_FULL_RX_}') AS full_q,`,
      `        STARTS_WITH(IFNULL(${col('KOF', 'STRING')}, ''), 'Yes') AS kof_author,`,
      `        REGEXP_CONTAINS(LOWER(IFNULL(snippet, '')), r'${PW_AMIE_RISK_RX_}') AS risk`,
      `      FROM ${pwTable_('amie')}`,
      `      WHERE ingestionTimestamp > TIMESTAMP_SUB(${from}, INTERVAL ${PW_NEW_HOURS_} HOUR)`,
      '        AND ingestionTimestamp <= TIMESTAMP_MILLIS(@until_ms) AND url IS NOT NULL',
      "        AND NOT REGEXP_CONTAINS(LOWER(IFNULL(alert_source, '')), r'positive')",
      `        AND NOT ${nonEnglishScriptSql_('IFNULL(snippet, \'\')')}`,
      '    )',
      '    GROUP BY k',
      '    HAVING LOGICAL_OR(cur) AND NOT checked_before',
      '  ) m',
      `  WHERE NOT positive AND IFNULL(followers, 0) >= ${PW_MIN_FOLLOWERS_}`,
      '    AND (posted IS NULL OR posted >= TIMESTAMP_SUB(TIMESTAMP_MILLIS(@until_ms), INTERVAL 72 HOUR))',
      `    AND ${pwAmieHashSql_('k')} NOT IN UNNEST(SPLIT(@amie_seen, ','))`,
      ');',
    ];
  },
  // Pendulum's posts worth a look since the last one, each with why: 'new' (first seen in the window, none seen in the
  // 24 hours before, posted within 24 hours), 'grew' (seen in the 24 hours before but below the floor or without a risk
  // tag then: it went unnoticed and has grown since) or 'broke out' (above the floor before, already checked, and its
  // engagements have since gone up PW_BREAKOUT_X_ times to PW_BREAKOUT_MIN_+); always a risk smart tag and the reach
  // floor; 'grew' and 'broke out' posted within PW_GROWTH_HOURS_. Broke out first, then the biggest accounts
  sonar: () => {
    const since = 'TIMESTAMP_MILLIS(@since_ms)';
    const until = 'TIMESTAMP_MILLIS(@until_ms)';
    const tag = 'LOWER(IFNULL(smart_tag, ""))';
    const risk = `NOT (REGEXP_CONTAINS(${tag}, r"${BQ_BSIP_POSITIVE_TAG_RX_}") OR ${tag} IN ('functional use case', ''))`;
    const eng = 'IFNULL(engagement_likes, 0) + IFNULL(engagement_comments, 0) + IFNULL(engagement_shares, 0)';
    const json = path => `JSON_VALUE(payload, '${path}')`;
    const cls = field => `JSON_QUERY(payload, '$.detail.classification.${field}')`;
    return [
      `INSERT INTO pw_new (${PW_NEW_COLS_}, why, tax)`,
      'WITH win AS (',
      '  SELECT post_url,',
      '    MIN(received_at) AS first_seen,',
      '    ANY_VALUE(LOWER(IFNULL(platform, \'\'))) AS platform,',
      '    SAFE_CAST(MAX(IFNULL(follower_count, 0)) AS INT64) AS followers,',
      `    SAFE_CAST(MAX(${eng}) AS INT64) AS eng,`,
      '    MIN(SAFE.PARSE_TIMESTAMP(\'%Y-%m-%dT%H:%M:%S\', SUBSTR(post_timestamp, 1, 19))) AS posted,',
      `    LOGICAL_OR(${risk}) AS risk_tag,`,
      `    ANY_VALUE(${json('$.detail.channel.username')}) AS author,`,
      `    ANY_VALUE(${json('$.detail.classification.issue_name')}) AS issue,`,
      `    LOGICAL_OR(${json('$.detail.classification.is_issue_new')} = 'true') AS issue_new,`,
      `    ANY_VALUE(${json('$.detail.classification.summary')}) AS summary,`,
      `    STRING_AGG(DISTINCT SUBSTR(${json('$.detail.post.snippet.text')}, 1, 500), ' | ' LIMIT 3) AS snippets,`,
      // Pendulum's own classification of the post, newest first: its products, smart tag, Sensitive Topics and the
      // influencer (KOF) lists its author is on, for the watch alert's card (WatchAlerts.gs pwTaxOf_)
      `    ARRAY_AGG(TO_JSON_STRING(JSON_OBJECT('p', ${cls('brand_classification_names')}, 't', ${json('$.detail.classification.smart_tag_name')},`,
      `      's', ${cls('secondary_tag_names')}, 'k', ${cls('influencer_list_names')})) ORDER BY received_at DESC LIMIT 1)[SAFE_OFFSET(0)] AS tax`,
      `  FROM ${PW_SONAR_RAW_}`,
      `  WHERE received_at > ${since} AND received_at <= ${until} AND post_url IS NOT NULL`,
      `    AND ${englishLangSql_(json('$.detail.post.language'))}`,
      `    AND NOT ${nonEnglishScriptSql_(`IFNULL(${json('$.detail.post.snippet.text')}, '')`)}`,
      '  GROUP BY post_url',
      '),',
      'prior AS (',
      '  SELECT post_url,',
      `    LOGICAL_OR(${risk} AND (IFNULL(follower_count, 0) >= ${PW_MIN_FOLLOWERS_} OR ${eng} >= ${PW_MIN_ENGAGEMENT_})) AS was_eligible,`,
      `    SAFE_CAST(MAX(${eng}) AS INT64) AS eng_before`,
      `  FROM ${PW_SONAR_RAW_}`,
      `  WHERE received_at > TIMESTAMP_SUB(${since}, INTERVAL ${PW_NEW_HOURS_} HOUR) AND received_at <= ${since} AND post_url IS NOT NULL`,
      '  GROUP BY post_url',
      '),',
      'cand AS (',
      '  SELECT w.*, p.eng_before, CASE',
      '      WHEN p.post_url IS NULL THEN \'new\'',
      '      WHEN NOT p.was_eligible THEN \'grew\'',
      `      WHEN w.eng >= ${PW_BREAKOUT_MIN_} AND w.eng >= ${PW_BREAKOUT_X_} * GREATEST(IFNULL(p.eng_before, 0), 1) THEN 'broke out'`,
      '    END AS why',
      '  FROM win w LEFT JOIN prior p USING (post_url)',
      `  WHERE w.risk_tag AND (w.followers >= ${PW_MIN_FOLLOWERS_} OR w.eng >= ${PW_MIN_ENGAGEMENT_})`,
      ')',
      "SELECT 'sonar', ROW_NUMBER() OVER (ORDER BY CASE why WHEN 'broke out' THEN 0 WHEN 'grew' THEN 1 ELSE 2 END, followers DESC),",
      '  post_url, platform, author, followers, eng, posted, first_seen, issue, issue_new,',
      "  COALESCE(NULLIF(TRIM(summary), ''), SUBSTR(TRIM(snippets), 1, 400)) AS summary,",
      "  SUBSTR(CONCAT('Summary: ', IFNULL(summary, ''), '\\nPost text: ', IFNULL(snippets, ''),",
      "    CASE why WHEN 'grew' THEN '\\nIt was small when first seen today and has grown since.'",
      "      WHEN 'broke out' THEN CONCAT('\\nIt is breaking out: ', CAST(eng AS STRING), ' engagements now, up from ',",
      "        CAST(IFNULL(eng_before, 0) AS STRING), ' earlier today.') ELSE '' END), 1, " + PW_TEXT_CHARS_ + '), why, tax',
      'FROM cand',
      `WHERE why IS NOT NULL AND (posted IS NULL OR posted >= TIMESTAMP_SUB(${until}, ` +
        `INTERVAL IF(why = 'new', ${PW_NEW_HOURS_}, ${PW_GROWTH_HOURS_}) HOUR));`,
    ];
  },
  // Tubular's videos first seen since the last one handed over, posted within 72 hours, the reach floor (or 10K+ views)
  tubular: () => [
    `INSERT INTO pw_new (${PW_NEW_COLS_})`,
    "SELECT 'tubular', ROW_NUMBER() OVER (ORDER BY IFNULL(views, 0) + 20 * IFNULL(eng, 0) DESC), video_url, " +
      `${pwNetSql_('platform')}, creator,`,
    '  followers, eng, posted, first_seen,',
    "  IF(IFNULL(topics, '') = '', 'Tubular', CONCAT('Tubular · ', SUBSTR(topics, 1, 120))), CAST(NULL AS BOOL), SUBSTR(title, 1, 400),",
    "  SUBSTR(CONCAT('Video title: ', IFNULL(title, ''), '\\nCreator: ', IFNULL(creator, ''), ' (', CAST(IFNULL(followers, 0) AS STRING),",
    `    ' followers or subscribers)\\nViews so far: ', CAST(IFNULL(views, 0) AS STRING), '\\nTopics: ', IFNULL(topics, '')), 1, ${PW_TEXT_CHARS_})`,
    'FROM (',
    '  SELECT video_url, ANY_VALUE(platform) AS platform, ANY_VALUE(creator) AS creator,',
    '    SAFE_CAST(MAX(creator_followers_or_subscribers) AS INT64) AS followers, SAFE_CAST(MAX(total_engagements) AS INT64) AS eng,',
    '    MAX(views) AS views, MIN(published_at_utc) AS posted, MIN(first_seen_at_utc) AS first_seen, ANY_VALUE(video_title) AS title,',
    "    ANY_VALUE(COALESCE(NULLIF(topics, ''), NULLIF(youtube_topics, ''), categories)) AS topics",
    `  FROM ${pwTable_('tubular')}`,
    '  WHERE snapshot_date >= DATE_SUB(DATE(TIMESTAMP_MILLIS(@tubular_from)), INTERVAL 2 DAY) AND video_url IS NOT NULL',
    '  GROUP BY video_url',
    ')',
    'WHERE first_seen > TIMESTAMP_MILLIS(@tubular_from) AND first_seen <= TIMESTAMP_MILLIS(@until_ms)',
    '  AND (posted IS NULL OR posted >= TIMESTAMP_SUB(TIMESTAMP_MILLIS(@until_ms), INTERVAL 72 HOUR))',
    `  AND (IFNULL(followers, 0) >= ${PW_MIN_FOLLOWERS_} OR IFNULL(eng, 0) >= ${PW_MIN_ENGAGEMENT_} OR IFNULL(views, 0) >= 10000);`,
  ],
  // Brandwatch's mentions of Google's products first loaded since the last batch it handed over (the table loads a
  // night's batch and loads many again later: each counts once, at its first load): negative, English, no shares, on
  // Reddit, Bluesky, Facebook or Instagram (PW_BWM_NETWORKS_), tagged by Brandwatch with an SLRR exposure tag (its
  // category group PW_BWM_EXPOSURE_GROUP_: those tags go to Gemini, and every one in tax for the card, which reads them
  // as the official taxonomy: pwSourceTax_), posted within 72 hours, the reach floor, with text. The biggest first. A
  // batch is read as the table stood at its end (@bwm_upto: the end of the look that first read it), so one bigger than a
  // look's cap goes over the next looks in the same order, the first @bwm_skip of it already handed over (pwFroms_,
  // pwAdvanceMarks_). Read only when the table changed (or while a batch is being handed over); its partitions
  // (report_date: the post's day) and clustering (product_config_name) keep it to the last days' Google mentions
  bwm: () => {
    const configs = PW_BWM_CONFIGS_.map(c => `'${c}'`).join(', ');
    const eng = ['like_count', 'retweet_count', 'reply_count', 'comment_count', 'share_count'].map(c => `IFNULL(${c}, 0)`).join(' + ');
    const upto = 'TIMESTAMP_MILLIS(@bwm_upto)';
    return [
      `INSERT INTO pw_new (${PW_NEW_COLS_}, why, tax)`,
      "SELECT 'bwm', ROW_NUMBER() OVER (ORDER BY IFNULL(followers, 0) + 10 * IFNULL(eng, 0) DESC, mention_id) - @bwm_skip AS rk,",
      "  post_url, platform, NULLIF(author, ''), followers, eng, posted, first_seen,",
      "  CONCAT('Brandwatch \u00b7 ', SUBSTR(cats, 1, 120)), CAST(NULL AS BOOL), SUBSTR(body, 1, 400),",
      "  SUBSTR(CONCAT(IF(title != '' AND NOT STARTS_WITH(LOWER(body), LOWER(title)), CONCAT('Title: ', title, '\\n'), ''),",
      "    'Post text: ', body, '\\nBrandwatch: negative sentiment',",
      "    IF(IFNULL(followers, 0) > 0, CONCAT(', reach ', CAST(followers AS STRING)), ''),",
      "    '\\nBrandwatch exposure tags: ', cats, '\\nProduct: ', configs), 1, " + `${PW_TEXT_CHARS_}),`,
      "  'negative', TO_JSON_STRING(JSON_OBJECT('p', SPLIT(configs, ', '),",
      "    'c', ARRAY(SELECT DISTINCT x FROM UNNEST(tags) x ORDER BY x LIMIT 12))) AS tax",
      'FROM (',
      "  SELECT m.*, ARRAY_TO_STRING(ARRAY(SELECT DISTINCT x FROM UNNEST(m.tags) x ORDER BY x LIMIT 4), ', ') AS cats",
      '  FROM (',
      '    SELECT mention_id, MIN(load_timestamp) AS first_seen, ANY_VALUE(post_url) AS post_url, ANY_VALUE(net) AS platform,',
      "      ANY_VALUE(TRIM(IFNULL(author, ''))) AS author,",
      `      SAFE_CAST(MAX(reachEstimate) AS INT64) AS followers, SAFE_CAST(MAX(${eng}) AS INT64) AS eng,`,
      "      MIN(published_timestamp) AS posted, STRING_AGG(DISTINCT product_config_name, ', ' LIMIT 3) AS configs,",
      "      ANY_VALUE(TRIM(IFNULL(snippet, ''))) AS body, ANY_VALUE(TRIM(IFNULL(title, ''))) AS title,",
      '      ARRAY_CONCAT_AGG(xtags) AS tags',
      '    FROM (',
      `      SELECT *, ${pwNetSql_('platform')} AS net,`,
      `        ARRAY(SELECT c.name FROM UNNEST(categories) c WHERE c.parent_name = '${PW_BWM_EXPOSURE_GROUP_}' AND c.name IS NOT NULL) AS xtags`,
      `      FROM ${pwTable_('bwm')}`,
      `      WHERE report_date >= DATE_SUB(DATE(${upto}), INTERVAL 3 DAY)`,
      `        AND product_config_name IN (${configs}) AND language = 'en'`,
      "        AND LOWER(IFNULL(sentiment, '')) = 'negative' AND LOWER(IFNULL(thread_entry_type, '')) != 'share'",
      `        AND ${pwNetsInSql_('platform', PW_BWM_NETWORKS_)}`,
      `        AND load_timestamp <= ${upto} AND post_url IS NOT NULL`,
      '    )',
      '    GROUP BY mention_id',
      '    HAVING MIN(load_timestamp) > TIMESTAMP_MILLIS(@bwm_from) AND ARRAY_LENGTH(ARRAY_CONCAT_AGG(xtags)) > 0',
      '  ) m',
      ')',
      `WHERE body != '' AND (IFNULL(followers, 0) >= ${PW_MIN_FOLLOWERS_} OR IFNULL(eng, 0) >= ${PW_MIN_ENGAGEMENT_})`,
      `  AND (posted IS NULL OR posted >= TIMESTAMP_SUB(${upto}, INTERVAL 72 HOUR))`,
      `  AND NOT ${nonEnglishScriptSql_('body')}`,
      'QUALIFY rk > 0;',
    ];
  },
  // Google's own posts in Sprinklr's report (never the other brands' accounts it also tracks: Is_External) refreshed
  // since the last one handed over (it loads once a day, refreshing the last days' posts), posted within 72 hours, not
  // deleted, in English, on the team's networks (PW_NETWORKS_), whose comments turned negative: PW_OWNED_NEG_+ negative,
  // or PW_OWNED_PCT_ of them once there are PW_OWNED_MIN_COMMENTS_+ (Sprinklr's share can read over 100%: capped). The
  // most negative first. Read only when the table changed
  owned: () => {
    const pct = Math.round(PW_OWNED_PCT_ * 100);
    return [
      `INSERT INTO pw_new (${PW_NEW_COLS_}, why)`,
      "SELECT 'owned', ROW_NUMBER() OVER (ORDER BY neg DESC, IFNULL(eng, 0) DESC), url, " + pwNetSql_('net') +
        ', acct, followers, eng, posted, loaded,',
      "  CONCAT('Google\\'s own post \u00b7 ', IFNULL(acct, '')), CAST(NULL AS BOOL), SUBSTR(IFNULL(txt, ''), 1, 400),",
      "  SUBSTR(CONCAT('A post Google itself published, from its account ', IFNULL(acct, ''),",
      "    IF(IFNULL(handle, '') = '', '', CONCAT(' (@', handle, ')')), ' on ', IFNULL(net, ''),",
      "    IF(IFNULL(country, '') = '', '', CONCAT(', ', country)), '.\\nPost text: ', IFNULL(txt, ''),",
      "    '\\nReaction so far: ', CAST(IFNULL(comments, 0) AS STRING), ' comments, ', CAST(IFNULL(neg, 0) AS STRING),",
      "    ' negative (', CAST(IFNULL(pct, 0) AS STRING), '%), ', CAST(IFNULL(eng, 0) AS STRING), ' engagements.'), 1, " +
        `${PW_TEXT_CHARS_}),`,
      "  'negative comments'",
      'FROM (',
      '  SELECT Outbound_Post_ID, ANY_VALUE(Post_Permalink) AS url, ANY_VALUE(Social_Network) AS net, ANY_VALUE(Account_Name) AS acct,',
      '    ANY_VALUE(Account_Screen_Name) AS handle, ANY_VALUE(Country) AS country, ANY_VALUE(SUBSTR(Outbound_Post, 1, 1400)) AS txt,',
      '    SAFE_CAST(MAX(Followers_At_Time_Of_Post) AS INT64) AS followers, SAFE_CAST(MAX(Engagements) AS INT64) AS eng,',
      '    SAFE_CAST(MAX(Comments) AS INT64) AS comments, SAFE_CAST(MAX(Negative_Sentiment_Comment_Count) AS INT64) AS neg,',
      '    SAFE_CAST(ROUND(100 * LEAST(MAX(Pct_Negative_Comments), 1)) AS INT64) AS pct,',
      '    MIN(Post_Published_Date_UTC) AS posted, MAX(load_timestamp) AS loaded',
      `  FROM ${pwTable_('owned')}`,
      '  WHERE Report_Date >= DATE_SUB(DATE(TIMESTAMP_MILLIS(@until_ms)), INTERVAL 3 DAY) AND Post_Permalink IS NOT NULL',
      '    AND NOT IFNULL(Is_Deleted, FALSE) AND NOT IFNULL(Is_External, FALSE)',  // External: other brands' accounts Sprinklr tracks
      `    AND ${pwNetsInSql_('Social_Network')}`,
      `    AND ${englishLangSql_('Language_Code')} AND NOT ${nonEnglishScriptSql_("IFNULL(Outbound_Post, '')")}`,
      '  GROUP BY Outbound_Post_ID',
      ')',
      'WHERE loaded > TIMESTAMP_MILLIS(@owned_from) AND loaded <= TIMESTAMP_MILLIS(@until_ms)',
      '  AND posted >= TIMESTAMP_SUB(TIMESTAMP_MILLIS(@until_ms), INTERVAL 72 HOUR)',
      `  AND (IFNULL(neg, 0) >= ${PW_OWNED_NEG_} OR (IFNULL(comments, 0) >= ${PW_OWNED_MIN_COMMENTS_} AND IFNULL(pct, 0) >= ${pct}));`,
    ];
  },
  // Comments on Google's own posts that reached BigQuery in the last hour: a post whose negative comments crossed
  // PW_PILEUP_NEG_ in this window, or one with a negative comment in it from a PW_BIG_VOICE_+ account
  comments: () => [
    `INSERT INTO pw_new (${PW_NEW_COLS_})`,
    "SELECT 'comments', ROW_NUMBER() OVER (ORDER BY neg DESC, top_f DESC), post_url, " + pwNetSql_('platform') + ', acct, top_f, neg,',
    '  posted, last_at, CONCAT("Comments on Google\'s post: ", CAST(neg AS STRING), \' negative of \', CAST(n AS STRING), \' in an hour\'),',
    '  CAST(NULL AS BOOL), SUBSTR(top_neg, 1, 400),',
    '  SUBSTR(CONCAT("Comments on a post by Google\'s account ", IFNULL(acct, \'\'), \' on \', IFNULL(platform, \'\'), \'.\\nThe post: \',',
    "    IFNULL(caption, ''), '\\nIn the last hour: ', CAST(n AS STRING), ' comments, ', CAST(neg AS STRING), ' negative',",
    `    IF(top_f >= ${PW_BIG_VOICE_}, CONCAT(', one from an account with ', CAST(top_f AS STRING), ' followers'), ''),`,
    `    '.\\nThe most-followed negative comments: ', IFNULL(top_neg, '')), 1, ${PW_TEXT_CHARS_})`,
    'FROM (',
    '  SELECT post_url, ANY_VALUE(account_name) AS acct, ANY_VALUE(platform) AS platform, ANY_VALUE(SUBSTR(post_caption, 1, 500)) AS caption,',
    '    MIN(post_published_date) AS posted, MAX(_CHANGE_TIMESTAMP) AS last_at, COUNT(DISTINCT comment_id) AS n,',
    '    COUNT(DISTINCT IF(neg, comment_id, NULL)) AS neg,',
    '    COUNT(DISTINCT IF(neg AND _CHANGE_TIMESTAMP > TIMESTAMP_MILLIS(@since_ms), comment_id, NULL)) AS neg_win,',
    '    SAFE_CAST(MAX(IF(neg, author_followers, 0)) AS INT64) AS top_f,',
    '    MAX(IF(neg AND _CHANGE_TIMESTAMP > TIMESTAMP_MILLIS(@since_ms), author_followers, 0)) AS top_f_win,',
    "    ARRAY_TO_STRING(ARRAY_AGG(IF(neg, SUBSTR(comment_text, 1, 200), NULL) IGNORE NULLS ORDER BY author_followers DESC LIMIT 4), ' | ') AS top_neg",
    "  FROM (SELECT *, LOWER(IFNULL(sentiment, '')) = 'negative' AS neg",
    `    FROM APPENDS(TABLE ${pwTable_('comments')}, TIMESTAMP_SUB(TIMESTAMP_MILLIS(@until_ms), INTERVAL 60 MINUTE), TIMESTAMP_MILLIS(@until_ms)))`,
    '  WHERE post_url IS NOT NULL',
    '  GROUP BY post_url',
    ')',
    `WHERE (neg >= ${PW_PILEUP_NEG_} AND neg - neg_win < ${PW_PILEUP_NEG_}) OR top_f_win >= ${PW_BIG_VOICE_};`,
  ],
  // The DSD story selection feed's posts (Brandwatch's HIGH and KOF alert emails, one row a post) ingested since the last
  // one handed over, posted within 72 hours, with text. No reach floor: Brandwatch's alert already picked them, and the
  // feed's follower and engagement counts are mostly empty (all zeros, or 500/500/500/2000, means unmeasured: NULL here,
  // so Gemini reads "unknown", never 0). KOF first, then the measured engagements, then the newest
  story: () => [
    `INSERT INTO pw_new (${PW_NEW_COLS_}, tax)`,
    "SELECT 'story', ROW_NUMBER() OVER (ORDER BY IF(UPPER(IFNULL(alert_type, '')) = 'KOF', 0, 1), IFNULL(eng, 0) DESC, ingestion_time DESC),",
    `  url, ${pwNetSql_('platform')}, author, SAFE_CAST(follower_count AS INT64), eng, post_time, ingestion_time,`,
    "  CONCAT('DSD story selection', IF(IFNULL(alert_type, '') = '', '', CONCAT(' \u00b7 ', alert_type)),",
    "    IF(IFNULL(query_name, '') = '', '', CONCAT(' \u00b7 ', query_name))), CAST(NULL AS BOOL), SUBSTR(snippet, 1, 400),",
    "  SUBSTR(CONCAT('Post text: ', snippet, IF(IFNULL(alert_type, '') = '', '', CONCAT('\\nBrandwatch alert: ', alert_type,",
    `    IF(UPPER(alert_type) = 'KOF', ' (a key opinion former)', '')))), 1, ${PW_TEXT_CHARS_}),`,
    "  TO_JSON_STRING(JSON_OBJECT('kv', IF(UPPER(IFNULL(alert_type, '')) = 'KOF', 'Brandwatch KOF alert', CAST(NULL AS STRING)))) AS tax",
    'FROM (',
    '  SELECT *, IF((likes = 500 AND shares = 500 AND comments = 500 AND total_engagements = 2000)',
    '    OR IFNULL(total_engagements, 0) = 0, NULL, total_engagements) AS eng',
    `  FROM ${pwTable_('story')}`,
    '  WHERE ingestion_time > TIMESTAMP_MILLIS(@story_from) AND ingestion_time <= TIMESTAMP_MILLIS(@until_ms) AND url IS NOT NULL',
    ')',
    "WHERE TRIM(IFNULL(snippet, '')) != ''",
    `  AND NOT ${nonEnglishScriptSql_('IFNULL(snippet, \'\')')}`,
    '  AND (post_time IS NULL OR post_time >= TIMESTAMP_SUB(TIMESTAMP_MILLIS(@until_ms), INTERVAL 72 HOUR));',
  ],
  // The Other alerts space's alerts (pwChatItems_), as the query parameter @chat
  chat: () => [
    `INSERT INTO pw_new (${PW_NEW_COLS_})`,
    "SELECT 'chat', ROW_NUMBER() OVER (ORDER BY c.s DESC), c.u, c.n, c.a, NULLIF(c.f, -1), NULLIF(c.e, -1),",
    '  IF(c.p > 0, TIMESTAMP_MILLIS(c.p), NULL), TIMESTAMP_MILLIS(c.s), c.i, CAST(NULL AS BOOL), c.m, c.t',
    "FROM UNNEST(@chat) c WHERE IFNULL(c.u, '') != '';",
  ],
  // The Brandwatch query's mentions added since the last one handed over (pwBwqItems_), as the query parameter @bwq:
  // each 'new', or 'skipped' with no text (an X post X wouldn't show: counted, never asked about); what went wrong
  // reading Brandwatch (@bwq_err) goes on its row. The biggest accounts first, then the newest
  bwq: () => [
    "INSERT INTO pw_src (source, err) SELECT 'bwq', @bwq_err FROM UNNEST([1]) WHERE @bwq_err != '';",
    `INSERT INTO pw_new (${PW_NEW_COLS_}, why)`,
    "SELECT 'bwq', ROW_NUMBER() OVER (ORDER BY IF(IFNULL(c.t, '') = '', 1, 0), c.f DESC, c.s DESC), c.u, c.n, c.a,",
    '  NULLIF(c.f, -1), NULLIF(c.e, -1), IF(c.p > 0, TIMESTAMP_MILLIS(c.p), NULL), TIMESTAMP_MILLIS(c.s), c.i, CAST(NULL AS BOOL),',
    "  c.m, NULLIF(c.t, ''), IF(IFNULL(c.t, '') = '', 'skipped', 'new')",
    "FROM UNNEST(@bwq) c WHERE IFNULL(c.u, '') != '';",
  ],
};

/**
 * When each of the lane's tables last changed (ms), from their datasets' __TABLES__ (it costs nothing), on pw_src;
 * each table read only when it changed is read on its own first (pw_mod_<source>: pwSql_). Pure.
 */
function pwModSql_(srcs) {
  const sel = srcs.filter(s => s.bq && !s.gate).map(s => {
    const i = s.bq.lastIndexOf('.');
    return `SELECT '${s.key}', last_modified_time FROM \`${s.bq.slice(0, i)}.__TABLES__\` WHERE table_id = '${s.bq.slice(i + 1)}'`;
  });
  return sel.length ? pwGuard_('_tables', ['INSERT INTO pw_src (source, mod_ms)', sel.join('\nUNION ALL ') + ';']) : [];
}

/**
 * Whether a post is Grok's (PW_GROK_URL_RX_): Sonar links Grok's posts as twitter.com/grok/status(es)/\u2026, the
 * Brandwatch query as x.com/grok/status/\u2026 (X's embed data gives a repost as the post it reposts), and the sources that
 * name the handle say @grok. Pure.
 */
function pwByGrok_(url, author) {
  return PW_GROK_URL_RX_.test(String(url || '').trim()) || String(author || '').trim().toLowerCase() === '@grok';
}

/** pwByGrok_ in SQL, on table `t`'s post_url and author (BigQuery reads the pattern as RE2, the same as here). Pure. */
function pwGrokSql_(t) {
  return `(REGEXP_CONTAINS(LOWER(TRIM(IFNULL(${t}.post_url, ''))), r'^https?://(?:www\\.|m\\.|mobile\\.)?(?:x|twitter)\\.com/grok/')` +
    ` OR LOWER(TRIM(IFNULL(${t}.author, ''))) = '@grok')`;
}

/**
 * The lane's last statement: Gemini on its sources' new rows (each source's first `cap`, one row a post, the earliest
 * source first), one row a post a watch at or above the watch's bar less PW_NEAR_ (kind 'hit', the highest scores
 * first), then one row a source (kind 'src': found, checked, newest_ms, mod_ms, err). capOf(source): this look's cap for
 * a source (default: its cap). Pure.
 */
function pwAiSql_(srcs, structs, topics, capOf) {
  const cap = s => Math.max(0, Math.floor(Number(capOf ? capOf(s) : s.cap) || 0));
  const caps = srcs.map(s => `STRUCT('${s.key}' AS source, ${cap(s)} AS cap)`).join(', ');
  const grok = pwGrokSql_('n');  // Grok's posts: never asked about, not counted as checked, counted as PW_GROK_WHY_
  // (row 50 ON, the AMIE table among the sources: an X post by its status id, so AMIE's copy and another source's are one)
  const amie = srcs.some(s => s.key === 'amie');
  const key = amie ? pwKeySql_('n.post_url') : "REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(LOWER(n.post_url), r'^https?://(?:www\\.|m\\.|mobile\\.)?', ''), " +
    "r'^twitter\\.com/', 'x.com/'), r'#.*$|/+$', '')";
  return [
    'WITH watches AS (',
    `  SELECT * FROM UNNEST([${structs.join(',\n    ')}])`,
    '),',
    `caps AS (SELECT * FROM UNNEST([${caps}])),`,
    'cand AS (',
    '  SELECT * EXCEPT (dup) FROM (',
    `    SELECT n.*, ROW_NUMBER() OVER (PARTITION BY ${key} ORDER BY n.first_seen, n.source) AS dup`,
    '    FROM pw_new n JOIN caps c USING (source)',
    `    WHERE n.rk <= c.cap AND n.post_url IS NOT NULL AND IFNULL(n.why, '') != 'skipped' AND NOT ${grok}`,
    '  ) WHERE dup = 1',
    '),',
    'hits AS (',
    '  SELECT c.*, w.idx, w.watch, w.rubric, w.bar',
    '  FROM cand c CROSS JOIN watches w',
    '  WHERE (w.nets = \'\' OR c.platform IN UNNEST(SPLIT(w.nets, \'|\')))',
    '    AND AI.IF(CONCAT(w.cond, \'\\n\\nRule: Return TRUE only if the post text itself is in English (return FALSE for non-English posts).\\n\\n\', c.txt))',
    '),',
    'scored AS (',
    "  SELECT *, AI.SCORE(CONCAT(rubric, '\\n\\nAuthor reach: ', IFNULL(CAST(followers AS STRING), 'unknown'), ' followers. Engagements so far: ',",
    "    IFNULL(CAST(eng AS STRING), 'unknown'), '.\\n\\n', txt)) AS impact",
    '  FROM hits',
    '),',
    'found AS (',
    "  SELECT n.source, COUNTIF(IFNULL(n.why, '') != 'skipped') AS found,",
    `    COUNTIF(n.rk <= c.cap AND IFNULL(n.why, '') != 'skipped' AND NOT ${grok}) AS checked, UNIX_MILLIS(MAX(n.first_seen)) AS newest_ms`,
    '  FROM pw_new n JOIN caps c USING (source) GROUP BY n.source',
    '),',
    `whys AS (SELECT source, IF(IFNULL(why, '') != 'skipped' AND ${pwGrokSql_('g')}, '${PW_GROK_WHY_}', why) AS why, COUNT(*) AS n`,
    `  FROM pw_new g WHERE why IS NOT NULL OR ${pwGrokSql_('g')} GROUP BY 1, 2),`,
    "detail AS (SELECT source, STRING_AGG(CONCAT(IF(why = 'skipped', 'not sent', why), ' ', CAST(n AS STRING)), ', '",
    "  ORDER BY IF(why = 'skipped', 1, 0), n DESC) AS detail FROM whys GROUP BY source),",
    "src AS (SELECT source, MAX(mod_ms) AS mod_ms, STRING_AGG(err, '; ' LIMIT 2) AS err FROM pw_src GROUP BY source)",
    "SELECT 'hit' AS kind, s.source, s.why, s.idx, s.watch, s.post_url, s.platform, s.author, s.followers, s.eng,",
    '  UNIX_MILLIS(s.posted) AS posted_ms, UNIX_MILLIS(s.first_seen) AS seen_ms, s.issue, s.issue_new,',
    '  SUBSTR(IFNULL(s.summary, \'\'), 1, 400) AS summary, ROUND(s.impact, 1) AS impact, s.bar,',
    `  AI.CLASSIFY(s.txt, [${topics.map(t => `'${t}'`).join(', ')}]) AS topic,`,
    '  CAST(NULL AS INT64) AS found, CAST(NULL AS INT64) AS checked, CAST(NULL AS INT64) AS newest_ms, CAST(NULL AS INT64) AS mod_ms,',
    '  CAST(NULL AS STRING) AS err, CAST(NULL AS STRING) AS detail, s.tax AS tax',
    `FROM scored s WHERE s.impact >= GREATEST(1, s.bar - ${PW_NEAR_})`,
    'UNION ALL',
    "SELECT 'src', c.source, CAST(NULL AS STRING), CAST(NULL AS INT64), CAST(NULL AS STRING), CAST(NULL AS STRING), CAST(NULL AS STRING),",
    '  CAST(NULL AS STRING), CAST(NULL AS INT64), CAST(NULL AS INT64), CAST(NULL AS INT64), CAST(NULL AS INT64), CAST(NULL AS STRING),',
    '  CAST(NULL AS BOOL), CAST(NULL AS STRING), CAST(NULL AS FLOAT64), CAST(NULL AS FLOAT64), CAST(NULL AS STRING),',
    '  IFNULL(f.found, 0), IFNULL(f.checked, 0), f.newest_ms, x.mod_ms, x.err, d.detail, CAST(NULL AS STRING)',
    'FROM caps c LEFT JOIN found f USING (source) LEFT JOIN src x USING (source) LEFT JOIN detail d USING (source)',
  ].concat(amie ? [  // the keys of the AMIE rows handed over (kind 'amk', the hash in `why`): pwAmieKeysAdd_
    'UNION ALL',
    `SELECT 'amk', 'amie', ${pwAmieHashSql_(pwKeySql_('n.post_url'))}, CAST(NULL AS INT64), CAST(NULL AS STRING), CAST(NULL AS STRING),`,
    '  CAST(NULL AS STRING), CAST(NULL AS STRING), CAST(NULL AS INT64), CAST(NULL AS INT64), CAST(NULL AS INT64), CAST(NULL AS INT64),',
    '  CAST(NULL AS STRING), CAST(NULL AS BOOL), CAST(NULL AS STRING), CAST(NULL AS FLOAT64), CAST(NULL AS FLOAT64), CAST(NULL AS STRING),',
    '  CAST(NULL AS INT64), CAST(NULL AS INT64), CAST(NULL AS INT64), CAST(NULL AS INT64), CAST(NULL AS STRING), CAST(NULL AS STRING),',
    '  CAST(NULL AS STRING)',
    "FROM pw_new n JOIN caps c USING (source) WHERE n.source = 'amie' AND n.rk <= c.cap",
  ] : [], [
    'ORDER BY kind, impact DESC',
  ]);
}

/**
 * A lane's look (`laneKey`: 'c1' us-central1 or 'us' US) for `watches` (pwActive_): a read-only script that keeps
 * each of the lane's sources' new rows in a temporary table, then asks Gemini about them (pwAiSql_). `o`: {since,
 * until} (ms: the window, for Sonar and the comments), froms (pwFroms_: {source: ms}, where each other source starts;
 * <source>_mod: when a source read only when its table changed last read it, 0 to read it at once; <source>_upto and
 * <source>_skip: the end of the batch a spread source hands over and how much of it it already did; <source>_left:
 * what's left of a source's day's maximum, its cap at most), chat (pwChatItems_, the US lane), bwq and bwqErr
 * (pwBwqItems_: the Brandwatch query's rows and what went wrong reading it, the US lane). The watches' words and the
 * alerts' and mentions' text are query parameters (never part of the SQL); the topics are cleaned of quotes and
 * backslashes (pwTopic_). {sql, params: [{name, type, value} | {name, struct, rows}]}. Pure.
 */
function pwSql_(laneKey, watches, o) {
  const srcs = pwLaneSources_(laneKey);
  const froms = (o && o.froms) || {};
  const until = Math.floor(Number(o.until));
  const params = [
    { name: 'since_ms', type: 'INT64', value: Math.floor(Number(o.since)) },
    { name: 'until_ms', type: 'INT64', value: until },
  ];
  const structs = watches.map((w, i) => {
    const p = `w${i + 1}_`;
    params.push({ name: p + 'name', type: 'STRING', value: w.name }, { name: p + 'cond', type: 'STRING', value: w.cond },
      { name: p + 'rubric', type: 'STRING', value: w.rubric }, { name: p + 'bar', type: 'FLOAT64', value: w.bar },
      { name: p + 'nets', type: 'STRING', value: (w.nets || []).join('|') });
    return `STRUCT(${i + 1} AS idx, @${p}name AS watch, @${p}cond AS cond, @${p}rubric AS rubric, @${p}bar AS bar, ` +
      `@${p}nets AS nets)`;
  });
  const seen = new Set();
  const topics = [].concat(...watches.map(w => w.topics || [])).map(pwTopic_)
    .filter(t => t && !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase())).slice(0, PW_MAX_TOPICS_).concat(['Other']);
  srcs.forEach(s => {
    if (s.key === 'chat') params.push({ name: 'chat', struct: PW_CHAT_FIELDS_, rows: (o && o.chat) || [] });
    else if (s.key === 'bwq') {
      params.push({ name: 'bwq', struct: PW_CHAT_FIELDS_, rows: (o && o.bwq) || [] },
        { name: 'bwq_err', type: 'STRING', value: truncate_(String((o && o.bwqErr) || ''), PW_ERR_CHARS_) });
    } else if (!s.window) params.push({ name: `${s.key}_from`, type: 'INT64', value: Math.floor(Number(froms[s.key]) || 0) });
    // the AMIE table: the keys handed over in the last 24 hours (pwAmieKeys_), left out when read again
    if (s.key === 'amie') params.push({ name: 'amie_seen', type: 'STRING', value: (Array.isArray(froms.amie_seen) ? froms.amie_seen : []).join(',') });
    if (s.spread) {  // its batch: read as its table stood at the batch's end, the part already handed over skipped
      params.push({ name: `${s.key}_upto`, type: 'INT64', value: Math.floor(Number(froms[`${s.key}_upto`]) || until) },
        { name: `${s.key}_skip`, type: 'INT64', value: Math.max(0, Math.floor(Number(froms[`${s.key}_skip`]) || 0)) });
    }
  });
  const gated = srcs.filter(s => s.gate);
  const lines = [];  // a script's DECLAREs come first
  gated.forEach(s => {
    params.push({ name: `${s.key}_mod`, type: 'INT64', value: Math.floor(Number(froms[`${s.key}_mod`]) || 0) });
    lines.push(`DECLARE pw_mod_${s.key} INT64 DEFAULT NULL;`);
  });
  lines.push(`CREATE TEMP TABLE pw_new (source STRING, rk INT64, post_url STRING, platform STRING, author STRING, ` +
    'followers INT64, eng INT64, posted TIMESTAMP, first_seen TIMESTAMP, issue STRING, issue_new BOOL, summary STRING, txt STRING, ' +
    'why STRING, tax STRING);');
  lines.push('CREATE TEMP TABLE pw_src (source STRING, mod_ms INT64, err STRING);');
  gated.forEach(s => {  // when its table last changed, on its own (a failure is its own row's error, and it isn't read)
    const i = s.bq.lastIndexOf('.');
    lines.push(...pwGuard_(s.key, [`  SET pw_mod_${s.key} = (SELECT last_modified_time FROM \`${s.bq.slice(0, i)}.__TABLES__\` ` +
      `WHERE table_id = '${s.bq.slice(i + 1)}');`]));
    lines.push(`INSERT INTO pw_src (source, mod_ms) VALUES ('${s.key}', pw_mod_${s.key});`);
  });
  lines.push(...pwModSql_(srcs));
  srcs.forEach(s => {
    const block = pwGuard_(s.key, PW_SOURCE_SQL_[s.key](froms));
    if (s.gate) lines.push(`IF pw_mod_${s.key} > @${s.key}_mod THEN`, ...block, 'END IF;');
    else lines.push(...block);
  });
  // a source with a day's maximum (dayMax) hands over what's left of today's (pwFroms_: <key>_left), within its cap
  const capOf = s => (s.dayMax && froms[`${s.key}_left`] !== undefined ? Math.min(s.cap, Number(froms[`${s.key}_left`]) || 0) : s.cap);
  lines.push(pwAiSql_(srcs, structs, topics, capOf).join('\n'));
  return { sql: lines.join('\n'), params };
}

/** A query parameter as BigQuery takes it: a scalar, or an array of structs ({name, struct: [[field, type]], rows}). Pure. */
function pwParam_(p) {
  if (!p.struct) return { name: p.name, parameterType: { type: p.type }, parameterValue: { value: String(p.value) } };
  const fallback = t => (t === 'INT64' ? '-1' : '');
  return {
    name: p.name,
    parameterType: { type: 'ARRAY', arrayType: { type: 'STRUCT', structTypes: p.struct.map(f => ({ name: f[0], type: { type: f[1] } })) } },
    parameterValue: {
      arrayValues: (p.rows || []).map(r => {
        const values = {};
        p.struct.forEach(f => {
          const v = r[f[0]];
          values[f[0]] = { value: v === undefined || v === null || v === '' ? fallback(f[1]) : String(v) };
        });
        return { structValues: values };
      }),
    },
  };
}

/** One BigQuery REST call with the script's token: the JSON answer, or an error with BigQuery's message. */
function pwCall_(method, url, body) {
  const resp = UrlFetchApp.fetch(url, Object.assign({
    method, muteHttpExceptions: true, headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
  }, body ? { contentType: 'application/json', payload: JSON.stringify(body) } : {}));
  const code = resp.getResponseCode();
  const text = resp.getContentText() || '';
  if (code < 200 || code >= 300) {
    let why = text.slice(0, 240);
    try { why = (JSON.parse(text).error || {}).message || why; } catch (e) { /* not JSON */ }
    throw new Error(`BigQuery HTTP ${code}: ${truncate_(why, 240)}`);
  }
  return text ? JSON.parse(text) : {};
}

/** Sends a lane's look (jobs.query in its location, waiting PW_SUBMIT_WAIT_MS_): BigQuery's answer, finished or not. */
function pwSubmit_(q, lane) {
  const l = lane || PW_LANES_[0];
  if (typeof apiGuardNote_ === 'function') apiGuardNote_('bigquery', 1);
  return pwCall_('post', `${BQ_API_BASE_}${GCP_PROJECT}/queries`, {
    query: q.sql, useLegacySql: false, location: l.location, timeoutMs: PW_SUBMIT_WAIT_MS_, parameterMode: 'NAMED',
    maximumBytesBilled: PW_MAX_BYTES_, labels: { purpose: 'proactive-watch', tool: 'burson-qa-bot', lane: l.key },
    queryParameters: q.params.map(pwParam_),
  });
}

/** The waiting look's results (jobs.getQueryResults, waiting PW_COLLECT_WAIT_MS_): BigQuery's answer, finished or not. */
function pwFetch_(job) {
  return pwCall_('get', `${BQ_API_BASE_}${encodeURIComponent(job.project || GCP_PROJECT)}/queries/` +
    `${encodeURIComponent(job.id)}?location=${encodeURIComponent(job.location || PW_LOCATION_)}&timeoutMs=${PW_COLLECT_WAIT_MS_}`);
}

/** Cancels a look that ran too long (jobs.cancel). Never throws. */
function pwCancel_(job) {
  try {
    pwCall_('post', `${BQ_API_BASE_}${encodeURIComponent(job.project || GCP_PROJECT)}/jobs/${encodeURIComponent(job.id)}/cancel` +
      `?location=${encodeURIComponent(job.location || PW_LOCATION_)}`);
  } catch (e) {
    console.warn(`Proactive watch: couldn't cancel the BigQuery job ${job.id}: ${(e && e.message) || e}`);
  }
}

/** The lane's look waiting to be collected (its job property), or null. */
function pwJob_(props, lane) {
  try {
    const j = JSON.parse(props.getProperty((lane || PW_LANES_[0]).jobProp) || 'null');
    return j && j.id ? j : null;
  } catch (e) {
    return null;
  }
}

/** Each source's place (PW_MARKS: {source: ms, <source>_mod: ms, <source>_snap: [from, upto, done, top]}); {} for none. */
function pwMarks_(props) {
  try {
    const m = JSON.parse(props.getProperty(PW_MARKS_PROP_) || 'null');
    return m && typeof m === 'object' ? m : {};
  } catch (e) {
    return {};
  }
}

/**
 * The batch a spread source is still handing over: its <source>_snap mark [from, upto, done, top] (what was first loaded
 * from `from` to `upto`, ms, read as its table stood at `upto`; `done` of it handed over; `top` its newest item), or
 * null: none, or (given `until`, ms) older than the source's maxMs by then, when what's left of it is let go. Pure.
 */
function pwSnap_(marks, s, until) {
  const v = (marks || {})[`${s.key}_snap`];
  if (!Array.isArray(v) || v.length !== 4) return null;
  const [from, upto, done, top] = v.map(Number);
  if (!(upto > 0 && from < upto && done >= 0)) return null;
  if (until !== undefined && until !== null && Number(until) - upto > s.maxMs) return null;
  return [from, upto, Math.floor(done), top > 0 ? top : 0];
}

/**
 * Where each source that keeps its own place starts a look ending at `until` (ms): its mark, but never more than its
 * maxMs back; with no mark yet (a first look), its firstMs back; a spread source handing over a batch (pwSnap_), that
 * batch's start, with <source>_upto (the batch's end; else `until`) and <source>_skip (how much of it it handed over).
 * Plus, for each source read only when its table changed, <source>_mod: when it last read it (0: never, or a batch of it
 * is being handed over: read it whatever its table's time); for each with a day's maximum (dayMax), <source>_left:
 * what's left of today's, from `today` (pwToday_: what each source handed Gemini today, ET; none: all of it). Pure.
 */
function pwFroms_(marks, until, today) {
  const m = marks || {};
  const out = {};
  pwSources_().forEach(s => {
    const snap = s.spread ? pwSnap_(m, s, until) : null;
    if (s.gate) out[`${s.key}_mod`] = snap ? 0 : Math.max(0, Number(m[`${s.key}_mod`]) || 0);
    if (s.dayMax) {
      const done = (((today && today.src) || {})[s.key] || [])[0];
      out[`${s.key}_left`] = Math.max(0, s.dayMax - (Number(done) || 0));
    }
    if (s.window) return;
    const have = Number(m[s.key]) || 0;
    // (overlapMs: the AMIE table reads again from that long before its mark, so a row that lands late is caught)
    out[s.key] = snap ? snap[0] : have > 0 ? Math.max(have - (Number(s.overlapMs) || 0), until - s.maxMs) : until - s.firstMs;
    if (s.spread) {
      out[`${s.key}_upto`] = snap ? snap[1] : until;
      out[`${s.key}_skip`] = snap ? snap[2] : 0;
    }
  });
  return out;
}

/**
 * The marks after a look that ended at `until` (ms) is collected (`stats`: its 'src' rows): each source that keeps its
 * own place moves to the newest item it handed over (never back); a source that failed stays where it was (tried
 * again); a table read only when it changed is marked read (<source>_mod), never later than the look's end (what
 * reached it after that is read at the next look); a spread source that left part of its batch keeps its place and
 * counts what it handed over (<source>_snap: the next looks hand over the rest), and moves past the batch once it's all
 * handed over, or once its day's maximum leaves it nothing to hand over (the rest is let go). Only the current sources'
 * marks are kept. Pure.
 */
function pwAdvanceMarks_(marks, stats, until) {
  const m = marks || {};
  const end = Number(until) || 0;
  const used = pwFroms_(m, end);  // where the look started each source: its marks haven't moved since it was sent
  const out = {};
  pwSources_().forEach(s => {
    if (!s.window && Number(m[s.key]) > 0) out[s.key] = Number(m[s.key]);
    if (s.gate && Number(m[`${s.key}_mod`]) > 0) out[`${s.key}_mod`] = Number(m[`${s.key}_mod`]);
    const snap = s.spread ? pwSnap_(m, s) : null;  // kept as it is: only the source's own look decides on it
    if (snap) out[`${s.key}_snap`] = snap;
  });
  (stats || []).forEach(r => {
    const s = pwSource_(r && r.source);
    if (!s || r.err) return;
    const upto = (s.spread && Number(used[`${s.key}_upto`])) || end;
    if (s.gate && Number(r.mod_ms) > 0) {
      const mod = upto > 0 ? Math.min(Number(r.mod_ms), upto) : Number(r.mod_ms);
      if (mod > (Number(out[`${s.key}_mod`]) || 0)) out[`${s.key}_mod`] = mod;
    }
    if (s.window) return;
    const newest = Number(r.newest_ms) || 0;
    if (!s.spread) {
      if (newest > (Number(out[s.key]) || 0)) out[s.key] = newest;
      return;
    }
    const was = pwSnap_(m, s, end);  // the batch this look handed part of (none: it read a new one)
    const handed = Math.max(0, Number(r.checked) || 0);
    const top = Math.max(was ? was[3] : 0, newest);
    if (handed > 0 && (Number(r.found) || 0) > handed) {
      out[`${s.key}_snap`] = [Number(used[s.key]) || 0, upto, (Number(used[`${s.key}_skip`]) || 0) + handed, top];
    } else {
      delete out[`${s.key}_snap`];
      if (top > (Number(out[s.key]) || 0)) out[s.key] = top;
    }
  });
  return out;
}

/**
 * Forgets where the looks were (switched OFF, or back from a pause): the next look starts from the last 15 minutes.
 * Today's numbers stay (PW_TODAY), and with them what each source already handed Gemini toward its day's maximum.
 */
function pwReset_(props) {
  PW_LANES_.forEach(l => [l.jobProp, l.sinceProp, l.atProp, l.triesProp].forEach(k => props.deleteProperty(k)));
  [PW_LAST_PROP_, PW_MARKS_PROP_].forEach(k => props.deleteProperty(k));
}

/**
 * The switch is OFF: whatever a look left behind is forgotten, so turning it ON starts afresh. One property read a run
 * (every look sends its us-central1 job first, which leaves PW_AT). Never throws.
 */
function proactiveWatchOff_() {
  try {
    const props = PropertiesService.getScriptProperties();
    if (props.getProperty(PW_AT_PROP_)) pwReset_(props);
  } catch (e) {
    console.error('Proactive watch: ' + ((e && e.message) || e));
  }
}

// --------------------------------------------------------------------------------------------------------------
// The Other alerts space's alerts: from the Alert log, for the US look
// --------------------------------------------------------------------------------------------------------------

/** The Alert log's newest PW_CHAT_READ_ROWS_ rows ([] when it can't be read). */
function pwRecentAlerts_(ss) {
  try {
    return sheetTable_(ss, ALERT_TAB_, ALERT_COLUMNS_, 'alert_id', PW_CHAT_READ_ROWS_).load();
  } catch (e) {
    console.warn('Proactive watch: couldn\'t read the Alert log for the Other alerts space\'s alerts: ' + ((e && e.message) || e));
    return [];
  }
}

/**
 * The alerts in other formats (Brandwatch's...) the bot read in the Other alerts space (OtherAlerts.gs: `ingested`
 * OTHER_INGESTED_, the space's partition), that reached it in (`from`, `until`] (ms), with a post link, as the @chat
 * parameter's rows (PW_CHAT_FIELDS_): the newest first, the source's cap at most. Their text: the stream, the issue,
 * the triage's neutral summary, the author and the engagement. Pure.
 */
function pwChatItems_(alerts, from, until) {
  const cap = (pwSource_('chat') || {}).cap || 30;
  return (alerts || [])
    .filter(a => a && a.ingested === OTHER_INGESTED_ && String(a.space || '').endsWith(OS_PARTITION_SUFFIX_))
    .map(a => ({ a, s: Number(a.source_at) || Number(a.created_at) || 0 }))
    .filter(x => x.s > from && x.s <= until)
    .sort((x, y) => y.s - x.s)
    .map(x => {
      const f = x.a.forwarded_fields && typeof x.a.forwarded_fields === 'object' ? x.a.forwarded_fields : {};
      const tri = f.triage && typeof f.triage === 'object' ? f.triage : {};
      const url = String(f.post_url || '').trim();
      if (!/^https?:\/\/\S+$/i.test(url)) return null;
      const one = v => String(v === undefined || v === null ? '' : v).replace(/\s+/g, ' ').trim();
      const stream = one(tri.stream);
      const issue = one(f.issue_name);
      const summary = one(tri.summary || f.summary);
      const author = one(x.a.author || f.author);
      const eng = Number(f.total_engagement);
      const posted = Date.parse(one(f.post_date)) || 0;
      const text = [`An alert posted in the Other alerts space${stream ? ` ("${stream}")` : ''}.`, issue ? `Issue: ${issue}` : '',
        summary ? `What it is: ${summary}` : '', author ? `Author: ${author}` : '',
        tri.engagement ? `Engagement: ${one(tri.engagement)}` : ''].filter(Boolean).join('\n');
      return { u: truncate_(url, 500), n: pwPlatform_(f.social_network || ''), a: truncate_(author, 120), f: -1,
        e: Number.isFinite(eng) && eng >= 0 ? Math.round(eng) : -1, p: posted > 0 ? posted : 0, s: x.s,
        i: truncate_(`Other alerts space${stream ? ` · ${stream}` : ''}`, 200), m: truncate_(summary, 400),
        t: truncate_(text, PW_TEXT_CHARS_) };
    })
    .filter(Boolean)
    .slice(0, cap);
}

// --------------------------------------------------------------------------------------------------------------
// The Brandwatch query: what Brandwatch added since the last look, straight from its API, for the US look
// --------------------------------------------------------------------------------------------------------------

/** A Brandwatch time ("2026-11-02T03:27:59.359+0000") in ms; 0 for none or one it can't read. Pure. */
function pwBwTime_(s) {
  const v = String(s || '').trim().replace(/([+-]\d\d)(\d\d)$/, '$1:$2');
  const ms = v ? Date.parse(v) : NaN;
  return isFinite(ms) && ms > 0 ? ms : 0;
}

/** What an HTTP answer says went wrong, in a line: its JSON error's message, else the start of its text. */
function pwHttpWhy_(resp) {
  const text = String((resp && resp.getContentText()) || '');
  let why = text.slice(0, 200);
  try {
    const j = JSON.parse(text) || {};
    const e = j.error || (Array.isArray(j.errors) ? j.errors[0] : null);
    why = j.error_description || (e && (e.message || (typeof e === 'string' ? e : ''))) || j.message || why;
  } catch (e) { /* not JSON */ }
  return truncate_(String(why).replace(/\s+/g, ' ').trim(), 200);
}

/**
 * The shared Brandwatch token: the latest version of PW_BW_SECRET_ in Secret Manager (the token slrr-campaigns mints
 * and keeps fresh), read with the script's own cloud-platform token and billed to GCP_PROJECT. Read each look; never
 * kept, logged or written anywhere. Throws with what went wrong.
 */
function pwBwToken_() {
  const resp = UrlFetchApp.fetch(
    `https://secretmanager.googleapis.com/v1/projects/${GCP_PROJECT}/secrets/${PW_BW_SECRET_}/versions/latest:access`, {
      muteHttpExceptions: true,
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken(), 'x-goog-user-project': GCP_PROJECT },
    });
  const code = resp.getResponseCode();
  if (code !== 200) throw new Error(`Secret Manager HTTP ${code} reading the shared Brandwatch token: ${pwHttpWhy_(resp)}`);
  let data = '';
  try { data = String(((JSON.parse(resp.getContentText() || '{}') || {}).payload || {}).data || ''); } catch (e) { data = ''; }
  const token = data ? Utilities.newBlob(Utilities.base64Decode(data)).getDataAsString().trim() : '';
  if (!token) throw new Error('the shared Brandwatch token in Secret Manager is empty');
  return token;
}

/**
 * The Brandwatch query's mentions that Brandwatch added in (`from`, `until`] (ms), posted within PW_BW_HOURS_, the
 * newest added first: a page of PW_BW_FIRST_PAGE_ first, which on a quiet look is all it reads (Brandwatch's X data
 * allowance is shared by every Google team on the account: the team's rules say to read as few X mentions as will do);
 * when all of those are new, page after page of PW_BW_PAGE_ (PW_BW_MAX_PAGES_ at most; the ones already read skipped)
 * until a page reaches what was added before, while the run has time (`left`: ms of it left). {list, err}: what was
 * read, and what went wrong ('' for nothing; what was read before an error still counts).
 */
function pwBwMentions_(token, from, until, left) {
  const out = { list: [], err: '' };
  const start = encodeURIComponent(new Date(until - PW_BW_HOURS_ * PW_HOUR_MS_).toISOString());
  const end = encodeURIComponent(new Date(Math.max(until, Date.now())).toISOString());
  const seen = new Set();  // the mentions read so far (a page of 100 starts with the first page's 20)
  const keyOf = m => `${(m && (m.resourceId || m.guid || m.url)) || ''}|${(m && m.added) || ''}`;
  const plan = [[PW_BW_FIRST_PAGE_, 0]].concat(Array.from({ length: PW_BW_MAX_PAGES_ }, (_, i) => [PW_BW_PAGE_, i]));
  for (let n = 0; n < plan.length; n++) {
    const [size, page] = plan[n];
    if (n && left() < PW_MIN_LEFT_MS_ + 30 * 1000) break;
    const resp = UrlFetchApp.fetch(`${PW_BW_API_}/projects/${PW_BW_PROJECT_}/data/mentions?queryId=${PW_BW_QUERY_}` +
      `&startDate=${start}&endDate=${end}&pageSize=${size}&page=${page}&orderBy=added&orderDirection=desc`,
      { muteHttpExceptions: true, headers: { Authorization: 'bearer ' + token, Accept: 'application/json' } });
    const code = resp.getResponseCode();
    if (code !== 200) {
      const hint = code === 401 ? ' (the shared token was refused)' : code === 429 ? ' (too many calls for now)' : '';
      out.err = `Brandwatch HTTP ${code}${hint}: ${pwHttpWhy_(resp)}`;
      break;
    }
    let results = null;
    try { results = (JSON.parse(resp.getContentText() || '{}') || {}).results; } catch (e) { results = null; }
    if (!Array.isArray(results)) {
      out.err = 'Brandwatch\'s answer had no list of mentions';
      break;
    }
    if (typeof bwCountMentions_ === 'function') bwCountMentions_(results.length, 'watch');  // the one count of every feature's Brandwatch mentions (row 49)
    let older = false;
    results.forEach(m => {
      const k = keyOf(m);
      if (seen.has(k)) return;
      seen.add(k);
      const at = pwBwTime_(m && m.added);
      if (at > from && at <= until) out.list.push(m);
      else if (at && at <= from) older = true;
    });
    if (older || results.length < size) break;
  }
  return out;
}

/**
 * A Brandwatch mention as a @bwq row (PW_CHAT_FIELDS_); `x`: the X post X's embed data gave for it (lookupXPosts_):
 * X posts come from Brandwatch's API without their text, author or link. With no text, t is '' (counted, never asked
 * about). Followers: the author's (Brandwatch's potential audience on the networks where it's the author's followers),
 * else -1 (unknown); engagements: what the platform counted, else -1. Pure.
 */
function pwBwRow_(m, x) {
  const one = v => String(v === undefined || v === null ? '' : v).replace(/\s+/g, ' ').trim();
  const pos = v => { const n = Number(v); return isFinite(n) && n > 0 ? Math.round(n) : 0; };
  const net = /^facebook/i.test(one(m.pageType)) ? 'facebook' : pwPlatform_(one(m.pageType));
  const isX = net === 'twitter';
  const id = one(m.guid);
  const url = isX ? one((x && x.url) || m.url || (/^\d{5,25}$/.test(id) ? `https://x.com/i/status/${id}` : ''))
    : one(m.url || m.originalUrl);
  const author = isX ? (x && x.author ? '@' + one(x.author) : one(m.author))
    : one(m.author || m.fullname || m.publicationName || m.domain);
  const followers = pos(m.twitterFollowers) || pos(m.blueskyFollowers) || pos(m.instagramFollowerCount) ||
    pos(m.youtubeSubscriberCount) || (PW_BW_SOCIAL_.includes(net) ? pos(m.potentialAudience) : 0);
  const eng = isX ? (x ? (Number(x.likes) || 0) + (Number(x.replies) || 0) : -1)
    : (pos(m.likes) + pos(m.comments) + pos(m.shares) || pos(m.engagementScore) || -1);
  const text = one((x && x.text) || m.snippet || m.fullText);
  const title = one(m.title);
  const nonEn = isNonEnglishPost_(text || title, one((x && x.lang) || m.language));
  const site = PW_BW_SOCIAL_.includes(net) || net === 'reddit' ? '' : one(m.publicationName || m.domain);
  const signals = [one(m.sentiment) ? `${one(m.sentiment)} sentiment` : '',
    pos(m.potentialAudience) ? `potential audience ${fmtInt_(pos(m.potentialAudience))}` : '',
    Number(m.impact) > 0 ? `impact ${Math.round(Number(m.impact) * 10) / 10} of 100` : ''].filter(Boolean);
  const lines = !text || nonEn ? [] : [
    title && !text.toLowerCase().startsWith(title.toLowerCase()) ? `Title: ${title}` : '',
    `Post text: ${text}`,
    x && x.quoted && x.quoted.text ? `Quoting @${one(x.quoted.author)}: ${one(x.quoted.text)}` : '',
    x && x.parent && x.parent.text ? `Replying to @${one(x.parent.author)}: ${one(x.parent.text)}` : '',
    site ? `Site: ${site}` : '',
    signals.length ? `Brandwatch: ${signals.join(', ')}` : '',
  ].filter(Boolean);
  return {
    u: truncate_(url, 500), n: net, a: truncate_(author, 120), f: followers || -1, e: eng,
    p: isX ? pwBwTime_(x && x.created_at) : pwBwTime_(m.date), s: pwBwTime_(m.added),
    i: truncate_(`Brandwatch \u00b7 ${one(m.queryName) || PW_BW_QUERY_NAME_}`, 200), m: truncate_(text || title, 400),
    t: truncate_(lines.join('\n'), PW_TEXT_CHARS_),
  };
}

/**
 * The Brandwatch query's mentions added in (`from`, `until`] (ms) as the @bwq parameter's rows (pwBwRow_), the X
 * posts' text looked up together from X's embed data (lookupXPosts_: PW_BW_X_MAX_ a look at most, the biggest accounts
 * first, while the run has time; `left`: ms of it left), and what went wrong: {rows, err} (err '' for nothing). Never
 * throws; the token goes only to Brandwatch (an error that repeats it has it cut out).
 */
function pwBwqItems_(from, until, left) {
  const time = typeof left === 'function' ? left : () => Infinity;
  let token = '';
  const clean = s => (token ? String(s || '').split(token).join('[token]') : String(s || ''));
  try {
    token = pwBwToken_();
    const got = pwBwMentions_(token, Number(from) || 0, Number(until) || 0, time);
    const isX = m => /^twitter$/i.test(String((m && m.pageType) || ''));
    const ids = got.list.filter(m => isX(m) && !String(m.snippet || '').trim())
      .sort((a, b) => (Number(b.potentialAudience) || 0) - (Number(a.potentialAudience) || 0))
      .map(m => String(m.guid || '')).filter(id => /^\d{5,25}$/.test(id)).slice(0, PW_BW_X_MAX_);
    const xs = ids.length && time() >= PW_MIN_LEFT_MS_ + 20 * 1000 ? lookupXPosts_(ids) : {};
    const rows = got.list.map(m => pwBwRow_(m, isX(m) ? xs[String(m.guid || '')] || null : null)).filter(r => r.u && r.s > 0);
    return { rows, err: clean(got.err) };
  } catch (e) {
    return { rows: [], err: clean((e && e.message) || e) };
  }
}

// --------------------------------------------------------------------------------------------------------------
// Recording: the rows a look returned, on the Watch detections tab
// --------------------------------------------------------------------------------------------------------------

/** A detection's key (its hidden column): {k: the post's record key, w: the watch, s: seen (ms), b: 1 at the bar}. Pure. */
function pwKeyOf_(cell) {
  try {
    const v = JSON.parse(String(cell || ''));
    return v && typeof v === 'object' && v.k ? v : null;
  } catch (e) {
    return null;
  }
}

/** The data rows on the tab: {first (row number), values} of the newest `max` (none: values []). */
function pwDetRows_(sh, max) {
  const last = sh.getLastRow();
  if (last <= PW_DET_HEAD_ROW_) return { first: PW_DET_HEAD_ROW_ + 1, values: [] };
  const first = Math.max(PW_DET_HEAD_ROW_ + 1, last - max + 1);
  return { first, values: sh.getRange(first, 1, last - first + 1, PW_DET_HEADER_.length).getValues() };
}

/**
 * A source's own classification of a post (its 'tax' JSON) as the card reads it (WatchAlerts.gs pwTaxOf_): a list of
 * the listening tool's own category names (c: Brandwatch's SLRR exposure-tag group, "Product - Dangerous results (e.g.
 * medical/legal)", "Risk - Child Safety"...) becomes the official taxonomy's names: each one, "Risk - " taken off, an
 * exposure tag or else a Sensitive Topic by its name or alias (lookupTag_, lookupTopic_; one that's neither is left
 * out); the tag is the highest-priority one (P0, then P1, then P2: an alert carries one), the topics all of them. Any
 * other classification is handed over as it is. Pure but for GEN.
 */
function pwSourceTax_(raw) {
  let o = null;
  try { o = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { o = null; }
  if (!o || typeof o !== 'object' || Array.isArray(o) || !Array.isArray(o.c)) return raw;
  const rank = t => { const p = /^P(\d+)$/i.exec(String((t && t.priority) || '').trim()); return p ? Number(p[1]) : 9; };
  let tag = null;
  const topics = [];
  o.c.forEach(c => {
    const name = String(c === undefined || c === null ? '' : c).replace(/\s+/g, ' ').trim().replace(/^risk\s*-\s*/i, '');
    const t = name ? lookupTag_(name) : null;
    if (t) {
      if (!tag || rank(t) < rank(tag)) tag = t;
      return;
    }
    const topic = name ? lookupTopic_(name) : null;
    if (topic && !topics.includes(topic.name)) topics.push(topic.name);
  });
  const out = Object.assign({}, o);
  delete out.c;
  if (tag && !out.t) out.t = tag.name;
  if (topics.length) out.s = Array.from(new Set([].concat(Array.isArray(out.s) ? out.s : [], topics)));
  return out;
}

/**
 * The look's BigQuery rows (pwSql_'s 'hit' rows; its 'src' rows have no watch and are left out) as the tab's rows, each
 * post once a watch (`have`: "watch|key" already on the tab; added to as rows are made). Seen: when the source had it,
 * never before `floor` (ms: the look's window start), so a source that hands its rows over late never claims a lead it
 * couldn't have had. `queue` (Watch alerts chosen, Control row 35): a flag at the bar waits on the tab to be posted as a
 * watch alert (its key: a 'q', with the watch's bar and the score: WatchAlerts.gs pwPostAlerts_). A row from a source
 * the watch no longer reads (a look sent before it stopped) is never recorded. `held` (optional; Map of "watch|key" ->
 * {eng}): the small flags waiting to be grouped (their key: a 'b'); one a source hands over again, still at the bar and
 * now with PW_SOLO_MIN_ENG_ engagements or more (Sonar's "broke out" rows), goes in `requeue` ({id: "watch|key", eng,
 * followers, score}: pwRequeue_), once. {rows, flagged, near, queued, requeue, byWatch: {watch: [flagged, near]},
 * bySource: {source: [flagged, near]}}. Pure.
 */
function pwDetections_(results, have, floor, queue, held) {
  const out = { rows: [], flagged: 0, near: 0, queued: 0, requeue: [], byWatch: {}, bySource: {} };
  (results || []).forEach(r => {
    if (!r || !r.post_url || !r.watch || r.impact === null || r.impact === undefined) return;
    if (!pwSource_(String(r.source || 'sonar'))) return;
    if (pwByGrok_(r.post_url, r.author)) return;  // Grok's posts are never flagged (pwGrokSql_ leaves them out before Gemini)
    if (isNonEnglishPost_(String(r.summary || ''), '')) return;
    const key = recordKey_({ post_url: String(r.post_url) }) || String(r.post_url);
    const watch = String(r.watch);
    if (have.has(`${watch}|${key}`)) {
      // already on the tab. A small flag that waited to be grouped and has since grown is queued again
      const h = queue && held ? held.get(`${watch}|${key}`) : null;
      const grown = Number(r.eng) || 0;
      if (h && !h.requeued && Number(r.impact) >= Number(r.bar) && grown >= PW_SOLO_MIN_ENG_ && grown > (Number(h.eng) || 0)) {
        h.requeued = true;
        out.requeue.push({ id: `${watch}|${key}`, eng: grown, followers: Number(r.followers) || 0, score: Number(r.impact) });
      }
      return;
    }
    have.add(`${watch}|${key}`);
    const impact = Number(r.impact);
    const atBar = impact >= Number(r.bar);
    const src = String(r.source || 'sonar');
    const counts = out.byWatch[watch] || (out.byWatch[watch] = [0, 0]);
    const bySrc = out.bySource[src] || (out.bySource[src] = [0, 0]);
    if (atBar) { out.flagged++; counts[0]++; bySrc[0]++; } else { out.near++; counts[1]++; bySrc[1]++; }
    const seen = Math.max(Number(r.seen_ms) || 0, Number(floor) || 0);
    const row = new Array(PW_DET_HEADER_.length).fill('');
    row[PW_COL_.seen - 1] = pwText_(pwTime_(seen));
    row[PW_COL_.watch - 1] = pwCell_(watch, 80);
    row[PW_COL_.score - 1] = isFinite(impact) ? impact : '';
    row[PW_COL_.bar - 1] = atBar ? 'Yes' : 'No';
    row[PW_COL_.topic - 1] = pwCell_(r.topic, 80);
    row[PW_COL_.post - 1] = pwCell_(r.post_url, 500);
    const s = pwSource_(src) || {};
    const why = r.why && r.why !== s.plainWhy ? ` · ${r.why}` : '';  // why it was asked about, when it isn't the usual
    row[PW_COL_.source - 1] = pwCell_(`${s.name || src}${why}`, 80);
    row[PW_COL_.network - 1] = pwCell_(pwNetwork_(r.platform, String(r.post_url)), 40);
    row[PW_COL_.author - 1] = pwCell_(r.author, 120);
    row[PW_COL_.followers - 1] = Number(r.followers) || 0;
    row[PW_COL_.eng - 1] = Number(r.eng) || 0;
    row[PW_COL_.posted - 1] = pwText_(pwTime_(r.posted_ms));
    row[PW_COL_.issue - 1] = pwCell_(r.issue, 200);
    row[PW_COL_.isNew - 1] = r.issue_new === true ? 'Yes' : '';
    row[PW_COL_.summary - 1] = pwCell_(r.summary, 400);
    // the listening tool's own classification (Sonar's, Brandwatch's categories, DSD's KOF) in the official taxonomy
    // (pwSourceTax_), kept on a queued flag's key for its card
    const tax = queue && atBar && r.tax && typeof pwTaxOf_ === 'function' ? pwTaxOf_(pwSourceTax_(r.tax)) : null;
    row[PW_COL_.key - 1] = JSON.stringify(Object.assign({ k: key, w: watch, s: seen, b: atBar ? 1 : 0 },
      queue && atBar ? { a: 'q', br: Number(r.bar), sc: isFinite(impact) ? impact : 0 } : {}, tax ? { x: tax } : {}));
    if (queue && atBar) out.queued++;
    out.rows.push(row);
  });
  return out;
}

/**
 * Writes the look's rows under the tab's last row, with the Rating dropdown, then trims the oldest past
 * PW_DET_MAX_ROWS_ (once PW_DET_TRIM_SLACK_ more have built up). `floor`, `queue`: pwDetections_. {added, flagged, near,
 * byWatch, bySource}.
 */
function pwRecord_(sh, results, floor, queue) {
  const have = new Set();
  const held = new Map();  // the small flags waiting to be grouped (WatchAlerts.gs: a 'b'), by "watch|key"
  const block = pwDetRows_(sh, PW_DET_READ_ROWS_);
  block.values.forEach((v, i) => {
    const k = pwKeyOf_(v[PW_COL_.key - 1]);
    if (!k) return;
    have.add(`${k.w}|${k.k}`);
    if (k.a === 'b') held.set(`${k.w}|${k.k}`, { i, k, eng: Number(v[PW_COL_.eng - 1]) || 0 });
  });
  const d = pwDetections_(results, have, floor, queue, held);
  // before any row is added or trimmed (the block's row numbers still hold): the held flags that grew, queued again
  if (d.requeue.length && pwRequeue_(sh, block, held, d.requeue, Date.now())) {
    PropertiesService.getScriptProperties().setProperty(PW_ALERT_PENDING_PROP_, String(Date.now()));
  }
  if (d.rows.length) {
    const at = Math.max(sh.getLastRow(), PW_DET_HEAD_ROW_) + 1;
    sh.getRange(at, 1, d.rows.length, PW_DET_HEADER_.length).setValues(d.rows);
    try {
      sh.getRange(at, PW_COL_.rating, d.rows.length, 1)
        .setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(PW_RATINGS_, true).build());
    } catch (e) { /* the column works without its dropdown */ }
    pwTrim_(sh);
    // flags wait to go out as watch alerts (WatchAlerts.gs pwPostAlerts_ reads the tab for them only while this is set)
    if (d.queued) PropertiesService.getScriptProperties().setProperty(PW_ALERT_PENDING_PROP_, String(Date.now()));
  }
  return { added: d.rows.length, flagged: d.flagged, near: d.near, byWatch: d.byWatch, bySource: d.bySource };
}

/**
 * Queues again the small flags that waited to be grouped (their key: a 'b') whose post has since grown into one that
 * matters by itself (`list`: pwDetections_'s requeue; `held`: "watch|key" -> {i: index in `block`, k}): the row's
 * engagements, followers and score brought up to date, its key back to a 'q' with rq (when: its 3 hours to go out count
 * from then), out of its build-up. The next pwPostAlerts_ takes it like a new flag. One that was held today is no longer
 * in today's count of small flags held (C35: WatchAlerts.gs pwAlertDay_): it is counted where it ends. Rows queued again.
 */
function pwRequeue_(sh, block, held, list, now) {
  let n = 0;
  let today = 0;  // of them, held today
  (list || []).forEach(x => {
    const h = held.get(x.id);
    if (!h) return;
    const row = block.first + h.i;
    sh.getRange(row, PW_COL_.eng).setValue(x.eng);
    if (x.followers > 0) sh.getRange(row, PW_COL_.followers).setValue(x.followers);
    if (isFinite(x.score)) sh.getRange(row, PW_COL_.score).setValue(x.score);
    const k = Object.assign({}, h.k, { a: 'q', rq: now }, isFinite(x.score) ? { sc: x.score } : {});
    delete k.bg;
    delete k.ac;
    sh.getRange(row, PW_COL_.key).setValue(JSON.stringify(k));
    n++;
    if (pwOnToday_(h.k.at)) today++;
  });
  if (today) pwAlertDay_(0, 0, { held: -today });
  if (n) console.log(`Proactive watch: ${n} small flag${n === 1 ? '' : 's'} that waited to be grouped grew past ${PW_SOLO_MIN_ENG_} engagements: queued as alerts of their own`);
  return n;
}

/**
 * Keeps the newest PW_DET_MAX_ROWS_ data rows (their ratings with them) once PW_DET_TRIM_SLACK_ more have built up.
 * Sheets drops a text cell's leading escape apostrophe when it is read back (getValues), so each kept text cell that
 * starts like a formula gets it again before the rows are rewritten: a post's text is never read as a formula.
 */
function pwTrim_(sh) {
  const count = sh.getLastRow() - PW_DET_HEAD_ROW_;
  if (count <= PW_DET_MAX_ROWS_ + PW_DET_TRIM_SLACK_) return;
  const all = sh.getRange(PW_DET_HEAD_ROW_ + 1, 1, count, PW_DET_HEADER_.length).getValues();
  const keep = all.slice(count - PW_DET_MAX_ROWS_)
    .map(row => row.map(v => (typeof v === 'string' && /^[=+\-@]/.test(v) ? '\'' + v : v)));
  sh.getRange(PW_DET_HEAD_ROW_ + 1, 1, keep.length, PW_DET_HEADER_.length).setValues(keep);
  sh.getRange(PW_DET_HEAD_ROW_ + 1 + keep.length, 1, count - keep.length, PW_DET_HEADER_.length).clearContent();
}

// --------------------------------------------------------------------------------------------------------------
// The scorecard: Burson's alerts (the Alert log) against the watches' flags
// --------------------------------------------------------------------------------------------------------------

/**
 * When Burson's alert on each post reached S-F Burson (ms), from the Alert log's rows: {record key: earliest source_at}.
 * Only Burson's alerts: never one the bot took from BigQuery itself or an Other alerts space's (`ingested`, or their
 * partition). Pure.
 */
function pwBursonTimes_(alerts) {
  const out = {};
  (alerts || []).forEach(a => {
    if (!a || !a.record_key || a.ingested || String(a.space || '').endsWith(OS_PARTITION_SUFFIX_)) return;
    const at = Number(a.source_at) || 0;
    if (at <= 0) return;
    const k = String(a.record_key);
    if (!out[k] || at < out[k]) out[k] = at;
  });
  return out;
}

/** The median of some numbers, rounded ('' for none). Pure. */
function pwMedian_(nums) {
  const v = (nums || []).filter(n => isFinite(n)).sort((a, b) => a - b);
  if (!v.length) return '';
  const m = Math.floor(v.length / 2);
  return Math.round(v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2);
}

/**
 * The scorecard's rows: one a day for the `days` (ET day keys, newest first), then their total, as PW_SCORE_HEADER_.
 * `dets`: [{k, s (seen ms), b (1 at the bar), rating}] (the tab's rows); `burson`: pwBursonTimes_; `dayOf`: ms -> day key.
 * Burson's alerts on a day: the posts whose alert reached S-F Burson that day; caught: a watch flagged the post at its bar
 * (whenever); first: before Burson's alert; lead: Burson's time less the first flag, in minutes (the median of the
 * firsts). Flagged, near misses and ratings: the rows seen that day. Pure.
 */
function pwScorecard_(dets, burson, days, dayOf) {
  const firstFlag = {};
  dets.forEach(d => { if (d.b === 1 && (firstFlag[d.k] === undefined || d.s < firstFlag[d.k])) firstFlag[d.k] = d.s; });
  const byDay = {};
  days.forEach(day => { byDay[day] = { alerts: 0, caught: 0, leads: [], flagged: 0, near: 0, useful: 0, noise: 0 }; });
  Object.keys(burson).forEach(k => {
    const t = byDay[dayOf(burson[k])];
    if (!t) return;
    t.alerts++;
    if (firstFlag[k] !== undefined) {
      t.caught++;
      if (firstFlag[k] < burson[k]) t.leads.push((burson[k] - firstFlag[k]) / 60000);
    }
  });
  dets.forEach(d => {
    const t = byDay[dayOf(d.s)];
    if (!t) return;
    if (d.b === 1) t.flagged++; else t.near++;
    const r = String(d.rating || '').trim().toLowerCase();
    if (r === 'useful') t.useful++;
    if (r === 'noise') t.noise++;
  });
  const line = (label, t) => [label, t.alerts, t.caught, t.leads.length, pwMedian_(t.leads), t.flagged, t.near, t.useful, t.noise];
  const total = { alerts: 0, caught: 0, leads: [], flagged: 0, near: 0, useful: 0, noise: 0 };
  days.forEach(day => {
    const t = byDay[day];
    ['alerts', 'caught', 'flagged', 'near', 'useful', 'noise'].forEach(f => { total[f] += t[f]; });
    total.leads = total.leads.concat(t.leads);
  });
  return days.map(day => line(day, byDay[day])).concat([line(`Last ${days.length} days`, total)]);
}

/**
 * Rewrites the scorecard (rows 4-11) and fills in each row's "Burson alerted" and "Lead over Burson" from the Alert
 * log, writing only what changed. Never throws (a failure is logged; the next refresh tries again).
 */
function pwRefreshScorecard_(ss, sh, now) {
  try {
    const burson = pwBursonTimes_(sheetBackend_(ss).loadAlerts());
    const block = pwDetRows_(sh, PW_DET_READ_ROWS_);
    const dets = [];
    let changed = false;
    const filled = block.values.map(v => {
      const k = pwKeyOf_(v[PW_COL_.key - 1]);
      const was = [v[PW_COL_.bursonAt - 1], v[PW_COL_.lead - 1]];
      if (!k) return was;
      dets.push({ k: k.k, s: Number(k.s) || 0, b: k.b === 1 ? 1 : 0, rating: v[PW_COL_.rating - 1] });
      const at = burson[k.k];
      const next = at ? [pwText_(pwTime_(at)), Math.round((at - (Number(k.s) || 0)) / 60000)] : ['', ''];
      if (!pwSame_(next[0], was[0]) || !pwSame_(next[1], was[1])) changed = true;
      return next;
    });
    if (changed) sh.getRange(block.first, PW_COL_.bursonAt, filled.length, 2).setValues(filled);
    const days = [];
    for (let i = 0; i < PW_SCORE_DAYS_; i++) days.push(pwDay_(now - i * 24 * 3600 * 1000));
    const rows = pwScorecard_(dets, burson, Array.from(new Set(days)), pwDay_)
      .map((r, i, all) => (i < all.length - 1 ? [pwText_(r[0])].concat(r.slice(1)) : r));  // the days as text
    const range = sh.getRange(PW_SCORE_HEAD_ROW_ + 1, 1, rows.length, PW_SCORE_HEADER_.length);
    const current = range.getValues();
    if (rows.some((r, i) => r.some((c, j) => !pwSame_(c, (current[i] || [])[j])))) range.setValues(rows);
    PropertiesService.getScriptProperties().setProperty(PW_SCORE_AT_PROP_, String(now));
  } catch (e) {
    console.error('Proactive watch: the scorecard couldn\'t be updated: ' + ((e && e.stack) || e));
  }
}

// --------------------------------------------------------------------------------------------------------------
// The sources: how each one did at its last look, and whether it's live
// --------------------------------------------------------------------------------------------------------------

/** Each source's last look (PW_SOURCES: {source: {at, found, checked, newest, mod, err, flagged}}); {} for none. */
function pwSourceStats_(props) {
  try {
    const s = JSON.parse(props.getProperty(PW_SOURCES_PROP_) || 'null');
    return s && typeof s === 'object' ? s : {};
  } catch (e) {
    return {};
  }
}

/**
 * The sources' last looks after a collected look (`stats`: its 'src' rows; `bySource`: pwDetections_'s): what was new
 * and checked, the newest item ever handed over, when the table last changed, the error (cut short), what was flagged.
 * Pure.
 */
function pwSourcesAfter_(all, stats, bySource, now) {
  const out = Object.assign({}, all || {});
  (stats || []).forEach(r => {
    if (!r || !pwSource_(r.source)) return;
    const was = out[r.source] || {};
    out[r.source] = {
      at: now, found: Number(r.found) || 0, checked: Number(r.checked) || 0,
      newest: Math.max(Number(was.newest) || 0, Number(r.newest_ms) || 0),
      mod: Number(r.mod_ms) || Number(was.mod) || 0,
      err: r.err ? truncate_(String(r.err).replace(/\s+/g, ' '), 200) : '',
      detail: r.detail ? truncate_(String(r.detail), 300) : '',
      flagged: ((bySource || {})[r.source] || [0])[0],
    };
  });
  return out;
}

/** The last looks as they are kept (PW_LAST), or null. */
function pwLast_(props) {
  try { return JSON.parse(props.getProperty(PW_LAST_PROP_) || 'null'); } catch (e) { return null; }
}

/**
 * The lanes whose look has failed as a whole and not succeeded since (`last`: PW_LAST), by lane key: {since (ms: the
 * first failed try), why (the latest try's), ok (ms: when the lane's last good look was collected; 0 for none)}; {}
 * when none has. Pure.
 */
function pwLaneFails_(last) {
  const out = {};
  PW_LANES_.forEach(l => {
    const f = last && last.lanes && last.lanes[l.key] && last.lanes[l.key].fail;
    if (f && Number(f.since) > 0) out[l.key] = { since: Number(f.since), why: String(f.why || 'unknown'), ok: Number(f.ok) || 0 };
  });
  return out;
}

/**
 * When the latest look that worked was collected (ms; 0 for none), from the last looks (`last`: PW_LAST): the latest
 * of the lanes' looks, and of the last good look of a lane whose look fails now. The Watches tab's "last look". Pure.
 */
function pwLastGoodAt_(last) {
  const fails = pwLaneFails_(last);
  return Object.keys(fails).reduce((at, k) => Math.max(at, fails[k].ok), Number(last && last.at) || 0);
}

/**
 * A source's status (`st`: its last look, or none yet): {kind: 'waiting' | 'error' | 'stale' | 'live', text}. Stale:
 * its table hasn't changed for longer than its staleMs. `fail` (its lane's, of pwLaneFails_): the look it is read in
 * has failed as a whole, so it is failing with that look's error, whatever its own last look said. Pure.
 */
function pwSourceStatus_(src, st, now, fail) {
  if (fail) {
    return { kind: 'error', text: `⚠️ failing: ${pwFailWords_([src.lane])} ${pwWhen_(fail.since, true)}: ${fail.why} ` +
      '(tried again at the next look)' };
  }
  if (!st || !st.at) return { kind: 'waiting', text: '... waiting for its first look' };
  if (st.err) return { kind: 'error', text: `⚠️ error at the last look: ${st.err} (tried again at the next look)` };
  if (src.staleMs && Number(st.mod) > 0 && now - Number(st.mod) > src.staleMs) {
    return { kind: 'stale', text: `⚠️ stale: its table hasn't changed since ${pwTime_(st.mod)} ET (its rows count again once it has new ones)` };
  }
  return { kind: 'live', text: st.found ? `✓ live: ${fmtInt_(st.found)} new at the last look` : '✓ live: nothing new at the last look' };
}

/**
 * "sources: 4 live, 2 stale, 1 failing: Sprinklr comments" (all of them live: "all 8 sources live"); '' before any look.
 * Short: it goes in C34, whose note is cut at 200 characters. `fails`: pwLaneFails_. Pure.
 */
function pwSourcesSummary_(all, now, fails) {
  const n = { live: 0, stale: 0, error: 0, waiting: 0 };
  const failing = [];
  const list = pwSources_();
  list.forEach(s => {
    const kind = pwSourceStatus_(s, (all || {})[s.key], now, (fails || {})[s.lane]).kind;
    n[kind]++;
    if (kind === 'error') failing.push(s.name);
  });
  if (n.waiting === list.length) return '';
  if (n.live === list.length) return `all ${list.length} sources live`;
  const parts = [];
  if (n.live) parts.push(`${n.live} live`);
  if (n.stale) parts.push(`${n.stale} stale`);
  if (n.waiting) parts.push(`${n.waiting} waiting`);
  if (n.error) parts.push(`${n.error} failing: ${failing.join(', ')}`);
  return `sources: ${parts.join(', ')}`;
}

/** The Watch sources tab's rows (PW_SRC_HEADER_), one a source. `fails`: pwLaneFails_. Pure. */
function pwSourceRows_(all, today, now, fails) {
  return pwSources_().map(s => {
    const st = (all || {})[s.key] || null;
    const c = ((today && today.src) || {})[s.key] || [0, 0];
    return [s.name, s.what, s.bq || s.where || '', pwSourceStatus_(s, st, now, (fails || {})[s.lane]).text,
      pwText_(pwTime_(st && st.mod)), pwText_(pwTime_(st && st.newest)),
      st && st.at ? pwText_(`${fmtInt_(st.found)} / ${fmtInt_(st.checked)}${st.detail ? ` (${st.detail})` : ''}`) : '',
      c[0], c[1], pwText_(pwTime_(st && st.at))];
  });
}

/**
 * Rewrites the Watch sources tab's rows when something changed, and clears the rows below them that a tab made when
 * the watch read more sources still holds (the tab is the bot's own: pwSourcesTab_). The sources of a look that is
 * failing as a whole (pwLaneFails_) say so: `last` is the last looks (pwLast_) when the caller has read them, so they
 * are read once a run. Never throws.
 */
function pwWriteSources_(sh, props, now, last) {
  try {
    const rows = pwSourceRows_(pwSourceStats_(props), pwToday_(props, dayKey_()), now,
      pwLaneFails_(last === undefined ? pwLast_(props) : last));
    const range = sh.getRange(PW_SRC_HEAD_ROW_ + 1, 1, rows.length, PW_SRC_HEADER_.length);
    const current = range.getValues();
    if (rows.some((r, i) => r.some((c, j) => !pwSame_(c, (current[i] || [])[j])))) range.setValues(rows);
    const left = sh.getLastRow() - (PW_SRC_HEAD_ROW_ + rows.length);
    if (left > 0) sh.getRange(PW_SRC_HEAD_ROW_ + rows.length + 1, 1, left, PW_SRC_HEADER_.length).clearContent();
  } catch (e) {
    console.error('Proactive watch: couldn\'t write the Watch sources tab: ' + ((e && e.message) || e));
  }
}

// --------------------------------------------------------------------------------------------------------------
// The run's part: collect the waiting looks, send the next ones, score, and say how it's doing
// --------------------------------------------------------------------------------------------------------------

/** Today's numbers (PW_TODAY), today's day key `day`: {day, looks, checked, flagged, near, w, src}. */
function pwToday_(props, day) {
  let s = null;
  try { s = JSON.parse(props.getProperty(PW_DAY_PROP_) || 'null'); } catch (e) { s = null; }
  if (!s || s.day !== day) s = { day, looks: 0, checked: 0, flagged: 0, near: 0, w: {}, src: {} };
  if (!s.w || typeof s.w !== 'object') s.w = {};
  if (!s.src || typeof s.src !== 'object') s.src = {};
  return s;
}

/**
 * Column C of the switch, from today's numbers, the last looks (`last`: {at, checked, flagged, near}; `timeLabel`: when
 * the latest of them was collected) and the sources (`sources`: pwSourcesSummary_). While a look fails as a whole
 * (`fails`: pwLaneFails_) the note says so between the last look and today's counts, behind a warning sign (the cell
 * starts with the switch's tick): "⚠️ the look at Sonar and Tubular has failed since Oct 14, 8:04 AM EDT: <why>" (every
 * look failing: "⚠️ the looks at all 8 sources have failed since", from when the later of them began to, with its
 * reason, and no last look). It then stays within PW_NOTE_CHARS_, where a note is cut: the reason is shortened to the
 * room there is (never through a character: WatchAlerts.gs pwCut_), and when under PW_FAIL_WHY_MIN_ characters of it
 * would be left the last look's numbers go, then the last look; today's counts are never cut, and the sources follow
 * only when they fit whole. Pure.
 */
function pwNoteText_(today, last, timeLabel, sources, fails) {
  const at = last && last.at ? `last look ${timeLabel}` : '';
  const looked = at
    ? `${at}: ${fmtInt_(last.checked)} new post${last.checked === 1 ? '' : 's'}, ${fmtInt_(last.flagged)} flagged`
    : 'first look on its way';
  const counts = `today: ${fmtInt_(today.flagged)} flagged, ${fmtInt_(today.near)} near miss${today.near === 1 ? '' : 'es'}`;
  const tail = sources ? ` · ${sources} (Watch sources tab)` : ' (Watch detections tab)';
  const failing = PW_LANES_.map(l => l.key).filter(k => (fails || {})[k]);
  if (!failing.length) return `${looked} · ${counts}${tail}`;
  const f = failing.map(k => fails[k]).reduce((a, b) => (b.since > a.since ? b : a));
  const said = `⚠️ ${pwFailWords_(failing)} ${pwWhen_(f.since, true)}: `;
  const leads = failing.length >= PW_LANES_.length ? [''] : [`${looked} · `].concat(at ? [`${at} · `] : [], ['']);
  const room = lead => PW_NOTE_CHARS_ - lead.length - said.length - ' · '.length - counts.length;
  const lead = leads.find(l => !l || room(l) >= PW_FAIL_WHY_MIN_);
  const note = `${lead}${said}${pwCut_(f.why, Math.max(1, room(lead)))} · ${counts}`;
  return note.length + tail.length <= PW_NOTE_CHARS_ ? note + tail : note;
}

/**
 * The last looks with the lane's latest (`entry`), kept (PW_LAST): each lane's latest, and their sum. A look that failed
 * as a whole (`entry`: {fail: {since, why}}) leaves no numbers of the lane's last good look in the sum, and has failed
 * since the first try that did: an entry that already says so keeps its `since` and takes the new `why`. It keeps when
 * the lane's last good look was collected (`ok`, when it had one), for the Watches tab's "last look" (pwLastGoodAt_).
 */
function pwLastWith_(props, lane, entry) {
  let last = null;
  try { last = JSON.parse(props.getProperty(PW_LAST_PROP_) || 'null'); } catch (e) { last = null; }
  const lanes = Object.assign({}, (last && last.lanes) || {});
  if (entry.fail) {
    const was = pwLaneFails_(last)[lane.key] || null;
    const ok = was ? was.ok : Number((lanes[lane.key] || {}).at) || 0;
    lanes[lane.key] = { fail: Object.assign({ since: was ? was.since : entry.fail.since, why: entry.fail.why }, ok ? { ok } : {}) };
  } else {
    lanes[lane.key] = entry;
  }
  const sum = { at: 0, checked: 0, flagged: 0, near: 0, lanes };
  Object.keys(lanes).forEach(k => {
    const l = lanes[k] || {};
    sum.at = Math.max(sum.at, Number(l.at) || 0);
    sum.checked += Number(l.checked) || 0;
    sum.flagged += Number(l.flagged) || 0;
    sum.near += Number(l.near) || 0;
  });
  props.setProperty(PW_LAST_PROP_, JSON.stringify(sum));
  return sum;
}

/**
 * A lane's finished look: its rows recorded (`queue`: its flags at a watch's bar wait to be posted as watch alerts,
 * pwDetections_), its window marked done (the next starts at its end; a window source's error keeps it, so that window
 * is looked at again), its sources' marks and last looks, today's numbers and the switch's note updated. {added,
 * flagged, near}.
 */
function pwDone_(props, sh, lane, job, results, now, queue) {
  const rows = (results || []).filter(Boolean);
  const stats = rows.filter(r => r.kind === 'src');
  const rec = pwRecord_(sh, rows.filter(r => r.kind !== 'src' && r.kind !== 'amk'), Number(job.since) || 0, queue);
  if (rows.some(r => r.kind === 'amk')) pwAmieKeysAdd_(rows.filter(r => r.kind === 'amk').map(r => r.why), now);  // (row 50 ON)
  const windowErr = stats.some(r => r.err && (pwSource_(r.source) || {}).window);
  if (!windowErr) props.setProperty(lane.sinceProp, String(job.until));
  else if (!Number(props.getProperty(lane.sinceProp))) props.setProperty(lane.sinceProp, String(job.since));
  props.deleteProperty(lane.triesProp);
  props.setProperty(PW_MARKS_PROP_, JSON.stringify(pwAdvanceMarks_(pwMarks_(props), stats, Number(job.until) || 0)));
  const sources = pwSourcesAfter_(pwSourceStats_(props), stats, rec.bySource, now);
  props.setProperty(PW_SOURCES_PROP_, JSON.stringify(sources));
  const checked = stats.reduce((n, r) => n + (Number(r.checked) || 0), 0);
  const today = pwToday_(props, dayKey_());
  today.looks++;
  today.checked += checked;
  today.flagged += rec.flagged;
  today.near += rec.near;
  Object.keys(rec.byWatch).forEach(w => {
    const c = today.w[w] || [0, 0];
    today.w[w] = [c[0] + rec.byWatch[w][0], c[1] + rec.byWatch[w][1]];
  });
  stats.forEach(r => {
    if (!pwSource_(r.source)) return;
    const c = today.src[r.source] || [0, 0];
    today.src[r.source] = [c[0] + (Number(r.checked) || 0), c[1] + ((rec.bySource[r.source] || [0])[0])];
  });
  props.setProperty(PW_DAY_PROP_, JSON.stringify(today));
  const last = pwLastWith_(props, lane, { at: now, checked, flagged: rec.flagged, near: rec.near });  // it no longer fails
  const fails = pwLaneFails_(last);  // the other lane's look may be failing still: the note keeps saying so
  noteSwitch_('proactiveWatch', pwNoteText_(today, last, nowLabel_(), pwSourcesSummary_(sources, now, fails), fails));
  if (rec.added) console.log(`Proactive watch (${lane.location}): ${checked} new posts checked, ${rec.flagged} flagged, ${rec.near} near misses`);
  stats.filter(r => r.err && pwSource_(r.source))
    .forEach(r => console.warn(`Proactive watch: ${pwSource_(r.source).name} failed at the last look: ${r.err}`));
  return rec;
}

/**
 * A lane's look that failed as a whole (`why`): tried again at its next look, or skipped after PW_MAX_TRIES_ (its window
 * marked done, and its sources' marks moved past it, so one bad window can't stop the watch; the log says so). Either
 * way the failure is kept on the lane's entry of the last looks (pwLastWith_: since when, and why) until a look of the
 * lane succeeds again (pwDone_): until then C34 says so (pwNoteText_), and the Watch sources tab shows the lane's
 * sources as failing (pwSourceStatus_).
 */
function pwFailed_(props, lane, job, why) {
  const tries = (Number(job.tries) || 0) + 1;
  const what = pwCut_(String((why && why.message) || why || 'unknown'), 160);  // never through a character (WatchAlerts.gs)
  const names = pwLaneNames_(lane.key);
  console.warn(`Proactive watch: the look at ${names} for ${pwTime_(job.since)}-${pwTime_(job.until)} failed (try ${tries}): ${what}`);
  if (tries >= PW_MAX_TRIES_) {
    props.setProperty(lane.sinceProp, String(job.until));
    props.deleteProperty(lane.triesProp);
    const marks = pwMarks_(props);
    pwLaneSources_(lane.key).forEach(s => {
      if (s.window) return;
      marks[s.key] = Math.max(Number(marks[s.key]) || 0, Number(job.until) || 0);
      delete marks[`${s.key}_snap`];  // a batch it was handing over goes with the window
    });
    props.setProperty(PW_MARKS_PROP_, JSON.stringify(marks));
    console.warn(`Proactive watch: skipped ${pwTime_(job.since).slice(11)}-${pwTime_(job.until).slice(11)} for ${names} ` +
      `after ${tries} tries; the next look carries on`);
  } else {
    props.setProperty(lane.triesProp, String(tries));
    if (!Number(props.getProperty(lane.sinceProp))) props.setProperty(lane.sinceProp, String(job.since));  // retried from its start
  }
  const now = Date.now();
  // what C34 and the Watch sources tab say is why in plain words (pwPlainWhy_); the error's own text is in the log above
  const last = pwLastWith_(props, lane, { fail: { since: now, why: pwPlainWhy_(what) } });
  const fails = pwLaneFails_(last);
  noteSwitch_('proactiveWatch', pwNoteText_(pwToday_(props, dayKey_()), last, last.at ? pwWhen_(last.at, true) : '',
    pwSourcesSummary_(pwSourceStats_(props), now, fails), fails));
}

/**
 * Collects a lane's waiting look: recorded when done (`queue`: pwDone_), cancelled (a failed try) after
 * PW_JOB_MAX_MS_. Rows added.
 */
function pwCollect_(props, sh, lane, queue) {
  const job = pwJob_(props, lane);
  if (!job) return 0;
  let res = null;
  try {
    res = pwFetch_(job);
  } catch (e) {
    props.deleteProperty(lane.jobProp);
    pwFailed_(props, lane, job, e);
    return 0;
  }
  if (res && res.jobComplete) {
    props.deleteProperty(lane.jobProp);
    return pwDone_(props, sh, lane, job, parseBqRows_(res), Date.now(), queue).added;
  }
  if (res && Date.now() - Number(job.at) > PW_JOB_MAX_MS_) {
    pwCancel_(job);
    props.deleteProperty(lane.jobProp);
    pwFailed_(props, lane, job, `BigQuery took more than ${Math.round(PW_JOB_MAX_MS_ / 60000)} minutes`);
  }
  return 0;
}

/** Column H of each watch's row: whether it's watched, and today's numbers. Writes only what changed. Never throws. */
function pwWriteStatuses_(sh, watches, today, lastAt) {
  try {
    if (!watches.length) return;
    const active = new Set(pwActive_(watches).map(w => w.name));
    const firstRow = 2;
    const lastRow = Math.max.apply(null, watches.map(w => w.row));
    const range = sh.getRange(firstRow, PW_STATUS_COL_, lastRow - firstRow + 1, 1);
    const current = range.getValues().map(r => String(r[0] === undefined || r[0] === null ? '' : r[0]));
    const next = current.slice();
    watches.forEach(w => {
      const c = (today.w || {})[w.name] || [0, 0];
      next[w.row - firstRow] = !w.on ? 'OFF: not watched'
        : w.problem ? `⚠️ not watched: ${w.problem}`
          : !active.has(w.name) ? `⚠️ not watched: only the first ${PW_MAX_WATCHES_} watches ON (each name once) are watched`
            : `✓ watched · today: ${fmtInt_(c[0])} flagged, ${fmtInt_(c[1])} near miss${c[1] === 1 ? '' : 'es'}` +
              (lastAt ? ` · last look ${lastAt}` : '');
    });
    if (next.some((v, i) => v !== current[i])) range.setValues(next.map(v => [v]));
  } catch (e) {
    console.error('Proactive watch: couldn\'t write the watches\' status: ' + ((e && e.message) || e));
  }
}

/**
 * Proactive watch (Control row 34, OFF unless switched ON), once a run from Main.gs poll()'s finally while the bot is
 * ON: makes its three tabs the first time, collects each lane's look that's waiting (its rows go on the Watch
 * detections tab), sends each lane's next look when one is due (PW_EVERY_MS_, the window from where its last one
 * ended), posts the flags waiting to go out as watch alerts (Control row 35, WatchAlerts.gs: `opts.alerts`, this run's
 * pwAlertsDest_; C35 in `opts.control` says how it's going), refreshes the scorecard (PW_SCORE_EVERY_MS_, or right
 * after new rows) and writes the Watch sources tab, the watches' status and the switch's column C. Nothing with less
 * than PW_MIN_LEFT_MS_ of the run left (before RUN_HARD_STOP_MS_). Posts nothing anywhere but those watch alerts. Never
 * throws. Returns {added, sent, alerts} (null when it didn't run).
 */
function runProactiveWatch_(ss, runStart, opts) {
  try {
    const left = () => Number(runStart) + RUN_HARD_STOP_MS_ - Date.now();
    if (left() < PW_MIN_LEFT_MS_) return null;
    const dest = (opts && opts.alerts) || null;
    const queue = !!(dest && dest.choice);  // Watch alerts chosen (row 35): the new flags at a bar wait to be posted
    const props = PropertiesService.getScriptProperties();
    if (props.getProperty(PW_PAUSED_PROP_)) {  // the bot was paused: nothing from then is looked at
      pwReset_(props);
      props.deleteProperty(PW_PAUSED_PROP_);
    }
    const wt = pwWatchesTab_(ss, true);
    if (wt.foreign) {
      noteSwitch_('proactiveWatch', `⚠️ not watching: a tab named "${PW_WATCHES_TAB_}" exists that the bot didn't make ` +
        '(rename it and the bot makes its own)');
      return null;
    }
    const dt = pwDetectionsTab_(ss, true);
    if (dt.foreign) {
      noteSwitch_('proactiveWatch', `⚠️ not watching: a tab named "${PW_DET_TAB_}" exists that the bot didn't make ` +
        '(rename it and the bot makes its own)');
      return null;
    }
    const st = pwSourcesTab_(ss, true);  // a tab of that name people made is left alone; the watch carries on
    if (st.foreign) console.warn(`Proactive watch: a tab named "${PW_SRC_TAB_}" exists that the bot didn't make: left alone`);
    const watches = pwWatches_(wt.sh);
    const active = pwActive_(watches);
    const out = { added: 0, sent: false, alerts: null };
    PW_LANES_.forEach(lane => {  // 1. the looks sent earlier
      if (left() >= PW_MIN_LEFT_MS_) out.added += pwCollect_(props, dt.sh, lane, queue);
    });
    if (!active.length) {  // nothing to look for: nothing builds up meanwhile either
      PW_LANES_.forEach(l => { props.deleteProperty(l.sinceProp); props.deleteProperty(l.triesProp); });
      props.deleteProperty(PW_LAST_PROP_);
      props.deleteProperty(PW_MARKS_PROP_);
      noteSwitch_('proactiveWatch', `waiting: no watch is ON (set a watch's On to ON on the ${PW_WATCHES_TAB_} tab)`);
    } else if (typeof apiGuardAllowBackground_ !== 'function' || apiGuardAllowBackground_('any', !!(opts && opts.slaBusy))) {
      let alerts = null;  // the Alert log's newest rows, read once, when the US look goes out
      let first = false;
      let failed = false;  // a failure's note stays: the first look's note doesn't cover it up
      // (row 50 ON: the AMIE table's check, hourly, before the US look reads it; a table it can't read stops it alone)
      if (pwSources_().some(s => s.key === 'amie')) pwAmieCheck_(props, Date.now());
      PW_LANES_.forEach(lane => {  // 2. each lane's next look, when it's due
        if (left() < PW_MIN_LEFT_MS_ || pwJob_(props, lane)) return;
        const now = Date.now();
        const lastSent = Number(props.getProperty(lane.atProp)) || 0;
        const until = now - PW_SETTLE_MS_;
        const kept = Number(props.getProperty(lane.sinceProp)) || 0;
        const since = Math.max(kept > 0 ? kept : until - PW_START_MS_, until - PW_MAX_WINDOW_MS_);
        if (!((!lastSent || now < lastSent || now - lastSent >= PW_EVERY_MS_) && until - since >= PW_MIN_WINDOW_MS_)) return;
        props.setProperty(lane.atProp, String(now));  // first: a failing send isn't tried again every minute
        const sent = { since, until, at: now, tries: Number(props.getProperty(lane.triesProp)) || 0 };
        try {
          const froms = Object.assign(pwFroms_(pwMarks_(props), until, pwToday_(props, dayKey_())),  // today's: each day's maximum
            lane.key === 'us' ? pwAmieFroms_(props, Date.now()) : {});  // (row 50 ON: the AMIE table's columns and keys)
          let chat = [];
          if (pwLaneSources_(lane.key).some(s => s.key === 'chat')) {
            if (!alerts) alerts = pwRecentAlerts_(ss);
            chat = pwChatItems_(alerts, froms.chat, until);
          }
          // the Brandwatch query: what Brandwatch added since the last look, read right before the look goes out
          const bwq = pwLaneSources_(lane.key).some(s => s.key === 'bwq')
            ? pwBwqItems_(froms.bwq, until, left) : { rows: [], err: '' };
          const res = pwSubmit_(pwSql_(lane.key, active, { since, until, froms, chat, bwq: bwq.rows, bwqErr: bwq.err }), lane);
          const ref = (res && res.jobReference) || {};
          out.sent = true;
          if (res && res.jobComplete) {
            out.added += pwDone_(props, dt.sh, lane, sent, parseBqRows_(res), Date.now(), queue).added;
          } else if (ref.jobId) {
            props.setProperty(lane.jobProp, JSON.stringify(Object.assign(sent,
              { id: ref.jobId, project: ref.projectId || GCP_PROJECT, location: ref.location || lane.location })));
            if (!props.getProperty(PW_LAST_PROP_) && !sent.tries) first = true;
          } else {
            failed = true;
            pwFailed_(props, lane, sent, 'BigQuery gave no job to collect');
          }
        } catch (e) {
          failed = true;
          pwFailed_(props, lane, sent, e);
        }
      });
      if (first && !failed) {
        noteSwitch_('proactiveWatch', `first look sent ${nowLabel_()} (${active.length} watch${active.length === 1 ? '' : 'es'}, ` +
          `${pwSources_().length} sources); its results come in a minute or two`);
      }
    }
    // 3. the flags waiting to go out as watch alerts (Control row 35, WatchAlerts.gs), a few a run, only while some wait
    // (PW_ALERT_PENDING: nothing is read otherwise); C35 says how it's going
    if (queue && left() >= PW_MIN_LEFT_MS_ && props.getProperty(PW_ALERT_PENDING_PROP_)) {
      out.alerts = pwPostAlerts_(dt.sh, dest, Date.now(), left, {
        ss, otherBusy: !!(opts && opts.otherBusy), acBusy: !!(opts && opts.acBusy),
      });
      if (!out.alerts.error && !out.alerts.waiting) props.deleteProperty(PW_ALERT_PENDING_PROP_);
    }
    if (opts && opts.control) {
      try {
        writeWatchAlertsNote_(opts.control, pwAlertsNoteText_(dest || { choice: '' }, out.alerts, true, pwAlertDay_(0),
          pwAlertDayGrouped_(), pwAlertDayMore_(), !active.length));
      } catch (e) {
        console.error('could not write C35 (Watch alerts): ' + ((e && e.message) || e));
      }
    }
    // 4. the scorecard: right after new rows, else every PW_SCORE_EVERY_MS_ (none while the tab has no rows yet)
    const scoredAt = Number(props.getProperty(PW_SCORE_AT_PROP_)) || 0;
    if (left() >= PW_MIN_LEFT_MS_ && dt.sh.getLastRow() > PW_DET_HEAD_ROW_ &&
      (out.added || !scoredAt || Date.now() - scoredAt >= PW_SCORE_EVERY_MS_)) {
      pwRefreshScorecard_(ss, dt.sh, Date.now());
    }
    const last = pwLast_(props);  // read once, for the Watch sources tab and the watches' status
    if (st.sh) pwWriteSources_(st.sh, props, Date.now(), last);
    // the latest look that worked, also while every look fails (C34 and the Watch sources tab say that they do)
    const goodAt = pwLastGoodAt_(last);
    const lastAt = goodAt ? Utilities.formatDate(new Date(goodAt), GEN.timezone, 'h:mm a') : '';
    pwWriteStatuses_(wt.sh, watches, pwToday_(props, dayKey_()), lastAt);
    return out;
  } catch (e) {
    console.error('Proactive watch: ' + ((e && e.stack) || e));
    try { noteSwitch_('proactiveWatch', `⚠️ ${truncate_(String((e && e.message) || e), 160)} (it tries again next run)`); } catch (err) {}
    return null;
  }
}
