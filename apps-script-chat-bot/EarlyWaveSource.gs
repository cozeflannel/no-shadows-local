/**
 * EarlyWaveSource.gs — the bot's own early-wave producer (Control row 19, Early wave & velocity check): low-tier
 * embedding clusters and velocity spikes built in Apps Script from the approved BigQuery tables only. BigQuery.gs
 * bqEarlyDetectionRows_ (the one read earlyWaveCheck_ makes) returns ewsRows_, in the same EarlyWaveRow shape the
 * signals always had, so the queue, the same-story dedup, the review and the story card (EarlyDetection.gs) are unchanged.
 *
 * Sources (read-only; nothing else is read on this path):
 *   us-central1  bsip-s-bsip-gg-26-2cf3.google_bg.sonar_raw             real time: posts Sonar first saw since the last check
 *                google_tubular_mentions.tubular_videos                   slow lane: videos first seen since the last read (6 hours)
 *   US           reporting_data.sprinklr_inbound_comments                 real time: comments on Google's posts appended since
 *                raw_data.brandwatch_raw_mentions_base                    slow lane: yesterday's batch, read once after it loads
 *                reporting_data.sprinklr_outbound_reporting               Google's own accounts (their posts are left out)
 *                DSD.DSD-story-selection                                  posts already alerted (HIGH / KOF) and KOF authors (left out)
 *   US, own job  social_alerts_dataset.all_sundar_mentions (the AMIE table) only while Control row 48 is ON: Brandwatch's
 *                alert feeds, X posts with their words (approved by the owner on 16 November 2026, for this read)
 * (all in brand-social-central-data except sonar_raw). One BigQuery job a location a check (cross-region joins can't be
 * made, so the US lane's exclusions are applied here to both lanes), each a temporary result, never a write.
 *
 * A check (at most every EWS_EVERY_MS_, inside earlyWaveCheck_'s own 15-minute throttle):
 *   1. Ingest with the old pipeline's gates (analytics/early_detection/02): low tier (5,000 followers or fewer, or
 *      unknown; under 500 engagements; not a KOF), not positive, English (language tag and script, or English words for
 *      comments and video titles), no Grok / AutoModerator / [deleted], no homonym or spam, a clean text of 40+ characters
 *      with 7+ tokens (5+ distinct), posted within 24 hours (slow lanes 72); each post's content hash, same-author
 *      signature and risk-term groups. Real time is Sonar's first-seen posts and Sprinklr's comments (Google's own replies
 *      left out); the slow lanes (Brandwatch, Tubular) only ever join a story that already exists.
 *   2. Embed only posts not seen before (Vectors.gs embedTexts_, text-embedding-005, SEMANTIC_SIMILARITY; the same text
 *      reuses the vector it already has), EWS_EMBED_PER_CHECK_ a check and EWS_EMBED_PER_DAY_ a day (risk terms first,
 *      then the most shared texts, then the newest); drop evergreen noise (vecEvergreenOfVecs_, the 16 DSD topics).
 *   3. Cluster incrementally (analytics/early_detection/03): join the nearest active story centroid (EWS_JOIN_SIM_), else
 *      look for new stories around the new posts in the 6-hour pool of unassigned posts (EWS_START_SIM_, an anchor needs
 *      2+ distinct authors among its EWS_TOP_K_ neighbours). Centroids, members and the pool live in the script cache as
 *      a few packed items (vecEncode_), never one item a post.
 *   4. Promote a story (03) with 5+ distinct accounts (4 on 2+ platforms) and 2+ links within 180 minutes, not a copy-paste
 *      ring that never names Google, not within its 6-hour cooldown; one story told twice (centroids within EWS_STORY_SIM_
 *      of one alerted in the last 24 hours) goes out only as an update (2x the accounts and 3 more, or a new platform).
 *   5. Velocity (04): distinct accounts in the last 60 minutes per cluster, risk-term group and topic, against
 *      max(same hour over 7 days, half the last 6 hours) + 2: a spike at 3x, or 12 more accounts than usual (4+ accounts
 *      for a cluster, 8+ otherwise); 24 hours of history first; 3-hour cooldown unless it grew 1.75x.
 *   6. Each signal's nearest official Exposure Tag / Sensitive Topic (vecTagHintsOfVecs_) rides along as a hint
 *      (taxonomy_hint) and can lift a P2 signal to P1 (EWS_TAG_RAISE_SIM_); the review still picks the tag.
 *   7. New signals go into a 3-hour buffer with a stable alert_id; ewsRows_ returns the buffer's signals created in the
 *      last `minutes` (at most EW_QUERY_MAX_ROWS_, P0 > P1 > P2, then velocity, accounts, oldest first), so a signal the
 *      check didn't take (5 a check, 40 a day) is there again next check, and the 24-hour seen map skips the rest.
 *   8. The early watch, only when the caller asks for it (earlyWaveCheck_ with the fast triage and its ranking ON,
 *      Control rows 38 and 39; without it nothing in this step runs). Stories still below the promotion bar are
 *      picked (ewsWatchPick_): the distinct-accounts watch bar (Control row 45, seed 3) or more in the 180 minutes,
 *      2+ links, not a copy-paste ring, not signalled within the cooldown, not a story already told, and one of: a
 *      risk-term group, an official Exposure Tag within EWS_TAG_RAISE_SIM_, or no older stored story within
 *      EWS_STORY_SIM_. Once the check's state is saved, the caller's fast triage is asked about each
 *      (EWS_WATCH_MAX_PER_CHECK_ a check, EWS_WATCH_MAX_PER_DAY_ a day, each story once at a given size), and a story
 *      is raised (ewsWatchRaise_) when about_google and brand_risk are each at or above the watch bar (Control row 44,
 *      seed 0.80), independent_reports is at or above its own bar (Control row 47, seed 0.30), the answer's confidence
 *      is at or above the confidence bar (Control row 43, seed 0.55; an answer without a confidence raises nothing),
 *      and its most probable severity level is EWS_WATCH_MIN_LEVEL_ or higher: it goes into the buffer as
 *      an EARLY_WATCH signal with its answers, to be queued, deduplicated and fully reviewed like any other. Raising
 *      it marks nothing as alerted here, so the story still makes its usual signal at the promotion bar (which the
 *      same-story dedup puts in the early card's thread). With the fast triage running, the caller also gets each
 *      signal's risk-term groups and whether a taxonomy hint raised it (`risk_groups`, `tag_raised`), which the fast
 *      triage needs to know what it may never hold back; without the fast triage every row is as it always was.
 *
 * Similarity bars (cosine, SEMANTIC_SIMILARITY vectors after the int8 round trip), calibrated on real low-tier texts:
 * 1,198 posts (700 Sonar + 498 Sprinklr comments, Nov 11 07:00-13:00 UTC) and 3,900 (2,500 + 1,400, Nov 10
 * 14:00-20:00 UTC), embedded with the production endpoint and read pair by pair:
 *   - unrelated pairs: median 0.50, p99 0.66, p99.9 0.75; copies and near-copies 0.92+.
 *   - EWS_START_SIM_ 0.80: in [0.80, 0.82) the pairs were the same story (Chrome CVE-2026-125350 posts, EU court adviser
 *     on publishers, SerpApi ruling, Initia hack, Gemini 4 Carbon benchmarks, YouTube GIF requests) bar format look-alikes
 *     (two Sonar "A screenshot of a Google search result..." descriptions, 0.854); [0.75, 0.78) was half topical only
 *     (AI-search SEO videos, 2FA how-tos), so the bar sits above it.
 *   - EWS_JOIN_SIM_ 0.82 (post to a story's centroid): members' leave-one-out similarity to their own centroid p05
 *     0.820 (Nov 11) and 0.835 (Nov 10); the nearest wrong join seen was 0.798 (an unrelated crypto post onto the Initia
 *     hack); joins at 0.82+ were the same story or its comment thread.
 *   - EWS_STORY_SIM_ 0.83 (centroid to centroid): pieces of one story scored 0.83-0.95 (Carbon launch 0.828-0.941,
 *     Chrome CVE 0.831-0.933, GIF campaign 0.86-1.00, Gemini reading Gmail 0.911); the highest pair of different
 *     stories was 0.800 ("ChatGPT business profiles" vs "AI Overviews cut clicks"; Initia vs Keplr hacks 0.777).
 *   - EWS_TAG_RAISE_SIM_ 0.70 (centroid to an official Exposure Tag): story centroids scored 0.54-0.79 against their
 *     nearest tag; at 0.70+ the nearest tag fit 5 of 6 stories (Chrome zero-day: Product - Privacy & security concerns
 *     0.719, account lockouts 0.732, scams 0.786), while wrong P0 nearest tags stayed at 0.67 or less (GIF campaign
 *     0.670, Initia 0.634, ads surcharges 0.649), so a hint never makes a P0 by itself.
 *
 * Early-watch bars (Control rows 43-45 and 47, FastTriage.gs FT_BAR_SPECS_):
 *   - Distinct accounts (Control row 45, seed EWS_WATCH_MIN_AUTHORS_ = 3): in the old pipeline's clusters (Nov 6-11,
 *     2026, six days) 25 to 64 stories a day reached 3 accounts within 180 minutes and 90 to 161 reached 2; 44% of
 *     those at 3 went on to 5, against 15% of those at 2; going from 3 to 5 took 76 to 105 minutes (median) on 4 of
 *     the 6 days.
 *   - EWS_WATCH_MIN_LEVEL_ 2 (medium and up): the upper three of ED_SEVERITIES_' five levels.
 *   - Probability bars: about_google and brand_risk at or above row 44 (seed 0.80), independent_reports at or above
 *     row 47 (seed 0.30), answer confidence at or above row 43 (seed 0.55). On the three real risk signals of
 *     Nov 6-12, 2026 (test/decisions_fixtures.json) about_google and brand_risk were 0.94 or more, while
 *     independent_reports was 0.62, 0.31 and 0.13 and confidence 0.78, 0.56 and 0.80: one bar of 0.80 for all of them
 *     raised none. At these seeds two of the three are raised, and none of the five noise signals.
 *
 * State: script properties EWS_STATE (cursors, a job left running, today's counts, the last check's numbers) and
 * EWS_ROLLUP (velocity: same-hour means and the last 6 hours per topic / risk group, cooldowns), each under 9 KB; the
 * script cache (6 h): clusters, the pool, the last hours' accounts, same-author signatures, exclusions, the alerted
 * stories and the 3-hour buffer, all packed under 100 KB an item (about 60 items at most). Losing the cache only costs
 * continuity (stories and the pool start again), never an error. Nothing here writes to BigQuery, a sheet or a space.
 *
 * New lanes (more sources, each behind its own Control row, OFF by default; the AMIE table is the first, row 48, read by
 * its own job in the same fetchAll: see "The AMIE table" below): a new source's job is
 * one more entry of ewsLanes_ in the same fetchAll, its posts come in under the lanes EWS_NEW_LANES_ (marked nl) and,
 * only while one of their switches is ON (ewsRunSwitches_), follow their own rules: no velocity, a share of the pool
 * and of embedding with a day bar and a carry ('carry'), their own same-author signatures ('sn:N'), stitching against
 * every other source by post key (ewsStitch_, index 'nk:N'), their own account names (ewsNewAuthor_), three limits at
 * promotion and a trial for the stories only they lift (ewsLiftGate_), and a day record (property EWS_SRC_DAY). With
 * every new switch OFF none of this runs and nothing of it is read or written, but for one thing: while stories still
 * hold a new lane's posts from before the row went OFF (they age out within 24 hours), the promotion limits and the
 * trial keep applying to them.
 */

// ---------------------------------------------------------------------------------------------------------------
// Sources, timing and ceilings
// ---------------------------------------------------------------------------------------------------------------

const EWS_SONAR_TABLE_ = 'bsip-s-bsip-gg-26-2cf3.google_bg.sonar_raw';                            // us-central1
const EWS_TUBULAR_TABLE_ = 'brand-social-central-data.google_tubular_mentions.tubular_videos';       // us-central1
const EWS_COMMENTS_TABLE_ = 'brand-social-central-data.reporting_data.sprinklr_inbound_comments';    // US
const EWS_BRANDWATCH_TABLE_ = 'brand-social-central-data.raw_data.brandwatch_raw_mentions_base';     // US
const EWS_OUTBOUND_TABLE_ = 'brand-social-central-data.reporting_data.sprinklr_outbound_reporting';  // US
const EWS_STORY_TABLE_ = 'brand-social-central-data.DSD.DSD-story-selection';                      // US
const EWS_TABLES_ = [EWS_SONAR_TABLE_, EWS_TUBULAR_TABLE_, EWS_COMMENTS_TABLE_, EWS_BRANDWATCH_TABLE_,
  EWS_OUTBOUND_TABLE_, EWS_STORY_TABLE_];
const EWS_LANES_ = [{ key: 'us', location: 'US' }, { key: 'c1', location: 'us-central1' }];
// New lanes (more sources, each behind its own Control row, OFF by default). A lane name decides how its posts are
// treated: the slow lanes only ever join a story that already exists (72 hours of age, never in the pool); the new lanes
// (`ami` the AMIE table, `bwl` Brandwatch live; `amis` / `bwls` their posts first seen more than
// early_wave_new_late_minutes after posting) are marked `nl` and kept apart where the rules below say.
const EWS_SLOW_LANES_ = ['bw', 'tub', 'amis', 'bwls'];
const EWS_NEW_LANES_ = ['ami', 'amis', 'bwl', 'bwls'];
// The new sources' jobs, one entry each, added by the step that builds the source: {key (the job's name, as 'us' /
// 'c1'), location, sw (its Control switch key), ready(st) (optional: false = nothing to read this check),
// query(st, until, firstMins) -> {sql, params, win, flags, maxBytes?} (pure; null = nothing to read), done(st, lane,
// now, nx) (optional: the job was collected, move its mark), failed(st, lane, now) (optional: the job failed), src
// ('ami' | 'bwl': whose trial and day counts)}. ewsLanes_ adds an entry only while its switch is ON. A new lane's post
// ids start with its source and a pipe ('AMI|…', 'BWL|…'). checks(st, now, deadline) (optional): the source's own
// checks, made at the end of a check while its switch is ON, after today's lanes were read and embedded, so a slow
// answer never costs them their posts. The AMIE table (row 48): ready() sends nothing (ewsAmiReady_); its checks (the
// metadata hourly, a dry run daily and after a failure) are ewsAmiChecks_, and its job goes out at the next check.
const EWS_NEW_LANE_DEFS_ = [
  { key: 'ami', location: 'US', sw: 'edAmie', src: 'ami', ready: st => ewsAmiReady_(st, Date.now()),
    query: (st, until) => ewsAmiQuery_(st, until, ewsBwlSkipNets_()), done: (st, lane, now, nx) => ewsAmiDone_(st, lane, now, nx),
    failed: (st, lane, now, nx) => ewsAmiFailed_(st, lane, now, nx), checks: (st, now, deadline) => ewsAmiChecks_(st, now, deadline) },
  // Brandwatch live (row 49, BrandwatchLive.gs): its job goes out only while a parcel the reader left waits for it
  { key: 'bwl', location: 'US', sw: 'edBwLive', src: 'bwl', ready: () => ewsBwlReady_(),
    query: (st, until) => ewsBwlLaneQuery_(until), done: (st, lane, now, nx) => ewsBwlDone_(st, lane, now, nx),
    failed: (st, lane, now, nx) => ewsBwlFailed_(st, lane, now, nx) },
];
const EWS_NEW_SWITCHES_ = { edAmie: 'ami', edBwLive: 'bwl' };  // a new source's Control switch -> the source
// Each new source's marks in EWS_STATE's `marks`, forgotten when its row is OFF (ewsNewSourceOff_); the step that
// builds a source adds its own here ('ami': the newest ingestion time taken from the AMIE table; 'amiq': the AMIE
// table's checks, a stop or a pause and why, so ON again checks the table afresh)
const EWS_SRC_MARKS_ = { ami: ['ami', 'amiq'], bwl: [] };  // (Brandwatch live keeps its marks in BWL_STATE: BrandwatchLive.gs)
// The AMIE table (Control row 48; "ami" in code): Brandwatch's alert feeds, X posts with their words, read only
const EWS_AMI_TABLE_ = 'brand-social-central-data.social_alerts_dataset.all_sundar_mentions';  // US
// The columns the AMIE job needs (a column missing or of another type stops it for the day), and the ones it reads when
// they are there (missing, or of a type it can't use: read as empty)
const EWS_AMI_NEEDED_ = { url: 'STRING', alert_source: 'STRING', snippet: 'STRING', authorHandle: 'STRING',
  SocialNetwork: 'STRING', Sentiment: 'STRING', postTime: 'TIMESTAMP', ingestionTimestamp: 'TIMESTAMP' };
const EWS_AMI_OPTIONAL_ = { followers: ['STRING', 'INTEGER', 'INT64', 'FLOAT', 'FLOAT64', 'NUMERIC', 'BIGNUMERIC'],
  KOF: ['STRING'], product: ['STRING'], engagement: ['STRING'] };
// The old pipeline's Google feeds (analytics/early_detection 01, BMIE_GOOGLE_FEEDS): their posts need no Google word
const EWS_AMI_GOOGLE_FEEDS_RX_ = '^(chrome overall|chrome execs|chrome kofs|slrr kofs chrome mentions|this week in android|' +
  'google spikes|apac google|all sundar|search|gemini|antigravity|ai digest - google|googlers posting on x|google reps & execs|v2 policy.*)$';
const EWS_AMI_KOF_RX_ = '(?i)^(yes|true|1)|\\b(KOFs?|INFs?|KOLs?)\\b';  // the KOF column read as a KOF (the old pipeline's test)
const EWS_AMI_STAFF_RX_ = 'kof|kol|\\binfs?\\b|exec|googler|reps|posts by google';  // amie_staff_feeds_rx's default
const EWS_AMI_FIRST_MS_ = 60 * 60 * 1000;      // a first read (or after the row was OFF) starts an hour back
const EWS_AMI_MAX_BACK_MS_ = 6 * 3600 * 1000;  // never more than 6 hours back
// The overlap's rows read again at most (its newest: late rows land close to the mark). A read's posts are never cut
// after that: each lane may return as many posts as rows were taken (amie_rows_per_check + this), so a new row's post
// is never pushed out by a repeat from the overlap
const EWS_AMI_OVERLAP_ROWS_ = 2000;
const EWS_AMI_CHECK_MS_ = 60 * 60 * 1000;      // the table's metadata is read again this often
const EWS_AMI_PAUSE_MS_ = 60 * 60 * 1000;      // a failed read pauses the AMIE table this long (then a dry run first)
// The AMIE table's checks (each a call that may be slow) start only with this much of the check's time left; else at
// the next check
const EWS_AMI_ROOM_MS_ = 10 * 1000;
const EWS_NEW_DAY_CAP_ = 15000;            // new lanes embed only while the day's total is under min(this, the day's pace)
const EWS_CARRY_MS_ = 2 * 3600 * 1000;     // a new lane's post not embedded is carried to the next checks this long
const EWS_SRC_DAY_PROP_ = 'EWS_SRC_DAY';   // the new sources' day record: first ON date, counts per day (7 days), lifted stories
const EWS_SRC_DAYS_KEPT_ = 7;
const EWS_SN_MAX_ = 20000;               // the new lanes' same-author signatures kept at most (about 2 cache items)
const EWS_NK_MS_ = 72 * 3600 * 1000;       // the new-lane post-key index keeps 72 hours at most (the slow lanes' age gate)...
const EWS_NK_MAX_ = 12000;                 // ...and this many keys (about 4 cache items): at a busy hour that is a few hours
const EWS_NK_RECORD_ = 1000;               // keys a record (three records to a cache item)
const EWS_NK_TODAY_MIN_ = 3000;            // today's lanes' keys kept at least (about one check's); the new lanes' come first
const EWS_XB_MS_ = 24 * 3600 * 1000;       // the keys of big posts Sonar knew (cache 'xb') count this long
const EWS_XA_MS_ = 7 * 24 * 3600 * 1000;   // the new lanes' excluded authors (cache 'ak') count this long
const EWS_LIFTED_KEPT_ = 20;               // stories only the new sources lifted, listed for the New sources tab

const EWS_EVERY_MS_ = 10 * 60 * 1000;      // a check at most this often (earlyWaveCheck_ calls every 15 min or more)
const EWS_BUDGET_MS_ = 40 * 1000;          // a check's whole time: BigQuery, embeddings, clustering, the cache
const EWS_BQ_WAIT_MS_ = 20 * 1000;         // how long a check waits for its two BigQuery jobs (a later check collects them)
const EWS_JOB_MAX_MS_ = 30 * 60 * 1000;    // a job not done after this is given up and its window read again
const EWS_SETTLE_MS_ = 60 * 1000;          // the last minute waits for the next check (rows still landing)
const EWS_FIRST_MS_ = 60 * 60 * 1000;      // a first check reads the last hour
const EWS_MAX_WINDOW_MS_ = 2 * 3600 * 1000;  // never more than 2 hours at once: no backlog after a pause
const EWS_MAX_BYTES_ = String(5 * 1024 * 1024 * 1024);  // BigQuery refuses a job reading more (usual: 0.2-0.9 GB)
const EWS_RT_MAX_ROWS_ = 1500;             // real-time posts a lane a check (risk terms first, then the newest)
const EWS_SLOW_MAX_ROWS_ = 600;            // slow-lane posts a read (Brandwatch's day, Tubular's new videos)
const EWS_SLOW_HOUR_UTC_ = 11;             // Brandwatch's day D lands D+1 06:08-10:27 UTC: read after 11:00 UTC
const EWS_TUBULAR_EVERY_MS_ = 6 * 3600 * 1000;
const EWS_OWN_EVERY_MS_ = 20 * 3600 * 1000;  // Google's own accounts (Sprinklr outbound) re-read this often

// Gates (analytics/early_detection/02 and its prod config)
const EWS_MAX_AUDIENCE_ = 5000;
const EWS_ENG_CEILING_ = 500;
const EWS_MIN_CHARS_ = 40;
const EWS_MIN_TOKENS_ = 7;
const EWS_MIN_DISTINCT_TOKENS_ = 5;
const EWS_TEXT_CHARS_ = 600;               // of each post's clean text, embedded and kept
const EWS_SNIPPET_CHARS_ = 280;            // a representative post's snippet (the row contract)
const EWS_KEEP_CHARS_ = 220;               // a member's snippet as kept in the cache

// Embeddings (Vectors.gs) and the evergreen gate
const EWS_EMBED_PER_CHECK_ = 400;
const EWS_EMBED_PER_DAY_ = 20000;

// Clustering (calibrated bars: see the header)
const EWS_START_SIM_ = 0.80;
const EWS_JOIN_SIM_ = 0.82;
const EWS_STORY_SIM_ = 0.83;
const EWS_TOP_K_ = 25;
const EWS_POOL_MS_ = 6 * 3600 * 1000;      // unassigned posts stay in the pool this long...
const EWS_POOL_MAX_ = 1200;                // ...this many at most (the newest)
const EWS_ACTIVE_MS_ = 24 * 3600 * 1000;   // a story with no new post for a day is let go
const EWS_CLUSTERS_MAX_ = 400;
const EWS_MEMBERS_MAX_ = 60;               // a story's most recent posts kept

// Promotion (03) and same-story dedup
const EWS_EVAL_MS_ = 180 * 60 * 1000;
const EWS_MIN_AUTHORS_ = 5;
const EWS_PLATFORM_DISCOUNT_ = 1;
const EWS_MIN_URLS_ = 2;
const EWS_CLUSTER_COOLDOWN_MS_ = 360 * 60 * 1000;
const EWS_MAX_ALERTS_ = 8;                 // a check, a signal type
const EWS_STORY_MS_ = 24 * 3600 * 1000;
const EWS_UPDATE_GROWTH_ = 2.0;
const EWS_UPDATE_NEW_ = 3;

// Velocity (04)
const EWS_VEL_WINDOW_MIN_ = 60;
const EWS_ROLL_HOURS_ = 6;
const EWS_BASE_DAYS_ = 7;
const EWS_ALPHA_ = 2.0;
const EWS_MIN_MULT_ = 3.0;
const EWS_HARD_DELTA_ = 12;
const EWS_MIN_CLUSTER_VEL_AUTHORS_ = 4;
const EWS_MIN_TERM_VEL_AUTHORS_ = 8;
const EWS_VEL_COOLDOWN_MS_ = 180 * 60 * 1000;
const EWS_VEL_COOLDOWN_GROWTH_ = 1.75;
const EWS_WARMUP_MS_ = 24 * 3600 * 1000;
const EWS_OPEN_HOURS_ = 2;                 // an hour is counted for good once it ended this long ago (late rows)
const EWS_TOPIC_KEYS_MAX_ = 40;            // topics kept in the rollup (the busiest)

// The buffer and the taxonomy hint
const EWS_BUFFER_MS_ = 180 * 60 * 1000;
const EWS_BUFFER_MAX_ = 30;
const EWS_TAG_RAISE_SIM_ = 0.70;

// The early watch (stories below the promotion bar, raised on the fast triage's answers; bars: Control rows 43-45, 47)
const EWS_WATCH_SIGNAL_ = 'EARLY_WATCH';
const EWS_WATCH_MIN_AUTHORS_ = 3;
const EWS_WATCH_MIN_LEVEL_ = 2;            // the most probable severity level is medium (2) or higher
const EWS_WATCH_MAX_PER_CHECK_ = 5;        // stories asked about a check (25-64 a day reach 3 accounts)
const EWS_WATCH_MAX_PER_DAY_ = 60;         // ...and a day
const EWS_WATCH_PICK_MAX_ = 20;            // stories looked at a check (risk terms first, then the most accounts)
const EWS_WATCH_MARKS_MAX_ = 300;          // stories remembered as asked about (the newest)

// Storage
const EWS_STATE_PROP_ = 'EWS_STATE';
const EWS_ROLLUP_PROP_ = 'EWS_ROLLUP';
const EWS_PROP_MAX_CHARS_ = 8800;          // a script property holds 9 KB
const EWS_CACHE_PREFIX_ = 'ews1:';
const EWS_CACHE_SEC_ = 6 * 3600;           // the script cache's maximum
const EWS_CACHE_ITEM_CHARS_ = 95000;       // a cache item holds 100 KB
const EWS_SIG_RECORD_ = 2000;              // same-author signatures a record (a day of them is packed into several cache items)
const EWS_SIGS_MAX_ = 60000;               // ...kept at most (the newest hours first): about 6 cache items

// Text gates as RE2 (BigQuery) patterns: analytics/early_detection/02 and 01 (risk_term_taxonomy)
const EWS_STRIP_RX_ = '(?i)(available\\s+on\\s+google\\s+play|get\\s+it\\s+on\\s+google\\s+play|\\bgoogle\\s+it\\b|' +
  '\\bgemini\\s+(?:season|moon|rising|venus|mercury|horoscope|zodiac)\\b|\\bchrome\\s+(?:hearts|wheels|rims)\\b)';
const EWS_HOMONYM_RX_ = '^[^a-z]*(gemini\\s+(?:season|moon|rising|horoscope|zodiac)|chrome\\s+hearts)\\b';
const EWS_SPAM_RX_ = '\\b(iptv|airdrop|giveaway|promo\\s*code|coupon\\s*code|onlyfans|check\\s+my\\s+bio|' +
  'link\\s+in\\s+(?:my\\s+)?bio|link\\s+na\\s+bio|dm\\s+me|follow\\s+back|use\\s+(?:my\\s+)?code|frete\\s+gr[aá]tis|' +
  'compre\\s+agora)\\b|#(?:ad|ads|sponsored|promo)\\b';
const EWS_ENTITY_RX_ = '\\b(google|alphabet|sundar|pichai|gemini|pixel|android|youtube|waymo|deepmind|nest|chromebook|' +
  'chromeos|chrome|workspace|gmail|maps|waze|fitbit|gboard|wing|verily|isomorphic|play\\s+store|google\\s+(?:maps|' +
  'photos|cloud|drive|pay|wallet|play|ads|search|tv|fi|lens|one)|ai\\s+overviews?|notebooklm|veo|imagen)\\b';
// English words for the sources without a language tag (comments, video titles): 2+ distinct ones. On 2,000 real
// comments it kept 78%; what it left out was Turkish, Spanish and Portuguese (the GIF campaign's "gif ver lan ...")
const EWS_EN_WORDS_RX_ = '\\b(the|and|is|are|was|were|be|been|to|of|for|in|on|at|by|from|it|its|this|that|these|' +
  'those|my|your|our|his|her|their|you|we|they|he|she|them|us|i|not|but|why|what|how|who|when|with|have|has|had|can|' +
  'could|will|would|should|just|so|me|do|does|did|please|if|or|an|about|more|there|get|give|out|up|now|all)\\b';
// Sonar smart tags that are praise or lifestyle (BigQuery.gs BQ_BSIP_POSITIVE_TAG_RX_), and Functional Use Case
const EWS_POSITIVE_TAG_RX_ = '^(?:brand|product)\\s*(?:–|-\\s*(?:passion point alignment|google praise|lifestyle imagery|' +
  'use case amplification|fan query|feature spotlight|comparison win|experience share))';
// Brandwatch's raw feed mixes competitors' queries (Claude, iPhone, OpenAI, Grok...): only Google's are read
const EWS_GOOGLE_CONFIG_RX_ = '^(?:google|gemini|googlebook|youtube|pixel|android|chrome|waymo|deepmind|fitbit|nest)';
const EWS_RISK_GROUPS_ = [
  { key: 'privacy_data_leak', tier: 'P0', rx: '(?i)\\b(data\\s+breach|leaked\\s+passwords?|private\\s+(?:docs|chats|emails|photos)\\s+exposed|spy(?:ing)?\\s+on|unauthorized\\s+access|training\\s+on\\s+private)\\b' },
  { key: 'safety_csam_selfharm', tier: 'P0', rx: '(?i)\\b(csam|child\\s+safety|self[- ]harm|suicid(?:e|al)|dangerous\\s+advice|told\\s+(?:me|my\\s+kid)\\s+to\\s+(?:die|hurt|eat))\\b' },
  { key: 'security_scam_malware', tier: 'P1', rx: '(?i)\\b(phishing|malware|account\\s+(?:hacked|drained|locked\\s+out)|fake\\s+google\\s+support|scam\\s+ads?)\\b' },
  { key: 'outage_broken_feature', tier: 'P1', rx: '(?i)\\b(is\\s+down|outage|bricked|bootloop|battery\\s+(?:swelling|fire|explod)|wiped\\s+my\\s+(?:files|drive|photos))\\b' },
  { key: 'ai_hallucination_bias', tier: 'P1', rx: '(?i)\\b(ai\\s+overview\\s+(?:wrong|lying|dangerous)|gemini\\s+(?:refuses|woke|censored|racist|hallucinat)|fake\\s+citation)\\b' },
  { key: 'legal_antitrust_layoffs', tier: 'P2', rx: '(?i)\\b(doj|antitrust|monopoly|class\\s+action|lawsuit|whistleblower|mass\\s+layoffs?|union\\s+busting)\\b' },
];
// Topics that name no topic: no topic velocity for them
const EWS_NO_TOPIC_RX_ = /^(?:|unclassified|other|unknown|n\/a|none)$/i;

// The columns every lane returns (one schema: posts and the exclusion lists)
const EWS_COLS_ = ['kind', 'lane', 'mid', 'url', 'platform', 'author', 'audience', 'eng', 'posted_ms', 'seen_ms', 'txt',
  'topic', 'chash', 'sig', 'risk', 'brand'];

// ---------------------------------------------------------------------------------------------------------------
// The seam: BigQuery.gs bqEarlyDetectionRows_ returns ewsRows_(minutes)
// ---------------------------------------------------------------------------------------------------------------

/**
 * The early-wave signals (EarlyWaveRow, the contract earlyWaveCheck_ reads) created in the last `minutes` (15-180;
 * blank: 60), at most EW_QUERY_MAX_ROWS_, P0 > P1 > P2, then velocity, accounts, oldest first. Runs a check first when
 * one is due (EWS_EVERY_MS_). Throws, with a message earlyWaveCheck_ turns into its C19 note ("BigQuery didn't answer" /
 * "didn't finish in time"), when no real-time source could be read and nothing new came out of the check.
 * `opts`: {facts: true, so each new row says its `risk_groups` and whether a taxonomy hint raised it (`tag_raised`);
 * watch (with the fast triage's ranking ON): {bars, ask(row), done(row, result, raised)}; record (with row 46 ON):
 * filled with this check's stories, story posts and signals}.
 */
function ewsRows_(minutes, opts) {
  const n = Math.round(Number(minutes));
  const mins = isFinite(n) && n > 0 ? Math.min(EWS_BUFFER_MS_ / 60000, Math.max(15, n)) : 60;
  const now = Date.now();
  const props = PropertiesService.getScriptProperties();
  const st = ewsState_(props);
  let outcome = null;
  // the open engine (row 51, step S6): a minute under the check's interval (openProducerMs_); OFF: EWS_EVERY_MS_
  const every = typeof openProducerMs_ === 'function' ? openProducerMs_() : EWS_EVERY_MS_;
  if (!st.at || now < st.at || now - st.at >= every) outcome = ewsProduce_(props, st, now, mins, opts);
  if (outcome && outcome.error && !outcome.emitted) throw new Error(outcome.error);
  if (outcome && outcome.watch && outcome.watch.length && opts && opts.watch) {
    ewsWatchAsk_(ewsCache_(), props, st, now, outcome.watch, opts.watch, opts && opts.record);
  }
  return ewsBufferRows_(ewsReadBuffer_(ewsCache_(), st), now, mins);
}

/**
 * The new sources' settings (config/default_config.yaml burson_qa, GEN.settings): {embedPerCheck, embedPerDay,
 * lateMinutes, poolMax, poolMinutes, carryMax, trialDays, liftedPerHour, liftedPerDay}. A setting missing, negative or
 * not a number reads as its default (the numbers below); 0 is kept (trialDays 0: no trial). Pure (reads GEN).
 */
function ewsNewCfg_() {
  const s = (typeof GEN !== 'undefined' && GEN && GEN.settings) || {};
  const n = (name, d) => {
    const v = s[name];
    return v === null || v === undefined || v === '' || typeof v === 'boolean' || !isFinite(Number(v)) || Number(v) < 0 ? d : Math.floor(Number(v));
  };
  return {
    embedPerCheck: n('early_wave_new_embed_per_check', 100),
    embedPerDay: n('early_wave_new_embed_per_day', 5000),
    lateMinutes: n('early_wave_new_late_minutes', 180),
    poolMax: n('early_wave_new_pool_max', 300),
    poolMinutes: n('early_wave_new_pool_minutes', 120),
    carryMax: n('early_wave_new_carry_max', 100),
    trialDays: n('early_wave_new_trial_days', 0),
    liftedPerHour: n('early_wave_new_lifted_per_hour', 2),
    liftedPerDay: n('early_wave_new_lifted_per_day', 20),
  };
}

/**
 * Which Control switches are ON for this run, as the producer reads them (ewsRows_ is given none): with `switches`
 * (the run's wanted.switches, Main.gs, right after the Control tab is read) it keeps the ones that are exactly true;
 * with no argument it returns them. Never set in a run (or set to nothing): every switch reads OFF, so no new source is
 * read (fail closed). With row 48 ON and row 19 OFF no check runs, so row 48's note a check left is taken away
 * (NewSources.gs nsrcWaiting_): its column C says only that it waits. Never throws.
 */
let EWS_RUN_SW_ = null;
function ewsRunSwitches_(switches) {
  if (arguments.length) {
    const out = {};
    if (switches && typeof switches === 'object') Object.keys(switches).forEach(k => { if (switches[k] === true) out[k] = true; });
    EWS_RUN_SW_ = out;
    if (out.edAmie && !out.earlyWave && typeof nsrcWaiting_ === 'function') nsrcWaiting_('edAmie');
    if (out.edBwLive && !out.earlyWave && typeof nsrcWaiting_ === 'function') nsrcWaiting_('edBwLive');
  }
  return Object.assign({}, EWS_RUN_SW_ || {});
}

// ---------------------------------------------------------------------------------------------------------------
// Small helpers (pure)
// ---------------------------------------------------------------------------------------------------------------

/** Bytes (signed or not) as lowercase hex. Pure. */
function ewsHex_(bytes) {
  return (bytes || []).map(b => ((b & 255) < 16 ? '0' : '') + (b & 255).toString(16)).join('');
}

/** SHA-256 of `s` as hex. */
function ewsSha_(s) {
  return ewsHex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s), Utilities.Charset.UTF_8));
}

/** A short FNV-1a fingerprint in base 36 (account and post keys in the velocity counts). Pure. */
function ewsFnv_(s) {
  let h = 0x811c9dc5;
  const t = String(s);
  for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
}

/** 'YYYY-MM-DDTHH:MM:SSZ' (UTC) for ms, '' for none. Pure. */
function ewsIso_(ms) {
  return Number(ms) > 0 ? new Date(Number(ms)).toISOString().replace(/\.\d{3}Z$/, 'Z') : '';
}

/** 'YYYY-MM-DD HH:MM UTC' for ms. Pure. */
function ewsCreatedUtc_(ms) {
  const iso = new Date(Number(ms) || 0).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/** 'yyyyMMddHHmm' (UTC) for ms: the minute in an alert_id. Pure. */
function ewsStamp_(ms) {
  return new Date(Number(ms) || 0).toISOString().replace(/[-:T]/g, '').slice(0, 12);
}

/** The UTC day 'YYYY-MM-DD' of ms. Pure. */
function ewsUtcDay_(ms) {
  return new Date(Number(ms) || 0).toISOString().slice(0, 10);
}

/** A unit-length copy of a vector (Float32Array), or null for a missing or zero one. Pure. */
function ewsUnit_(v) {
  if (!v || !v.length) return null;
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  if (!(n > 0)) return null;
  const s = 1 / Math.sqrt(n);
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] * s;
  return out;
}

/** Dot product (the cosine of two unit vectors). Pure. */
function ewsDot_(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/** A unit vector as stored (vecEncode_), and back (null when unreadable). */
function ewsEnc_(v) { return v ? vecEncode_(Array.prototype.slice.call(v)) : ''; }
function ewsDec_(s) { return s ? ewsUnit_(vecDecode_(s)) : null; }

/** The canonical platform name (GEN.platform_domains / network_aliases), from the link first. Pure (reads GEN). */
function ewsPlatform_(raw, url) {
  const byUrl = url ? networkForDomain_(domainOf_(url)) : null;
  if (byUrl) return byUrl;
  const r = String(raw || '').trim().toLowerCase().replace(/_public$|_brand_mentions$/, '');
  const aliases = (typeof GEN !== 'undefined' && GEN.network_aliases) || {};
  if (aliases[r]) return aliases[r];
  const known = Object.keys((typeof GEN !== 'undefined' && GEN.platform_domains) || {});
  const hit = known.find(k => k.toLowerCase() === r);
  if (hit) return hit;
  if (r === 'x') return 'X';
  return r ? r.charAt(0).toUpperCase() + r.slice(1) : 'Web';
}

/**
 * A new lane's account name (its account key is 'Platform:name'), for new-lane rows only (today's lanes keep theirs):
 * for X, Bluesky, TikTok and Threads the handle in the link, the way Sonar's lane takes it, but never 'i', 'intent',
 * 'home', 'search' or 'web'; else the source's author, lowercased, without a leading '@', 'u/' or '/u/'; never a
 * subreddit ('r/…'); a value shaped like an email address is replaced by the link (and never logged); blank: the link,
 * lowercased. Pure.
 */
function ewsNewAuthor_(platform, author, url) {
  const u = String(url || '').trim();
  const pick = rx => {
    const m = u.match(rx);
    return m && m[1] && !/^(?:i|intent|home|search|web)$/i.test(m[1]) ? m[1] : '';
  };
  let a = pick(/(?:twitter|x)\.com\/([A-Za-z0-9_]{1,30})\/status/i) || pick(/bsky\.app\/profile\/([^/?#]+)/i) ||
    pick(/tiktok\.com\/@([^/?#]+)/i) || pick(/threads\.(?:net|com)\/@([^/?#]+)/i);
  if (!a) a = String(author || '').trim();
  a = a.toLowerCase().replace(/^@+/, '').replace(/^\/?u\//, '').trim();
  if (/^\/?r\//.test(a) || /[^\s@]+@[^\s@]+\.[^\s@]+/.test(a)) a = '';
  return a || u.toLowerCase();
}

/** A new lane's platform: the network of the link's domain (GEN.platform_domains), else 'Web'. Pure (reads GEN). */
function ewsNewPlatform_(url) {
  return (url ? networkForDomain_(domainOf_(url)) : null) || 'Web';
}

/** A source's topic without its language suffix ("Gemini App - English" -> "Gemini App"). Pure. */
function ewsTopic_(raw) {
  const t = String(raw || '').replace(/\s+-\s+[A-Za-z]+$/, '').trim();
  return t || 'Unclassified';
}

/** P0 -> 0, P1 -> 1, anything else 2. Pure. */
function ewsPri_(p) {
  const s = String(p || '').toUpperCase();
  return s === 'P0' ? 0 : s === 'P1' ? 1 : 2;
}

// ---------------------------------------------------------------------------------------------------------------
// The two BigQuery jobs (read-only SQL, parameterized)
// ---------------------------------------------------------------------------------------------------------------

/** `raw` with its text's risk-term groups (risk_term_taxonomy) as one comma list, in SQL. Pure. */
function ewsRiskSql_(expr) {
  return `ARRAY_TO_STRING([${EWS_RISK_GROUPS_.map(g => `IF(REGEXP_CONTAINS(${expr}, r'${g.rx}'), '${g.key}', NULL)`).join(', ')}], ',')`;
}

/** SQL: 2+ distinct English words in `expr`. Pure. */
function ewsEnglishWordsSql_(expr) {
  return `ARRAY_LENGTH(ARRAY(SELECT DISTINCT w FROM UNNEST(REGEXP_EXTRACT_ALL(LOWER(IFNULL(${expr}, '')), r'${EWS_EN_WORDS_RX_}')) w)) >= 2`;
}

/**
 * The slow lanes as an SQL list: 'bw', 'tub' and, for a new source's job, its own slow lane names (`slowLanes`, e.g.
 * ['amis']). Without `slowLanes` exactly today's text. Pure.
 */
function ewsSlowSqlList_(slowLanes) {
  const extra = (Array.isArray(slowLanes) ? slowLanes : []).map(s => String(s || '').toLowerCase().replace(/[^a-z0-9_]/g, ''))
    .filter(s => s && s !== 'bw' && s !== 'tub');
  return ['bw', 'tub'].concat(Array.from(new Set(extra))).map(s => `'${s}'`).join(', ');
}

/**
 * The gates every lane's posts go through (02's low_tier_filtered, quality_checked and dedup_prepared), as CTEs over
 * `input` (lane, mid, url, platform, author, audience, eng, posted, seen, raw, topic): `gated` has the columns the job
 * returns. `slowLanes` (optional): a new source's slow lane names, slow beside 'bw' and 'tub'; without it the text is
 * exactly today's. Pure.
 */
function ewsGateCtes_(input, slowLanes) {
  const slow = ewsSlowSqlList_(slowLanes);
  return [
    `cleaned AS (`,
    `  SELECT *, TRIM(REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(IFNULL(raw, ''), r'^RT\\s+@\\w+:\\s*', ''),`,
    `    r'https?://\\S+|@[\\w.-]+', ' '), r'${EWS_STRIP_RX_}', ' ')) AS clean`,
    `  FROM ${input}`,
    `  WHERE mid IS NOT NULL AND url IS NOT NULL AND posted IS NOT NULL`,
    `    AND (audience IS NULL OR audience <= @max_audience) AND IFNULL(eng, 0) < @eng_ceiling`,
    `    AND author NOT IN ('grok', 'automoderator', '[deleted]') AND NOT REGEXP_CONTAINS(LOWER(url), r'/grok/status/')`,
    `    AND NOT REGEXP_CONTAINS(LOWER(IFNULL(raw, '')), r'${EWS_HOMONYM_RX_}')`,
    `    AND NOT REGEXP_CONTAINS(LOWER(IFNULL(raw, '')), r'${EWS_SPAM_RX_}')`,
    `    AND NOT ${nonEnglishScriptSql_("IFNULL(raw, '')")}`,
    `    AND posted <= TIMESTAMP_ADD(TIMESTAMP_MILLIS(@until_ms), INTERVAL 5 MINUTE)`,
    `    AND posted >= TIMESTAMP_SUB(TIMESTAMP_MILLIS(@until_ms), INTERVAL IF(lane IN (${slow}), 72, 24) HOUR)`,
    `),`,
    `tokened AS (`,
    `  SELECT *, REGEXP_EXTRACT_ALL(LOWER(clean), r'[a-z0-9]{2,}') AS toks,`,
    `    TRIM(REGEXP_REPLACE(LOWER(clean), r'[^a-z0-9\\s]+', ' ')) AS norm`,
    `  FROM cleaned`,
    `  WHERE CHAR_LENGTH(clean) >= @min_chars`,
    `),`,
    `gated AS (`,
    `  SELECT lane, mid, url, platform, author, audience, eng, posted, seen, topic,`,
    `    SUBSTR(clean, 1, ${EWS_TEXT_CHARS_}) AS txt,`,
    `    SUBSTR(TO_HEX(SHA256(SUBSTR(norm, 1, 1500))), 1, 16) AS chash,`,
    `    CAST(FARM_FINGERPRINT(CONCAT(LOWER(IFNULL(platform, '')), '|', author, '|',`,
    `      ARRAY_TO_STRING(ARRAY(SELECT DISTINCT t FROM UNNEST(toks) t ORDER BY t LIMIT 12), ' '))) AS STRING) AS sig,`,
    `    ${ewsRiskSql_('clean')} AS risk,`,
    `    REGEXP_CONTAINS(LOWER(clean), r'${EWS_ENTITY_RX_}') AS brand`,
    `  FROM tokened`,
    `  WHERE ARRAY_LENGTH(toks) >= @min_tokens AND (SELECT COUNT(DISTINCT t) FROM UNNEST(toks) t) >= @min_distinct`,
    `    AND (lane NOT IN (${slow}) OR REGEXP_CONTAINS(LOWER(clean), r'${EWS_ENTITY_RX_}'))`,
    `)`,
  ].join('\n');
}

/**
 * The posts the job returns: per lane, risk terms first, then the newest, up to its cap. `slowLanes` as ewsGateCtes_
 * (without it exactly today's text). Pure.
 */
function ewsPostSelectSql_(slowLanes) {
  const slow = ewsSlowSqlList_(slowLanes);
  return [
    `SELECT * FROM (`,
    `  SELECT 'post' AS kind, lane, mid, url, platform, author, audience, eng, UNIX_MILLIS(posted) AS posted_ms,`,
    `    UNIX_MILLIS(seen) AS seen_ms, txt, topic, chash, sig, risk, brand`,
    `  FROM gated`,
    `  WHERE TRUE`,
    `  QUALIFY ROW_NUMBER() OVER (PARTITION BY lane ORDER BY risk != '' DESC, posted DESC, mid)`,
    `    <= IF(lane IN (${slow}), @slow_max, @rt_max)`,
    `)`,
  ].join('\n');
}

/**
 * The US job: Sprinklr comments appended in [since, until) (APPENDS: arrival time), Brandwatch's day when due
 * (@bw_on), the posts DSD's story selection already alerted (7 days) and its KOF authors, and Google's own accounts from
 * the Sprinklr outbound export when due (@own_on). Pure.
 */
function ewsUsSql_() {
  const lowerHandle = col => `LOWER(TRIM(REGEXP_REPLACE(IFNULL(${col}, ''), r'^@+', '')))`;
  const nul = t => `CAST(NULL AS ${t})`;
  return [
    `-- ews:us (early wave: Sprinklr comments, Brandwatch, DSD story selection, Sprinklr outbound; read-only)`,
    `WITH spk AS (`,
    `  SELECT 'spk' AS lane, CONCAT('SPK|', comment_id) AS mid, post_url AS url, platform AS platform,`,
    `    ${lowerHandle('author_username')} AS author, SAFE_CAST(author_followers AS INT64) AS audience,`,
    `    SAFE_CAST(ROUND(IFNULL(comment_like_count, 0) + IFNULL(comment_reply_count, 0)) AS INT64) AS eng,`,
    `    comment_timestamp AS posted, _CHANGE_TIMESTAMP AS seen, comment_text AS raw,`,
    `    COALESCE(NULLIF(TRIM(Product), ''), NULLIF(TRIM(brand), ''), NULLIF(TRIM(account_name), ''), 'Owned Social') AS topic`,
    `  FROM APPENDS(TABLE \`${EWS_COMMENTS_TABLE_}\`, TIMESTAMP_MILLIS(@since_ms), TIMESTAMP_MILLIS(@until_ms))`,
    `  WHERE comment_id IS NOT NULL`,
    `    AND LOWER(IFNULL(is_deleted, 'false')) != 'true' AND LOWER(IFNULL(is_spam, 'false')) != 'true'`,
    `    AND LOWER(IFNULL(is_hidden, 'false')) != 'true' AND IFNULL(is_brand_post, '') != 'Brand'`,
    `    AND LOWER(IFNULL(sentiment, '')) != 'positive'`,
    `    AND ${ewsEnglishWordsSql_('comment_text')}`,
    `),`,
    `bw AS (`,
    `  SELECT 'bw' AS lane, CONCAT('BW|', mention_id) AS mid, post_url AS url, platform AS platform,`,
    `    ${lowerHandle('author')} AS author, SAFE_CAST(reachEstimate AS INT64) AS audience,`,
    `    SAFE_CAST(IFNULL(engagement_score, 0) AS INT64) AS eng, published_timestamp AS posted, load_timestamp AS seen,`,
    `    COALESCE(NULLIF(TRIM(snippet), ''), title) AS raw, COALESCE(NULLIF(TRIM(product_config_name), ''), 'Unclassified') AS topic`,
    `  FROM \`${EWS_BRANDWATCH_TABLE_}\``,
    `  WHERE @bw_on AND report_date = SAFE.PARSE_DATE('%Y-%m-%d', @bw_date) AND mention_id IS NOT NULL`,
    `    AND REGEXP_CONTAINS(LOWER(IFNULL(product_config_name, '')), r'${EWS_GOOGLE_CONFIG_RX_}')`,
    `    AND LOWER(IFNULL(sentiment, '')) != 'positive' AND ${englishLangSql_('language')}`,
    `),`,
    `lanes AS (SELECT * FROM spk UNION ALL SELECT * FROM bw),`,
    ewsGateCtes_('lanes'),
    ewsPostSelectSql_(),
    `UNION ALL`,
    `SELECT 'xurl', 'dsd', ${nul('STRING')}, url, platform, ${nul('STRING')}, ${nul('INT64')}, ${nul('INT64')},`,
    `  UNIX_MILLIS(ingestion_time), ${nul('INT64')}, ${nul('STRING')}, ${nul('STRING')}, ${nul('STRING')}, ${nul('STRING')},`,
    `  ${nul('STRING')}, ${nul('BOOL')}`,
    `FROM \`${EWS_STORY_TABLE_}\``,
    `WHERE ingestion_time > TIMESTAMP_SUB(TIMESTAMP_MILLIS(@until_ms), INTERVAL 7 DAY) AND url IS NOT NULL`,
    `UNION ALL`,
    `SELECT 'xkof', 'dsd', ${nul('STRING')}, ${nul('STRING')}, platform, ${lowerHandle('author')}, ${nul('INT64')}, ${nul('INT64')},`,
    `  UNIX_MILLIS(ingestion_time), ${nul('INT64')}, ${nul('STRING')}, ${nul('STRING')}, ${nul('STRING')}, ${nul('STRING')},`,
    `  ${nul('STRING')}, ${nul('BOOL')}`,
    `FROM \`${EWS_STORY_TABLE_}\``,
    `WHERE ingestion_time > TIMESTAMP_SUB(TIMESTAMP_MILLIS(@until_ms), INTERVAL 7 DAY)`,
    `  AND UPPER(IFNULL(alert_type, '')) = 'KOF' AND TRIM(IFNULL(author, '')) != ''`,
    `UNION ALL`,
    `SELECT DISTINCT 'own', 'outbound', ${nul('STRING')}, ${nul('STRING')}, LOWER(Social_Network),`,
    `  LOWER(REGEXP_EXTRACT(Account_URL, r'(?i)^https?://(?:www\\.)?(?:x|twitter|instagram|tiktok|threads)\\.(?:com|net)/@?([A-Za-z0-9_.]+)')),`,
    `  ${nul('INT64')}, ${nul('INT64')}, ${nul('INT64')}, ${nul('INT64')}, ${nul('STRING')}, ${nul('STRING')}, ${nul('STRING')},`,
    `  ${nul('STRING')}, ${nul('STRING')}, ${nul('BOOL')}`,
    `FROM \`${EWS_OUTBOUND_TABLE_}\``,
    `WHERE @own_on AND Report_Date >= DATE_SUB(DATE(TIMESTAMP_MILLIS(@until_ms)), INTERVAL 14 DAY)`,
    `  AND REGEXP_CONTAINS(IFNULL(Account_URL, ''), r'(?i)^https?://(?:www\\.)?(?:x|twitter|instagram|tiktok|threads)\\.(?:com|net)/@?[A-Za-z0-9_.]+')`,
  ].join('\n');
}

/**
 * The us-central1 job: posts Sonar first saw in (since, until] (not seen in the 24 hours before; the first copy's
 * payload), low tier, English, not a KOF, not praise / lifestyle / functional use; and Tubular's videos first seen
 * since @tub_from_ms when due (@tub_on). With `xbig` (only while a new source's Control row is ON), it also returns the
 * links of the English posts Sonar first saw in the window that are too big for Early Detection (more followers than
 * @max_audience, @eng_ceiling engagements or more, or on an influencer list) as 'xbig' rows, so a new source's copy of
 * such a post is left out; without it the text is exactly today's. Pure.
 */
function ewsC1Sql_(xbig) {
  const json = path => `JSON_VALUE(s.payload, '${path}')`;
  return [
    `-- ews:c1 (early wave: Sonar first seen, Tubular; read-only)`,
    `WITH fs AS (`,
    `  SELECT post_url, MIN(received_at) AS first_at`,
    `  FROM \`${EWS_SONAR_TABLE_}\``,
    `  WHERE received_at > TIMESTAMP_SUB(TIMESTAMP_MILLIS(@since_ms), INTERVAL 24 HOUR)`,
    `    AND received_at <= TIMESTAMP_MILLIS(@until_ms) AND post_url IS NOT NULL`,
    `  GROUP BY post_url`,
    `  HAVING MIN(received_at) > TIMESTAMP_MILLIS(@since_ms)`,
    `),`,
    `sonar AS (`,
    `  SELECT 'sonar' AS lane, CONCAT('SONAR|', SUBSTR(TO_HEX(SHA256(s.post_url)), 1, 24)) AS mid, s.post_url AS url,`,
    `    LOWER(IFNULL(s.platform, '')) AS platform,`,
    `    LOWER(COALESCE(`,
    `      REGEXP_EXTRACT(s.post_url, r'(?i)(?:twitter|x)\\.com/([A-Za-z0-9_]{1,30})/status'),`,
    `      REGEXP_EXTRACT(s.post_url, r'(?i)bsky\\.app/profile/([^/?#]+)'),`,
    `      REGEXP_EXTRACT(s.post_url, r'(?i)tiktok\\.com/@([^/?#]+)'),`,
    `      REGEXP_EXTRACT(s.post_url, r'(?i)threads\\.(?:net|com)/@([^/?#]+)'),`,
    `      NULLIF(NULLIF(TRIM(${json('$.detail.channel.username')}), ''), 'N/A'),`,
    `      s.post_url)) AS author,`,
    `    SAFE_CAST(s.follower_count AS INT64) AS audience,`,
    `    IFNULL(s.engagement_likes, 0) + IFNULL(s.engagement_comments, 0) + IFNULL(s.engagement_shares, 0) AS eng,`,
    // a date-only post time (YouTube: midnight) says nothing about the hour: when Sonar first saw it does
    `    IF(SUBSTR(IFNULL(s.post_timestamp, ''), 12, 8) IN ('', '00:00:00'), s.received_at,`,
    `      LEAST(s.received_at, COALESCE(SAFE.PARSE_TIMESTAMP('%Y-%m-%dT%H:%M:%S', SUBSTR(s.post_timestamp, 1, 19)), s.received_at))) AS posted,`,
    `    s.received_at AS seen, ${json('$.detail.post.snippet.text')} AS raw,`,
    `    COALESCE(NULLIF(TRIM(SPLIT(IFNULL(s.brand_classification, ''), ',')[SAFE_OFFSET(0)]), ''), 'Unclassified') AS topic`,
    `  FROM \`${EWS_SONAR_TABLE_}\` s`,
    `  JOIN fs ON fs.post_url = s.post_url AND fs.first_at = s.received_at`,
    `  WHERE s.received_at > TIMESTAMP_MILLIS(@since_ms) AND s.received_at <= TIMESTAMP_MILLIS(@until_ms)`,
    `    AND ${englishLangSql_('s.language')}`,
    `    AND IFNULL(ARRAY_LENGTH(JSON_QUERY_ARRAY(s.payload, '$.detail.classification.influencer_list_names')), 0) = 0`,
    `    AND TRIM(IFNULL(s.influencer_list, '')) = ''`,
    `    AND NOT REGEXP_CONTAINS(LOWER(IFNULL(s.smart_tag, '')), r'${EWS_POSITIVE_TAG_RX_}')`,
    `    AND LOWER(TRIM(IFNULL(s.smart_tag, ''))) != 'functional use case'`,
    `  QUALIFY ROW_NUMBER() OVER (PARTITION BY s.post_url ORDER BY s.received_at) = 1`,
    `),`,
    `tub_agg AS (`,
    `  SELECT 'tub' AS lane, CONCAT('TUB|', SUBSTR(TO_HEX(SHA256(video_url)), 1, 24)) AS mid, video_url AS url,`,
    `    LOWER(IFNULL(ANY_VALUE(platform), '')) AS platform, LOWER(TRIM(IFNULL(ANY_VALUE(creator), ''))) AS author,`,
    `    SAFE_CAST(MAX(creator_followers_or_subscribers) AS INT64) AS audience, SAFE_CAST(MAX(total_engagements) AS INT64) AS eng,`,
    `    MIN(published_at_utc) AS posted, MIN(first_seen_at_utc) AS seen, ANY_VALUE(video_title) AS raw, 'Unclassified' AS topic`,
    `  FROM \`${EWS_TUBULAR_TABLE_}\``,
    `  WHERE @tub_on AND snapshot_date >= DATE_SUB(DATE(TIMESTAMP_MILLIS(@tub_from_ms)), INTERVAL 2 DAY) AND video_url IS NOT NULL`,
    `  GROUP BY video_url`,
    `  HAVING MIN(first_seen_at_utc) > TIMESTAMP_MILLIS(@tub_from_ms) AND MIN(first_seen_at_utc) <= TIMESTAMP_MILLIS(@until_ms)`,
    `),`,
    `tub AS (SELECT * FROM tub_agg WHERE ${ewsEnglishWordsSql_('raw')}),`,
    `lanes AS (SELECT * FROM sonar UNION ALL SELECT * FROM tub),`,
    ewsGateCtes_('lanes'),
    ewsPostSelectSql_(),
  ].concat(xbig ? ewsC1BigSql_() : []).join('\n');
}

/** The us-central1 job's 'xbig' part (ewsC1Sql_ with `xbig`): one row a big post's link, in the 16 columns. Pure. */
function ewsC1BigSql_() {
  const nul = t => `CAST(NULL AS ${t})`;
  return [
    `UNION ALL`,
    `SELECT 'xbig', 'sonar', ${nul('STRING')}, s.post_url, ${nul('STRING')}, ${nul('STRING')}, ${nul('INT64')}, ${nul('INT64')},`,
    `  ${nul('INT64')}, UNIX_MILLIS(s.received_at), ${nul('STRING')}, ${nul('STRING')}, ${nul('STRING')}, ${nul('STRING')},`,
    `  ${nul('STRING')}, ${nul('BOOL')}`,
    `FROM \`${EWS_SONAR_TABLE_}\` s`,
    `JOIN fs ON fs.post_url = s.post_url AND fs.first_at = s.received_at`,
    `WHERE s.received_at > TIMESTAMP_MILLIS(@since_ms) AND s.received_at <= TIMESTAMP_MILLIS(@until_ms)`,
    `  AND ${englishLangSql_('s.language')}`,
    `  AND (IFNULL(SAFE_CAST(s.follower_count AS INT64), 0) > @max_audience`,
    `    OR IFNULL(s.engagement_likes, 0) + IFNULL(s.engagement_comments, 0) + IFNULL(s.engagement_shares, 0) >= @eng_ceiling`,
    `    OR IFNULL(ARRAY_LENGTH(JSON_QUERY_ARRAY(s.payload, '$.detail.classification.influencer_list_names')), 0) > 0`,
    `    OR TRIM(IFNULL(s.influencer_list, '')) != '')`,
    `QUALIFY ROW_NUMBER() OVER (PARTITION BY s.post_url ORDER BY s.received_at) = 1`,
  ];
}

/**
 * A lane's job for a window: {sql, params: [{name, type, value}], win: {since, until}, flags} (the slow lanes and
 * Google's own accounts only when due). `opts` (optional): {xbig: true} adds the us-central1 job's big posts
 * (ewsC1Sql_), only while a new source is ON. Pure.
 */
function ewsLaneQuery_(laneKey, st, until, ownDue, firstMins, opts) {
  const marks = (st && st.marks) || {};
  const have = Number(marks[laneKey === 'us' ? 'spk' : 'sonar']) || 0;
  const firstMs = isFinite(Number(firstMins)) && Number(firstMins) > 0 ? Math.round(Number(firstMins)) * 60 * 1000 : EWS_FIRST_MS_;
  const since = Math.max(have > 0 ? have : until - firstMs, until - EWS_MAX_WINDOW_MS_);
  const p = (name, type, value) => ({ name, type, value });
  const common = [
    p('since_ms', 'INT64', since), p('until_ms', 'INT64', until), p('max_audience', 'INT64', EWS_MAX_AUDIENCE_),
    p('eng_ceiling', 'INT64', EWS_ENG_CEILING_), p('min_chars', 'INT64', EWS_MIN_CHARS_),
    p('min_tokens', 'INT64', EWS_MIN_TOKENS_), p('min_distinct', 'INT64', EWS_MIN_DISTINCT_TOKENS_),
    p('rt_max', 'INT64', EWS_RT_MAX_ROWS_), p('slow_max', 'INT64', EWS_SLOW_MAX_ROWS_),
  ];
  if (laneKey === 'us') {
    const yesterday = ewsUtcDay_(until - 24 * 3600 * 1000);
    const bwOn = new Date(until).getUTCHours() >= EWS_SLOW_HOUR_UTC_ && marks.bw !== yesterday;
    return {
      sql: ewsUsSql_(),
      params: common.concat([p('bw_on', 'BOOL', bwOn), p('bw_date', 'STRING', yesterday), p('own_on', 'BOOL', !!ownDue)]),
      win: { since, until },
      flags: { bw: bwOn ? yesterday : '', own: !!ownDue },
    };
  }
  const tubFrom = Math.max(Number(marks.tub) || 0, until - 48 * 3600 * 1000);
  const tubOn = !(Number(marks.tubAt) > 0) || until - Number(marks.tubAt) >= EWS_TUBULAR_EVERY_MS_;
  return {
    sql: ewsC1Sql_(!!(opts && opts.xbig)),
    params: common.concat([p('tub_on', 'BOOL', tubOn), p('tub_from_ms', 'INT64', tubFrom)]),
    win: { since, until },
    flags: { tub: tubOn },
  };
}

/** A query parameter as BigQuery takes it; one with `array` (an element type) is a list of `value`'s items. Pure. */
function ewsParam_(p) {
  if (p.struct) return pwParam_(p);  // an array of structs (Brandwatch live's parcel, @bwl)
  if (p.array) {
    return { name: p.name, parameterType: { type: 'ARRAY', arrayType: { type: p.array } },
      parameterValue: { arrayValues: (Array.isArray(p.value) ? p.value : []).map(v => ({ value: String(v) })) } };
  }
  return { name: p.name, parameterType: { type: p.type }, parameterValue: { value: String(p.value) } };
}

/** The jobs.query request for a lane (for UrlFetchApp.fetchAll); a job's own byte limit (`q.maxBytes`) when it has one. */
function ewsJobRequest_(lane, q, token) {
  return {
    url: `${BQ_API_BASE_}${GCP_PROJECT}/queries`, method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify({
      query: q.sql, useLegacySql: false, location: lane.location, timeoutMs: EWS_BQ_WAIT_MS_, parameterMode: 'NAMED',
      maximumBytesBilled: q.maxBytes || EWS_MAX_BYTES_, maxResults: 5000, queryParameters: q.params.map(ewsParam_),
      labels: { purpose: 'early-wave', tool: 'burson-qa-bot', lane: lane.key },
    }),
  };
}

/** BigQuery's answer for a response: {ok, res, why}. Pure. */
function ewsAnswer_(resp) {
  let code = 599;
  let text = '';
  try { code = resp ? resp.getResponseCode() : 599; text = resp ? String(resp.getContentText() || '') : ''; } catch (e) { code = 599; }
  if (code >= 200 && code < 300) {
    try { return { ok: true, res: JSON.parse(text || '{}') }; } catch (e) { return { ok: false, why: 'unreadable answer' }; }
  }
  let why = text.slice(0, 240);
  try { why = (JSON.parse(text).error || {}).message || why; } catch (e) { /* not JSON */ }
  // never the old view's "Not found: Table" wording (earlyWaveCheck_ reads that as the view not being there)
  return { ok: false, why: `HTTP ${code}: ${String(why).replace(/Not found:\s*(Table|Dataset)/gi, 'missing $1')}`.slice(0, 240) };
}

/** jobs.getQueryResults for a job (waiting up to `waitMs`), a page of it with `pageToken`. */
function ewsFetchResults_(job, waitMs, pageToken) {
  if (typeof apiGuardNote_ === 'function') apiGuardNote_('bigquery', 1);
  const url = `${BQ_API_BASE_}${encodeURIComponent(job.project || GCP_PROJECT)}/queries/${encodeURIComponent(job.id)}` +
    `?location=${encodeURIComponent(job.location)}&timeoutMs=${Math.max(1000, Math.round(waitMs))}&maxResults=5000` +
    (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '');
  try {
    return ewsAnswer_(UrlFetchApp.fetch(url, { method: 'get', muteHttpExceptions: true,
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() } }));
  } catch (e) {
    return { ok: false, why: String((e && e.message) || e).slice(0, 240) };
  }
}

/** Cancels a job given up on. Never throws. */
function ewsCancel_(job) {
  try {
    UrlFetchApp.fetch(`${BQ_API_BASE_}${encodeURIComponent(job.project || GCP_PROJECT)}/jobs/${encodeURIComponent(job.id)}/cancel` +
      `?location=${encodeURIComponent(job.location)}`, { method: 'post', muteHttpExceptions: true,
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() } });
  } catch (e) { /* it ends on its own */ }
}

/**
 * The jobs of this check: today's two (EWS_LANES_), then each new source's (EWS_NEW_LANE_DEFS_) while its Control switch
 * is ON in `sw` (ewsRunSwitches_) and it has something to read (`ready`), as {key, location, def}. While a new switch
 * is ON the us-central1 entry carries `xbig` (its job also returns the big posts Sonar knew: ewsC1Sql_). With no new
 * switch ON exactly today's two entries. Never throws.
 */
function ewsLanes_(sw, st) {
  const on = sw && typeof sw === 'object' ? sw : {};
  const out = EWS_LANES_.map(l => (l.key === 'c1' && ewsNewSources_(on).length ? Object.assign({}, l, { xbig: true }) : l));
  EWS_NEW_LANE_DEFS_.forEach(d => {
    if (!d || !d.key || !d.sw || on[d.sw] !== true || out.some(l => l.key === d.key)) return;
    let ready = true;
    try { ready = typeof d.ready !== 'function' || !!d.ready(st || {}); } catch (e) { ready = false; }
    if (ready) out.push({ key: d.key, location: d.location || 'US', def: d });
  });
  return out;
}

/**
 * Reads the lanes for this check (`lanes`: ewsLanes_, today's two when not given): a job a previous check left running
 * is collected (not resubmitted), the others submitted for their next window, all in parallel, then waited for until
 * `deadline`. Returns {lanes: {us, c1, …}: {state: 'done' | 'pending' | 'failed' | 'idle', rows, why, job, q}};
 * `st.jobs` keeps the ones still running. A new source's job is built by its own `query` (a failure there fails that
 * lane alone); one left running from a check while its row was ON is given up once the row is OFF.
 */
function ewsReadLanes_(st, now, deadline, ownDue, firstMins, lanes) {
  const list = Array.isArray(lanes) && lanes.length ? lanes : EWS_LANES_;
  const until = now - EWS_SETTLE_MS_;
  const out = {};
  const jobs = Object.assign({}, st.jobs || {});
  Object.keys(jobs).forEach(k => {
    if (list.some(l => l.key === k)) return;
    if (jobs[k] && jobs[k].id) ewsCancel_(jobs[k]);
    delete jobs[k];
  });
  const submit = [];
  list.forEach(lane => {
    const job = jobs[lane.key];
    if (job && job.id && now - (Number(job.at) || 0) < EWS_JOB_MAX_MS_) {
      out[lane.key] = { state: 'pending', rows: [], job, q: job.q };
      return;
    }
    if (job && job.id) ewsCancel_(job);  // given up: its window is read again
    delete jobs[lane.key];
    let q = null;
    if (lane.def) {
      try { q = lane.def.query(st, until, firstMins); } catch (e) {
        out[lane.key] = { state: 'failed', rows: [], why: String((e && e.message) || e).slice(0, 240) };
        return;
      }
      if (!q || !q.sql) { out[lane.key] = { state: 'idle', rows: [] }; return; }
    } else {
      q = ewsLaneQuery_(lane.key, st, until, ownDue, firstMins, lane.xbig ? { xbig: true } : undefined);
    }
    submit.push({ lane, q });
    out[lane.key] = { state: 'pending', rows: [], q: { win: q.win, flags: q.flags } };
  });
  if (submit.length) {
    let token = '';
    try { token = ScriptApp.getOAuthToken(); } catch (e) { token = ''; }
    if (typeof apiGuardNote_ === 'function') apiGuardNote_('bigquery', submit.length);
    let responses = [];
    try { responses = UrlFetchApp.fetchAll(submit.map(s => ewsJobRequest_(s.lane, s.q, token))) || []; } catch (e) {
      responses = [];
      submit.forEach(s => { out[s.lane.key] = { state: 'failed', rows: [], why: String((e && e.message) || e).slice(0, 240) }; });
    }
    submit.forEach((s, i) => {
      if (out[s.lane.key].state === 'failed') return;
      const a = ewsAnswer_(responses[i]);
      if (!a.ok) { out[s.lane.key] = { state: 'failed', rows: [], why: a.why }; return; }
      const ref = a.res.jobReference || {};
      const job = { id: ref.jobId || '', project: ref.projectId || GCP_PROJECT, location: ref.location || s.lane.location,
        at: now, q: { win: s.q.win, flags: s.q.flags } };
      out[s.lane.key] = { state: a.res.jobComplete ? 'done' : 'pending', res: a.res, job, q: job.q, rows: [] };
    });
  }
  // wait for the ones still running (a previous check's, or this one's), then read every page
  list.forEach(lane => {
    const o = out[lane.key];
    if (o.state === 'idle') return;
    while (o.state === 'pending' && o.job && o.job.id && Date.now() < deadline - 2000) {
      const a = ewsFetchResults_(o.job, Math.min(EWS_BQ_WAIT_MS_, deadline - Date.now() - 2000));
      if (!a.ok) { o.state = 'failed'; o.why = a.why; break; }
      if (a.res.jobComplete) { o.state = 'done'; o.res = a.res; }
      else if (!o.job.id) break;
    }
    if (o.state === 'done') {
      const t1 = Date.now();
      let res = o.res;
      let rows = parseBqRows_(res);
      let pages = 0;
      while (res && res.pageToken && pages < 5 && Date.now() < deadline - 2000) {
        const a = ewsFetchResults_(o.job, 5000, res.pageToken);
        if (!a.ok || !a.res.jobComplete) break;
        res = a.res;
        rows = rows.concat(parseBqRows_(res));
        pages++;
      }
      o.rows = rows;
      if (lane.def) { o.got = rows.length; o.ms = Date.now() - t1; }  // a new source's: for its log line
      delete jobs[lane.key];
    } else if (o.state === 'pending' && o.job && o.job.id) {
      jobs[lane.key] = o.job;
    } else {
      delete jobs[lane.key];
    }
  });
  st.jobs = jobs;
  return { lanes: out };
}

// ---------------------------------------------------------------------------------------------------------------
// Posts and exclusions
// ---------------------------------------------------------------------------------------------------------------

/**
 * A lane's post row as the producer keeps it: {id, lane, slow, url, nurl, platform, author, ak, audience, eng, t, seen,
 * text, topic, chash, sig, risk: [], brand}, or null for an unusable row; a new lane's post (EWS_NEW_LANES_) also has
 * `nl: true`, its account from ewsNewAuthor_ and its platform from its link (ewsNewPlatform_). Slow: the lane is one
 * of EWS_SLOW_LANES_. Pure (reads GEN).
 */
function ewsPostOf_(r) {
  if (!r || r.kind !== 'post' || !r.mid || !r.url) return null;
  const url = String(r.url).trim();
  let lane = String(r.lane || '');
  const nl = EWS_NEW_LANES_.indexOf(lane) >= 0;
  // the late split, again here (the job's SQL decides it first): a new lane's post first seen more than
  // early_wave_new_late_minutes after it was posted is slow (amis / bwls) whatever its job said
  if (nl && (lane === 'ami' || lane === 'bwl') && Number(r.posted_ms) > 0 && Number(r.seen_ms) > 0 &&
    Number(r.seen_ms) - Number(r.posted_ms) > ewsNewCfg_().lateMinutes * 60000) lane += 's';
  const platform = nl ? ewsNewPlatform_(url) : ewsPlatform_(r.platform, url);
  const author = nl ? ewsNewAuthor_(platform, r.author, url) : String(r.author || '').trim().toLowerCase().replace(/^@+/, '') || url;
  const num = v => (v === null || v === undefined || v === '' || !isFinite(Number(v)) ? null : Math.max(0, Math.round(Number(v))));
  const post = {
    id: String(r.mid), lane, slow: EWS_SLOW_LANES_.indexOf(lane) >= 0, url,
    nurl: normalizeUrl_(url) || url.toLowerCase(), platform, author, ak: `${platform}:${author}`,
    audience: num(r.audience), eng: num(r.eng), t: Number(r.posted_ms) || 0, seen: Number(r.seen_ms) || 0,
    text: String(r.txt || '').trim(), topic: ewsTopic_(r.topic), chash: String(r.chash || ''), sig: String(r.sig || ''),
    risk: String(r.risk || '').split(',').map(s => s.trim()).filter(Boolean), brand: r.brand === true || r.brand === 'true',
  };
  if (nl) post.nl = true;
  return post;
}

/**
 * The exclusion lists ({urls: Set, authors: Set, at, ownAt}): DSD's alerted posts and KOF authors (7 days) and Google's
 * own account handles, from this check's US answer when it came, else the cached ones. Pure (but for `cached`).
 */
function ewsExclusions_(cached, usRows, usDone, now) {
  const c = cached && typeof cached === 'object' ? cached : {};
  const ex = { urls: (c.urls || []).slice(), kof: (c.kof || []).slice(), own: (c.own || []).slice(), at: c.at || 0, ownAt: c.ownAt || 0 };
  if (usDone) {
    const urls = [];
    const kof = [];
    const own = [];
    (usRows || []).forEach(r => {
      if (r.kind === 'xurl' && r.url) { const n = normalizeUrl_(r.url); if (n) urls.push(n); }
      else if (r.kind === 'xkof' && r.author) kof.push(String(r.author).toLowerCase());
      else if (r.kind === 'own' && r.author) own.push(String(r.author).toLowerCase());
    });
    ex.urls = Array.from(new Set(urls));
    ex.kof = Array.from(new Set(kof));
    ex.at = now;
    if (own.length) { ex.own = Array.from(new Set(own)); ex.ownAt = now; }
  }
  return ex;
}

/** Posts not already alerted (DSD), not by a KOF DSD knows, not by one of Google's own accounts. Pure. */
function ewsExclude_(posts, ex) {
  const urls = new Set((ex && ex.urls) || []);
  const authors = new Set([].concat((ex && ex.kof) || [], (ex && ex.own) || []));
  return (posts || []).filter(p => !urls.has(p.nurl) && !authors.has(p.author));
}

/**
 * Same-author near-copies (02's author_dedup_sig: platform, author and the first 12 distinct tokens) seen in the last
 * 24 hours, or twice in this batch, are dropped (the first copy stays). `sigs` is {hourIndex: [sig, …]}, updated. Pure.
 */
function ewsDedupSigs_(posts, sigs, now) {
  const minHour = Math.floor((now - 24 * 3600 * 1000) / 3600000);
  Object.keys(sigs).forEach(h => { if (Number(h) < minHour) delete sigs[h]; });
  const seen = new Set();
  Object.keys(sigs).forEach(h => (sigs[h] || []).forEach(s => seen.add(s)));
  const hour = String(Math.floor(now / 3600000));
  const kept = [];
  posts.slice().sort((a, b) => a.t - b.t || (a.id < b.id ? -1 : 1)).forEach(p => {
    const s = p.sig ? ewsFnv_(p.sig) : '';
    if (s && seen.has(s)) return;
    if (s) { seen.add(s); (sigs[hour] = sigs[hour] || []).push(s); }
    kept.push(p);
  });
  return kept;
}

/**
 * The same-author near-copies with new lanes' posts among `posts`: today's lanes' posts are checked against, and
 * written to, their own signatures (`sigs`) exactly as ewsDedupSigs_ does; a new lane's post is checked against both
 * sets (`sigs`, then `nsigs`, its own) and written only to `nsigs`, so it can never drop a later post of today's
 * lanes. The posts kept, oldest first. Pure (but for `sigs` and `nsigs`).
 */
function ewsDedupSigsSplit_(posts, sigs, nsigs, now) {
  const kept = ewsDedupSigs_((posts || []).filter(p => !p.nl), sigs, now);
  const fresh = (posts || []).filter(p => p.nl);
  if (!fresh.length) return kept;
  const minHour = Math.floor((now - 24 * 3600 * 1000) / 3600000);
  Object.keys(nsigs).forEach(h => { if (Number(h) < minHour) delete nsigs[h]; });
  const seen = new Set();
  [sigs, nsigs].forEach(set => Object.keys(set).forEach(h => (set[h] || []).forEach(x => seen.add(x))));
  const hour = String(Math.floor(now / 3600000));
  fresh.sort((a, b) => a.t - b.t || (a.id < b.id ? -1 : 1)).forEach(p => {
    const s = p.sig ? ewsFnv_(p.sig) : '';
    if (s && seen.has(s)) return;
    if (s) { seen.add(s); (nsigs[hour] = nsigs[hour] || []).push(s); }
    kept.push(p);
  });
  return kept.sort((a, b) => a.t - b.t || (a.id < b.id ? -1 : 1));
}

/**
 * The same-author signatures of the last 24 hours ({hourIndex: [sig, …]}: ewsDedupSigs_) from the cache: 'sg:N' (N <
 * `count`, st.sg), each a list of [hour, [sig, …]] records; with no count yet, the single 'sig' item they were kept in
 * before (it outgrew a cache item: a day of them is about 96,000 characters). `name` (optional, 'sn': the new lanes'
 * own set, st.sn) reads 'sn:N' items instead, and nothing with no count. Never throws.
 */
function ewsLoadSigs_(cache, count, name) {
  const out = {};
  if (!cache) return out;
  const item = name || 'sg';
  if (!(count > 0)) {
    if (item !== 'sg') return out;
    const old = ewsCacheGet_(cache, 'sig');
    return old && typeof old === 'object' && !Array.isArray(old) ? old : out;
  }
  const keys = [];
  for (let i = 0; i < count; i++) keys.push(`${EWS_CACHE_PREFIX_}${item}:${i}`);
  let got = {};
  try { got = cache.getAll(keys) || {}; } catch (e) { got = {}; }
  keys.forEach(k => {
    try {
      (JSON.parse(got[k] || '[]') || []).forEach(rec => {
        if (!Array.isArray(rec) || !Array.isArray(rec[1])) return;
        const h = String(rec[0]);
        out[h] = (out[h] || []).concat(rec[1]);
      });
    } catch (e) { /* lost */ }
  });
  return out;
}

/**
 * The new-lane post-key index as records to pack (ewsChunks_), EWS_NK_MAX_ keys in all (`max`, optional): the new
 * lanes' keys first, the newest hours first, leaving today's lanes' keys ('t<hour>') at least EWS_NK_TODAY_MIN_ places
 * (or as many as they have); today's lanes' keys fill what is left, the newest first (ewsNkTail_: within an hour cut
 * short, its latest checks' keys). Pure.
 */
function ewsNkRecords_(index, max) {
  const cap = max > 0 ? max : EWS_NK_MAX_;
  const fresh = {};
  const today = {};
  Object.keys(index || {}).forEach(h => { if (/^t/.test(h)) today[h.slice(1)] = index[h]; else fresh[h] = index[h]; });
  const count = part => Object.keys(part).reduce((n, h) => n + (Array.isArray(part[h]) ? part[h].length : 0), 0);
  const freshCap = cap - Math.min(count(today), EWS_NK_TODAY_MIN_, cap);
  const a = freshCap > 0 ? ewsNkTail_(fresh, freshCap) : [];
  const left = cap - a.reduce((n, r) => n + r[1].length, 0);
  const b = left > 0 ? ewsNkTail_(today, left).map(r => [`t${r[0]}`, r[1]]) : [];
  return a.concat(b);
}

/**
 * Keys by hour ({hour: [entry, …]}, each hour's list oldest first: ewsStitch_ adds a check's keys at its end) as records
 * of EWS_NK_RECORD_ keys, `cap` in all: the newest hours first and, in an hour cut short, its newest keys (the end of its
 * list), kept in their order. Pure.
 */
function ewsNkTail_(part, cap) {
  const out = [];
  let total = 0;
  Object.keys(part || {}).sort((a, b) => Number(b) - Number(a)).forEach(h => {
    const list = Array.isArray(part[h]) ? part[h] : [];
    if (total >= cap || !list.length) return;
    const kept = list.slice(Math.max(0, list.length - (cap - total)));
    for (let i = 0; i < kept.length; i += EWS_NK_RECORD_) out.push([h, kept.slice(i, i + EWS_NK_RECORD_)]);
    total += kept.length;
  });
  return out;
}

/**
 * The signatures as records small enough to pack (ewsChunks_): [hour, [sig, …]], EWS_SIG_RECORD_ signatures a record
 * (`per`, optional), the newest hours first, EWS_SIGS_MAX_ in all (`max`, optional; past it the oldest hours go). Pure.
 */
function ewsSigRecords_(sigs, max, per) {
  const out = [];
  let total = 0;
  const cap = max > 0 ? max : EWS_SIGS_MAX_;
  const size = per > 0 ? per : EWS_SIG_RECORD_;
  Object.keys(sigs || {}).sort((a, b) => Number(b) - Number(a)).forEach(h => {
    const list = Array.isArray(sigs[h]) ? sigs[h] : [];
    for (let i = 0; i < list.length && total < cap; i += size) {
      const part = list.slice(i, i + Math.min(size, cap - total));
      out.push([h, part]);
      total += part.length;
    }
  });
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// State: script properties (small, durable) and the script cache (packed, 6 h)
// ---------------------------------------------------------------------------------------------------------------

/** EWS_STATE: {v, at, marks: {sonar, spk, bw, tub, tubAt}, jobs: {us, c1}, day: {key, embedded}, last}. Never throws. */
function ewsState_(props) {
  let s = null;
  try { s = JSON.parse(props.getProperty(EWS_STATE_PROP_) || 'null'); } catch (e) { s = null; }
  if (!s || typeof s !== 'object' || Array.isArray(s)) s = {};
  s.v = 1;
  s.marks = s.marks && typeof s.marks === 'object' ? s.marks : {};
  s.jobs = s.jobs && typeof s.jobs === 'object' ? s.jobs : {};
  s.day = s.day && typeof s.day === 'object' ? s.day : {};
  return s;
}

function ewsSaveState_(props, st) {
  try {
    let json = JSON.stringify(st);
    if (json.length > EWS_PROP_MAX_CHARS_) { delete st.last; json = JSON.stringify(st); }
    props.setProperty(EWS_STATE_PROP_, json);
  } catch (e) {
    console.warn(`Early wave: couldn't save its state: ${(e && e.message) || e}`);
  }
}

/** EWS_ROLLUP: {v, since, n: [24 days seen per UTC hour], cov: [covered hours], k: {key: {d: [24], r: {hour: n}}}, cool}. */
function ewsRollup_(props) {
  let r = null;
  try { r = JSON.parse(props.getProperty(EWS_ROLLUP_PROP_) || 'null'); } catch (e) { r = null; }
  if (!r || typeof r !== 'object' || Array.isArray(r)) r = {};
  r.v = 1;
  r.n = Array.isArray(r.n) && r.n.length === 24 ? r.n : new Array(24).fill(0);
  r.cov = Array.isArray(r.cov) ? r.cov : [];
  r.k = r.k && typeof r.k === 'object' ? r.k : {};
  r.cool = r.cool && typeof r.cool === 'object' ? r.cool : {};
  Object.keys(r.k).forEach(key => {
    const e = r.k[key] || {};
    r.k[key] = { d: Array.isArray(e.d) && e.d.length === 24 ? e.d.map(Number) : new Array(24).fill(0), r: e.r && typeof e.r === 'object' ? e.r : {} };
  });
  return r;
}

/** Saves the rollup under the property limit: the quietest topics go first. */
function ewsSaveRollup_(props, roll) {
  try {
    const round = x => Math.round(x * 100) / 100;
    Object.keys(roll.k).forEach(k => { roll.k[k].d = roll.k[k].d.map(round); });
    const topics = Object.keys(roll.k).filter(k => k.indexOf('T|') === 0)
      .sort((a, b) => roll.k[b].d.reduce((s, x) => s + x, 0) - roll.k[a].d.reduce((s, x) => s + x, 0));
    topics.slice(EWS_TOPIC_KEYS_MAX_).forEach(k => delete roll.k[k]);
    let json = JSON.stringify(roll);
    let keep = topics.slice(0, EWS_TOPIC_KEYS_MAX_);
    while (json.length > EWS_PROP_MAX_CHARS_ && keep.length) {
      delete roll.k[keep.pop()];
      json = JSON.stringify(roll);
    }
    if (json.length <= EWS_PROP_MAX_CHARS_) props.setProperty(EWS_ROLLUP_PROP_, json);
  } catch (e) {
    console.warn(`Early wave: couldn't save its velocity rollup: ${(e && e.message) || e}`);
  }
}

function ewsCache_() {
  try { return typeof CacheService !== 'undefined' && CacheService.getScriptCache ? CacheService.getScriptCache() : null; }
  catch (e) { return null; }
}

/** Reads one JSON cache item (null when missing). Never throws. */
function ewsCacheGet_(cache, name) {
  if (!cache) return null;
  try { return JSON.parse(cache.get(EWS_CACHE_PREFIX_ + name) || 'null'); } catch (e) { return null; }
}

/** Writes JSON cache items {name: value} (each under EWS_CACHE_ITEM_CHARS_; too big: skipped). Never throws. */
function ewsCachePut_(cache, items) {
  if (!cache) return;
  const out = {};
  Object.keys(items).forEach(name => {
    const json = JSON.stringify(items[name]);
    if (json.length <= EWS_CACHE_ITEM_CHARS_) out[EWS_CACHE_PREFIX_ + name] = json;
    else console.warn(`Early wave: ${name} too big for the cache (${json.length} chars), not kept`);
  });
  try { if (Object.keys(out).length) cache.putAll(out, EWS_CACHE_SEC_); } catch (e) {
    console.warn(`Early wave: couldn't write the cache: ${(e && e.message) || e}`);
  }
}

/** Packs records into JSON chunks each under EWS_CACHE_ITEM_CHARS_. Pure. */
function ewsChunks_(records) {
  const chunks = [];
  let cur = [];
  let size = 2;
  (records || []).forEach(r => {
    const len = JSON.stringify(r).length + 1;
    if (cur.length && size + len > EWS_CACHE_ITEM_CHARS_) { chunks.push(cur); cur = []; size = 2; }
    cur.push(r);
    size += len;
  });
  if (cur.length) chunks.push(cur);
  return chunks;
}

/** The clusters (cache 'cl:N', N < st.cl): [{id, s, n, t0, ts, lab, tp, m, al, hc}]. Never throws. */
function ewsLoadClusters_(cache, count) {
  const out = [];
  if (!cache || !(count > 0)) return out;
  const keys = [];
  for (let i = 0; i < count; i++) keys.push(`${EWS_CACHE_PREFIX_}cl:${i}`);
  let got = {};
  try { got = cache.getAll(keys) || {}; } catch (e) { got = {}; }
  keys.forEach(k => {
    try { (JSON.parse(got[k] || '[]') || []).forEach(c => { if (c && c.id && c.s) out.push(c); }); } catch (e) { /* lost */ }
  });
  return out;
}

/** The pool (cache 'pv:<stamp>:<j>', listed in st.pool): unassigned posts with their vectors. Never throws. */
function ewsLoadPool_(cache, index, now) {
  const out = [];
  if (!cache) return out;
  const keys = [];
  (index || []).forEach(([stamp, n]) => { for (let j = 0; j < n; j++) keys.push(`${EWS_CACHE_PREFIX_}pv:${stamp}:${j}`); });
  if (!keys.length) return out;
  let got = {};
  for (let i = 0; i < keys.length; i += 100) {
    try { Object.assign(got, cache.getAll(keys.slice(i, i + 100)) || {}); } catch (e) { /* lost */ }
  }
  keys.forEach(k => {
    try {
      (JSON.parse(got[k] || '[]') || []).forEach(p => {
        if (p && p.i && p.v && now - (Number(p.g) || 0) < EWS_POOL_MS_) out.push(Object.assign(p, { _key: k }));
      });
    } catch (e) { /* lost */ }
  });
  return out;
}

/** The buffer (cache 'buf'): rows created in the last 3 hours. Never throws. */
function ewsReadBuffer_(cache, st) {
  // the open engine (Control row 51, step S5): the buffer is in several items ('bf:N', their row counts in the state's
  // `bf`); an item the cache dropped is counted on the Engine tab as lost. Row 51 OFF: the one item 'buf', as before
  if (st && Array.isArray(st.bf) && typeof openOn_ === 'function' && openOn_()) {
    let rows = [];
    st.bf.forEach((n, i) => {
      const part = ewsCacheGet_(cache, `bf:${i}`);
      if (Array.isArray(part)) rows = rows.concat(part.filter(r => r && r.alert_id));
      else if (typeof engAdd_ === 'function') engAdd_('lost', Number(n) || 0);
    });
    return rows;
  }
  const b = ewsCacheGet_(cache, 'buf');
  return Array.isArray(b) ? b.filter(r => r && r.alert_id) : [];
}

/**
 * Puts the buffer's rows in `items` (written with the rest): under row 51 the newest OE_ROWS_MAX_ in items of their own
 * ('bf:N', st.bf their row counts); else the newest EWS_BUFFER_MAX_ that fit one item ('buf'), as before. Never throws.
 */
function ewsBufferPut_(items, st, rows) {
  if (typeof openOn_ === 'function' && openOn_()) {
    const chunks = ewsChunks_((rows || []).slice(-OE_ROWS_MAX_));
    chunks.forEach((ch, i) => { items[`bf:${i}`] = ch; });
    st.bf = chunks.map(ch => ch.length);
    return;
  }
  if (st && st.bf !== undefined) delete st.bf;
  let buf = (rows || []).slice(-EWS_BUFFER_MAX_);
  while (buf.length > 1 && JSON.stringify(buf).length > EWS_CACHE_ITEM_CHARS_) buf = buf.slice(1);
  items.buf = buf;
}

/**
 * The buffer's rows created in the last `minutes` as earlyWaveCheck_ reads them: at most EW_QUERY_MAX_ROWS_, P0 > P1 >
 * P2, then velocity ratio, accounts, the oldest first (the old view's ORDER BY). Pure.
 */
function ewsBufferRows_(buffer, now, minutes) {
  // the open engine (row 51, step S5): every signal the producer kept, up to OE_ROWS_MAX_
  const max = typeof openOn_ === 'function' && openOn_() ? OE_ROWS_MAX_ : typeof EW_QUERY_MAX_ROWS_ === 'number' ? EW_QUERY_MAX_ROWS_ : 25;
  return (buffer || []).filter(r => r && now - (Number(r._at) || 0) <= minutes * 60000 && Number(r._at) <= now + 60000)
    .sort((a, b) => ewsPri_(a.priority_hint) - ewsPri_(b.priority_hint) ||
      (Number(b.velocity_ratio) || 0) - (Number(a.velocity_ratio) || 0) ||
      (Number(b.unique_low_tier_authors) || 0) - (Number(a.unique_low_tier_authors) || 0) ||
      (Number(a._at) || 0) - (Number(b._at) || 0))
    .slice(0, max)
    .map(r => {
      const row = Object.assign({}, r);
      delete row._at;
      return row;
    });
}

// ---------------------------------------------------------------------------------------------------------------
// Clustering (analytics/early_detection/03, incremental)
// ---------------------------------------------------------------------------------------------------------------

/** A post as a story keeps it (a member), without its vector. Pure. */
function ewsMember_(p, sim, now) {
  const m = { i: p.id, a: p.ak, p: p.platform, u: p.url, t: p.t, s: truncate_(p.text, EWS_KEEP_CHARS_), d: Math.round(sim * 1000) / 1000,
    h: p.chash, tp: p.topic, j: now };
  if (p.eng !== null && p.eng !== undefined) m.e = p.eng;
  if (p.audience !== null && p.audience !== undefined) m.f = p.audience;
  if (p.risk && p.risk.length) m.r = p.risk.join(',');
  if (p.brand) m.b = 1;
  if (p.slow) m.sl = 1;
  if (p.nl) m.nl = 1;  // a new lane's post (written only for those: today's lanes' records are as before)
  if (p.k) m.k = p.k;  // its post key's hash (set only while a new source is ON: ewsStitch_)
  if (p.nl && Number(p.seen) > 0) m.ss = p.seen;  // when its source first had it (the "seen first" measure)
  return m;
}

/** A pool record: the member fields, its vector and when it came in. Pure. */
function ewsPoolRecord_(p, now) {
  return Object.assign(ewsMember_(p, 1, now), { v: ewsEnc_(p.vec), g: now });
}

/** A pool record back as a post (with its vector; `nl` only on a new lane's). Pure. */
function ewsPostOfPool_(r) {
  const p = { id: r.i, ak: r.a, platform: r.p, url: r.u, t: Number(r.t) || 0, text: r.s || '', chash: r.h || '', topic: r.tp || 'Unclassified',
    eng: r.e === undefined ? null : r.e, audience: r.f === undefined ? null : r.f, risk: r.r ? String(r.r).split(',') : [],
    brand: !!r.b, slow: !!r.sl, vec: ewsDec_(r.v), g: Number(r.g) || 0, fromPool: true };
  if (r.nl) p.nl = true;
  if (r.k) p.k = r.k;
  if (r.ss) p.seen = Number(r.ss) || 0;
  return p;
}

/** Adds a post to a story: its vector to the centroid's sum, the post to its members and topics. */
function ewsJoin_(c, p, sim, now) {
  if (!c._sum) c._sum = ewsSumOf_(c);
  if (p.vec) for (let i = 0; i < c._sum.length; i++) c._sum[i] += p.vec[i];
  c.n = (Number(c.n) || 0) + 1;
  c.ts = now;
  c.m = (c.m || []).concat([ewsMember_(p, sim, now)]);
  c.tp = c.tp || {};
  c.tp[p.topic] = (Number(c.tp[p.topic]) || 0) + 1;
  c._dirty = true;
}

/** A story's centroid sum (Float64Array) from its stored form. */
function ewsSumOf_(c) {
  const v = vecDecode_(c.s);
  const out = new Float64Array(VEC_DIMS_);
  if (v) for (let i = 0; i < out.length; i++) out[i] = v[i];
  return out;
}

/** A story's unit centroid (cached on the object). */
function ewsCentroid_(c) {
  if (c._dirty || !c._vec) {
    c._vec = c._sum ? ewsUnit_(c._sum) : ewsDec_(c.s);
    c._dirty = false;
  }
  return c._vec;
}

/**
 * Stage A (03): each post's nearest active story by its centroid at the start of the check, joined at EWS_JOIN_SIM_
 * or more: [{post, cluster, sim}] for the joins. Pure.
 */
function ewsNearestStories_(posts, clusters) {
  const cents = clusters.map(c => ({ c, v: ewsCentroid_(c) })).filter(x => x.v);
  const out = [];
  posts.forEach(p => {
    if (!p.vec) return;
    let best = null;
    let bestSim = EWS_JOIN_SIM_;
    cents.forEach(x => {
      const s = ewsDot_(p.vec, x.v);
      if (s >= bestSim) { best = x.c; bestSim = s; }
    });
    if (best) out.push({ post: p, cluster: best, sim: bestSim });
  });
  return out;
}

/**
 * Stage B (03's new clusters, around this check's new posts): neighbours at EWS_START_SIM_ or more (the EWS_TOP_K_
 * closest, the post itself included, as VECTOR_SEARCH over one table returns it) of each new post (index >= newFrom)
 * and of each pool post one of them touched; an anchor has 2+ distinct authors among its neighbours; each neighbour
 * goes to its best anchor (most distinct authors, earliest posted, closest); an anchor with 2+ posts is a new story.
 * [{anchor, members: [[index, sim]]}] over `universe`. Pure.
 */
function ewsDiscover_(universe, newFrom) {
  const n = universe.length;
  const memo = new Map();
  const neighbours = i => {
    if (memo.has(i)) return memo.get(i);
    const v = universe[i].vec;
    const list = [];
    for (let j = 0; j < n; j++) {
      const s = i === j ? 1 : ewsDot_(v, universe[j].vec);
      if (s >= EWS_START_SIM_) list.push([j, s]);
    }
    list.sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    const top = list.slice(0, EWS_TOP_K_);
    memo.set(i, top);
    return top;
  };
  const cand = new Set();
  for (let i = newFrom; i < n; i++) {
    cand.add(i);
    neighbours(i).forEach(([j]) => cand.add(j));
  }
  const anchors = new Map();
  cand.forEach(i => {
    const deg = new Set(neighbours(i).map(([j]) => universe[j].ak)).size;
    if (deg >= 2) anchors.set(i, deg);
  });
  const best = new Map();
  anchors.forEach((deg, a) => {
    neighbours(a).forEach(([j, s]) => {
      const cur = best.get(j);
      const ta = universe[a].t;
      const better = !cur || deg > cur.deg || (deg === cur.deg && (ta < universe[cur.a].t ||
        (ta === universe[cur.a].t && (s > cur.s || (s === cur.s && a < cur.a)))));
      if (better) best.set(j, { a, deg, s });
    });
  });
  const groups = new Map();
  best.forEach((b, j) => { if (!groups.has(b.a)) groups.set(b.a, []); groups.get(b.a).push([j, b.s]); });
  return Array.from(groups.entries()).filter(([, m]) => m.length >= 2)
    .sort((x, y) => x[0] - y[0]).map(([a, m]) => ({ anchor: a, members: m }));
}

/** A new story's id: 'CLU-' and 12 hex of SHA-256 of its anchor post's id (03). */
function ewsClusterId_(anchorId) {
  return 'CLU-' + ewsSha_(anchorId).slice(0, 12);
}

/**
 * Tidies the stories after a check: members from the last day only (the newest EWS_MEMBERS_MAX_), label (the shortest
 * member text, 140 characters at most), centroid stored, idle stories let go, at most EWS_CLUSTERS_MAX_ (the smallest
 * and stalest go). Pure (but for the objects).
 */
function ewsTidyStories_(clusters, now) {
  const live = clusters.filter(c => now - (Number(c.ts) || 0) < EWS_ACTIVE_MS_);
  live.forEach(c => {
    c.m = (c.m || []).filter(m => now - Math.max(Number(m.t) || 0, Number(m.j) || 0) < EWS_ACTIVE_MS_)
      .sort((a, b) => (Number(b.t) || 0) - (Number(a.t) || 0)).slice(0, EWS_MEMBERS_MAX_);
    const texts = c.m.map(m => String(m.s || '')).filter(Boolean).sort((a, b) => a.length - b.length);
    if (texts.length) c.lab = truncate_(texts[0], 140);
    if (c._sum) c.s = ewsEnc_(c._sum);
    const tp = c.tp || {};
    c.tp = {};
    Object.keys(tp).sort((a, b) => tp[b] - tp[a]).slice(0, 6).forEach(k => { c.tp[k] = tp[k]; });
    if (c.hc) Object.keys(c.hc).forEach(h => { if (Number(h) < Math.floor(now / 3600000) - 30) delete c.hc[h]; });
  });
  const authors = c => new Set((c.m || []).map(m => m.a)).size;
  return live.sort((a, b) => authors(b) - authors(a) || (Number(b.ts) || 0) - (Number(a.ts) || 0)).slice(0, EWS_CLUSTERS_MAX_);
}

/** A story as stored in the cache (no working fields). Pure. */
function ewsStoredStory_(c) {
  const out = {};
  ['id', 's', 'n', 't0', 'ts', 'lab', 'tp', 'm', 'al', 'hc'].forEach(k => { if (c[k] !== undefined && c[k] !== null) out[k] = c[k]; });
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Promotion and same-story dedup (03)
// ---------------------------------------------------------------------------------------------------------------

/** The representative posts: one per account, the closest to the story then the most engaged, at most 8. Pure. */
function ewsRepsOf_(members, order) {
  const byAuthor = new Map();
  (members || []).forEach(m => {
    const cur = byAuthor.get(m.a);
    if (!cur || order(m, cur) < 0) byAuthor.set(m.a, m);
  });
  return Array.from(byAuthor.values()).sort(order).slice(0, typeof ED_POSTS_MAX_ === 'number' ? ED_POSTS_MAX_ : 8);
}

/** representative_posts_json: the view's struct (mention_id, platform, author_id, audience_size, engagement, posted_at, url, snippet). Pure. */
function ewsRepsJson_(reps) {
  return JSON.stringify((reps || []).map(m => ({
    mention_id: String(m.i || ''), platform: m.p || '', author_id: String(m.a || '').replace(/^[^:]*:/, ''),
    audience_size: m.f === undefined ? null : m.f, engagement: m.e === undefined ? null : m.e,
    posted_at: ewsIso_(m.t), url: m.u || '', snippet: truncate_(String(m.s || ''), EWS_SNIPPET_CHARS_),
  })));
}

/** True when a new lane's member is left out of the bar: its author is excluded, or its post was big for Sonar. Pure. */
function ewsNewLeftOut_(m, lim) {
  if (!m || !m.nl || !lim) return false;
  return !!((lim.authors && lim.authors.has(String(m.a || '').replace(/^[^:]*:/, '').toLowerCase())) || (lim.big && m.k && lim.big.has(m.k)));
}

/**
 * A story's numbers over the last 180 minutes (03's eval_window): {members, authors, platforms (sorted), urls, texts,
 * risk, brand, start, end, reps}, or null when nothing in it is that recent. With new lanes' members (nl): `lim`
 * ({authors, big}: ewsNewLeaveOut_) leaves out the ones ewsNewLeftOut_ names; `platforms` counts only platforms with a
 * member from today's lanes, `allPlatforms` has them all, and `todayAuthors` counts today's lanes' accounts alone.
 * With none, exactly as before. Pure.
 */
function ewsStoryWindow_(c, now, lim) {
  let win = (c.m || []).filter(m => (Number(m.t) || 0) >= now - EWS_EVAL_MS_ && (Number(m.t) || 0) <= now + 5 * 60000);
  const nl = win.some(m => m.nl);
  if (nl && lim) win = win.filter(m => !ewsNewLeftOut_(m, lim));
  if (!win.length) return null;
  const counted = nl ? win.filter(m => !m.nl) : win;
  const platforms = Array.from(new Set(counted.map(m => m.p).filter(Boolean))).sort();
  const order = (x, y) => (Number(y.d) || 0) - (Number(x.d) || 0) || (Number(y.e) || 0) - (Number(x.e) || 0) || (Number(y.t) || 0) - (Number(x.t) || 0);
  const w = {
    members: win.length,
    authors: new Set(win.map(m => m.a)).size,
    platforms,
    urls: new Set(win.map(m => normalizeUrl_(m.u) || m.u)).size,
    texts: new Set(win.map(m => m.h || m.i)).size,
    risk: Array.from(new Set([].concat.apply([], win.map(m => (m.r ? String(m.r).split(',') : []))))),
    brand: win.some(m => m.b || new RegExp(EWS_ENTITY_RX_, 'i').test(String(m.s || ''))),
    start: Math.min.apply(null, win.map(m => Number(m.t) || now)),
    end: Math.max.apply(null, win.map(m => Number(m.t) || now)),
    reps: ewsRepsOf_(win, order),
  };
  if (nl) {
    w.allPlatforms = Array.from(new Set(win.map(m => m.p).filter(Boolean))).sort();
    w.todayAuthors = new Set(counted.map(m => m.a)).size;
  }
  return w;
}

/** A story's topic: its most frequent source topic ('Brand' when none). Pure. */
function ewsStoryTopic_(c) {
  const tp = c.tp || {};
  const top = Object.keys(tp).sort((a, b) => tp[b] - tp[a] || (a < b ? -1 : 1))[0];
  return top && !EWS_NO_TOPIC_RX_.test(top) ? top : 'Brand';
}

/**
 * The same-story check against the stories alerted in the last 24 hours (`priors`: [{id, cid, at, au, pl, vec}]): {hits,
 * allowed, latest}. Allowed when nothing like it was alerted, or when it grew past every one of them (2x the accounts
 * and 3 more, or a platform it didn't have). Pure.
 */
function ewsStoryCheck_(cand, priors, now) {
  const hits = (priors || []).filter(p => now - (Number(p.at) || 0) < EWS_STORY_MS_ &&
    (p.cid === cand.id || (p.vec && cand.vec && ewsDot_(p.vec, cand.vec) >= EWS_STORY_SIM_)));
  if (!hits.length) return { hits, allowed: true, latest: null };
  const grew = p => (cand.authors >= (Number(p.au) || 0) * EWS_UPDATE_GROWTH_ && cand.authors - (Number(p.au) || 0) >= EWS_UPDATE_NEW_) ||
    ((p.pl || []).length > 0 && cand.platforms.some(x => (p.pl || []).indexOf(x) < 0));
  const latest = hits.slice().sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0) || (a.id < b.id ? 1 : -1))[0];
  return { hits, allowed: hits.every(grew), latest };
}

/**
 * The stories worth a signal this check (03's tmp_cluster_candidates and story check): 5+ distinct accounts (4 on
 * 2+ platforms), 2+ links, not a copy-paste ring that never names Google, out of its cooldown (or 2x the accounts of its
 * last signal), and not a story already told (unless it grew: then an update); of two candidates telling one story the
 * one with more accounts; at most EWS_MAX_ALERTS_ (P0 > P1 > P2, then accounts, platforms, the latest). With new
 * lanes' members, `lim` and the platforms rule of ewsStoryWindow_ apply, and a story that today's lanes' members alone
 * would not get through (the accounts, the links, the copy-paste test, the cooldown or the same-story check, each
 * worked out on a window of today's lanes' members only) is marked `lifted` (ewsLiftGate_ decides whether it goes for
 * review). Pure.
 */
function ewsPromote_(clusters, priors, now, lim) {
  const cands = [];
  // the bar on a window `w` of story `c` (its own accounts' bar: 4 on two platforms of today's lanes, else 5)
  const passes = (c, w) => {
    const minAuthors = Math.max(2, EWS_MIN_AUTHORS_ - (w.platforms.length >= 2 ? EWS_PLATFORM_DISCOUNT_ : 0));
    if ((w.allPlatforms || w.platforms).length < 1 || w.urls < EWS_MIN_URLS_ || w.authors < minAuthors) return false;
    const al = c.al;
    if (al && now - (Number(al.at) || 0) < EWS_CLUSTER_COOLDOWN_MS_ && w.authors < (Number(al.au) || 0) * 2) return false;
    if (w.texts * 3 <= w.authors && !w.brand) return false;  // a copy-paste ring that never names Google
    return true;
  };
  clusters.forEach(c => {
    const w = ewsStoryWindow_(c, now, lim);
    if (!w || !passes(c, w)) return;
    const x = Object.assign({ c, id: c.id, vec: ewsCentroid_(c), priority: w.risk.length || w.platforms.length >= 2 ? 'P1' : 'P2' }, w);
    if (w.allPlatforms) {  // new lanes' members in the window: would today's lanes' members alone pass?
      const alone = ewsStoryWindow_(Object.assign({}, c, { m: (c.m || []).filter(m => !m.nl) }), now);
      if (!alone || !passes(c, alone)) x.lifted = true;
      else x.alone = alone;
    }
    cands.push(x);
  });
  const allowed = [];
  cands.forEach(x => {
    const chk = ewsStoryCheck_(x, priors, now);
    if (!chk.allowed) return;
    // a story today's lanes alone would have as "already told" (no growth of their own) is lifted by the new lanes
    if (x.alone && !ewsStoryCheck_(Object.assign({}, x, { authors: x.alone.authors, platforms: x.alone.platforms }), priors, now).allowed) x.lifted = true;
    delete x.alone;
    x.update = chk.latest ? { id: chk.latest.id, au: Number(chk.latest.au) || 0 } : null;
    allowed.push(x);
  });
  const kept = allowed.filter(a => !allowed.some(b => b !== a && (b.authors > a.authors || (b.authors === a.authors && b.id < a.id)) &&
    a.vec && b.vec && ewsDot_(a.vec, b.vec) >= EWS_STORY_SIM_));
  return kept.sort((a, b) => ewsPri_(a.priority) - ewsPri_(b.priority) || b.authors - a.authors ||
    b.platforms.length - a.platforms.length || b.end - a.end || (a.id < b.id ? -1 : 1)).slice(0, EWS_MAX_ALERTS_);
}

// ---------------------------------------------------------------------------------------------------------------
// Velocity (analytics/early_detection/04): accounts per hour per cluster, risk-term group and topic
// ---------------------------------------------------------------------------------------------------------------

/** The velocity keys of a real-time post: its risk-term groups and its topic ('R|group', 'T|topic'). Pure. */
function ewsKeysOf_(p) {
  const keys = (p.risk || []).map(g => `R|${g}`);
  if (!EWS_NO_TOPIC_RX_.test(String(p.topic || ''))) keys.push(`T|${p.topic}`);
  return keys;
}

/** The accounts of the last hours (cache 'acc'): {rows: [[minute, account, platform, [keys], post]]}. Pure. */
function ewsAcc_(raw) {
  const a = raw && typeof raw === 'object' ? raw : {};
  const keys = Array.isArray(a.keys) ? a.keys : [];
  const rows = (Array.isArray(a.rows) ? a.rows : []).filter(r => Array.isArray(r) && r.length >= 4)
    .map(r => [Number(r[0]) || 0, String(r[1]), String(r[2] || ''), (r[3] || []).map(i => keys[i]).filter(Boolean), String(r[4] || '')]);
  return { rows };
}

/** The accounts as stored: the keys as indexes into one list. Pure. */
function ewsAccStored_(acc) {
  const keys = [];
  const index = new Map();
  const id = k => { if (!index.has(k)) { index.set(k, keys.length); keys.push(k); } return index.get(k); };
  return { keys, rows: acc.rows.map(r => [r[0], r[1], r[2], r[3].map(id), r[4]]) };
}

/**
 * Counts every hour that ended more than EWS_OPEN_HOURS_ ago for good: its distinct accounts per key go into the
 * rollup (topic and risk-group keys: the last 6 hours and the same-hour mean; cluster keys: the story's hourly counts),
 * and its rows are dropped. Only hours a check read count (a paused hour is no data, not a quiet hour). Pure (but for
 * the objects).
 */
function ewsCloseHours_(acc, roll, clusters, now) {
  const lastOpen = Math.floor(now / 3600000) - EWS_OPEN_HOURS_;
  const hours = Array.from(new Set(acc.rows.map(r => Math.floor(r[0] / 60)))).filter(h => h < lastOpen).sort((a, b) => a - b);
  const covered = new Set(roll.cov || []);
  const byId = new Map(clusters.map(c => [c.id, c]));
  hours.forEach(h => {
    const counts = new Map();
    acc.rows.forEach(r => {
      if (Math.floor(r[0] / 60) !== h) return;
      r[3].forEach(k => { if (!counts.has(k)) counts.set(k, new Set()); counts.get(k).add(r[1]); });
    });
    if (covered.has(h)) {
      const hod = ((h % 24) + 24) % 24;
      const days = Math.min(EWS_BASE_DAYS_, Number(roll.n[hod]) || 0);
      const keys = new Set(Object.keys(roll.k).concat(Array.from(counts.keys()).filter(k => k.indexOf('C|') !== 0)));
      keys.forEach(k => {
        const n = counts.has(k) ? counts.get(k).size : 0;
        const e = roll.k[k] || (roll.k[k] = { d: new Array(24).fill(0), r: {} });
        // the same-hour mean over the days seen (a week at most, then a 7-day moving mean)
        e.d[hod] = days < EWS_BASE_DAYS_ ? (e.d[hod] * days + n) / (days + 1) : e.d[hod] + (n - e.d[hod]) / EWS_BASE_DAYS_;
        if (n) e.r[h] = n;
        Object.keys(e.r).forEach(x => { if (Number(x) < h - EWS_ROLL_HOURS_ - 2) delete e.r[x]; });
      });
      roll.n[hod] = Math.min(EWS_BASE_DAYS_, days + 1);
    }
    counts.forEach((set, k) => {
      if (k.indexOf('C|') !== 0) return;
      const c = byId.get(k.slice(2));
      if (c) { c.hc = c.hc || {}; c.hc[h] = set.size; }
    });
    acc.rows = acc.rows.filter(r => Math.floor(r[0] / 60) !== h);
  });
  roll.cov = (roll.cov || []).filter(h => h >= Math.floor(now / 3600000) - 48);
}

/** Distinct accounts of `key` in hour `h`: from the open rows, else what the rollup / story counted. Pure. */
function ewsHourCount_(acc, roll, cluster, key, h) {
  const set = new Set();
  let open = false;
  acc.rows.forEach(r => { if (Math.floor(r[0] / 60) === h) { open = true; if (r[3].indexOf(key) >= 0) set.add(r[1]); } });
  if (open && set.size) return set.size;
  if (key.indexOf('C|') === 0) return cluster && cluster.hc ? Number(cluster.hc[h]) || 0 : 0;
  const e = roll.k[key];
  return e && e.r ? Number(e.r[h]) || 0 : 0;
}

/**
 * The velocity spikes this check (04): per key, distinct accounts in the last 60 minutes against raw = max(same-hour
 * mean over the week, half the last 6 hours' mean); ratio = current / (raw + 2). A spike: 4+ accounts for a cluster,
 * 8+ otherwise, and 3x or 12 more than raw; out of its 3-hour cooldown (or 1.75x its last); a cluster's spike on a story
 * already told needs 2x and 3 more of the most accounts any of its signals had. Waits for 24 hours of history. At most
 * EWS_MAX_ALERTS_ (P0, then ratio, accounts). Pure.
 */
function ewsVelocity_(acc, roll, clusters, priors, now) {
  if (!(Number(roll.since) > 0) || now - Number(roll.since) < EWS_WARMUP_MS_) return [];
  const nowMin = Math.floor(now / 60000);
  const hour = Math.floor(now / 3600000);
  const hod = ((hour % 24) + 24) % 24;
  const days = Math.max(1, Math.min(EWS_BASE_DAYS_, Number(roll.n[hod]) || 0));
  const byId = new Map(clusters.map(c => [c.id, c]));
  const cur = new Map();
  acc.rows.forEach(r => {
    if (r[0] < nowMin - EWS_VEL_WINDOW_MIN_ || r[0] > nowMin + 5) return;
    r[3].forEach(k => {
      if (!cur.has(k)) cur.set(k, { authors: new Set(), mentions: 0, platforms: new Set(), posts: new Set() });
      const x = cur.get(k);
      x.authors.add(r[1]);
      x.mentions++;
      if (r[2]) x.platforms.add(r[2]);
      if (r[4]) x.posts.add(r[4]);
    });
  });
  const out = [];
  cur.forEach((x, key) => {
    const grain = key.indexOf('C|') === 0 ? 'CLUSTER' : key.indexOf('R|') === 0 ? 'RISK_TERM_GROUP' : 'PRIORITY_TOPIC';
    const name = key.slice(2);
    const cluster = grain === 'CLUSTER' ? byId.get(name) : null;
    if (grain === 'CLUSTER' && !cluster) return;
    const current = x.authors.size;
    if (current < (grain === 'CLUSTER' ? EWS_MIN_CLUSTER_VEL_AUTHORS_ : EWS_MIN_TERM_VEL_AUTHORS_)) return;
    let rolling = 0;
    for (let i = 1; i <= EWS_ROLL_HOURS_; i++) rolling += ewsHourCount_(acc, roll, cluster, key, hour - i);
    rolling /= EWS_ROLL_HOURS_;
    let diurnal = 0;
    if (grain === 'CLUSTER') {
      let sum = 0;
      for (let d = 1; d <= EWS_BASE_DAYS_; d++) sum += cluster.hc ? Number(cluster.hc[hour - 24 * d]) || 0 : 0;
      diurnal = sum / days;
    } else {
      const e = roll.k[key];
      diurnal = e ? Number(e.d[hod]) || 0 : 0;
    }
    const raw = Math.max(diurnal, 0.5 * rolling) * (EWS_VEL_WINDOW_MIN_ / 60);
    const ratio = current / (raw + EWS_ALPHA_);
    if (!(ratio >= EWS_MIN_MULT_ || current - raw >= EWS_HARD_DELTA_)) return;
    const cool = roll.cool[`${grain}|${name}`];
    if (cool && now - (Number(cool[0]) || 0) < EWS_VEL_COOLDOWN_MS_ && current < (Number(cool[1]) || 0) * EWS_VEL_COOLDOWN_GROWTH_) return;
    if (grain === 'CLUSTER') {
      const vec = ewsCentroid_(cluster);
      const prior = (priors || []).filter(p => now - (Number(p.at) || 0) < EWS_STORY_MS_ &&
        (p.cid === name || (p.vec && vec && ewsDot_(p.vec, vec) >= EWS_STORY_SIM_)))
        .reduce((m, p) => Math.max(m, Number(p.au) || 0), -1);
      if (prior >= 0 && !(current >= prior * EWS_UPDATE_GROWTH_ && current - prior >= EWS_UPDATE_NEW_)) return;
    }
    const tier = grain === 'RISK_TERM_GROUP' ? (EWS_RISK_GROUPS_.find(g => g.key === name) || {}).tier : '';
    out.push({ grain, key: name, cluster, current, mentions: x.mentions, platforms: Array.from(x.platforms).sort(),
      posts: x.posts, raw, ratio, priority: tier || (ratio >= 5 ? 'P1' : 'P2') });
  });
  return out.sort((a, b) => ewsPri_(a.priority) - ewsPri_(b.priority) || b.ratio - a.ratio || b.current - a.current ||
    (a.grain < b.grain ? -1 : a.grain > b.grain ? 1 : a.key < b.key ? -1 : 1)).slice(0, EWS_MAX_ALERTS_);
}

// ---------------------------------------------------------------------------------------------------------------
// Rows (the EarlyWaveRow contract)
// ---------------------------------------------------------------------------------------------------------------

/** The taxonomy hint of a vector: {line, raise} ('P1' when the nearest Exposure Tag is P0/P1 at EWS_TAG_RAISE_SIM_+). Pure. */
function ewsTagHint_(hint) {
  if (!hint) return { line: '', raise: '' };
  const top = (hint.exposure || [])[0];
  const raise = top && Number(top.sim) >= EWS_TAG_RAISE_SIM_ && ewsPri_(top.priority) <= 1 ? 'P1' : '';
  return { line: typeof vecTagHintLine_ === 'function' ? vecTagHintLine_(hint) : '', raise };
}

/**
 * A cluster signal as an EarlyWaveRow (03's queue insert). With `facts` (the fast triage asked: ewsRows_'s opts), also
 * its risk-term groups (`risk_groups`: a comma list, '' for none) and whether a taxonomy hint raised it (`tag_raised`:
 * the nearest Exposure Tag is P0 / P1 at EWS_TAG_RAISE_SIM_ or more). Pure.
 */
function ewsClusterRow_(x, now, tag, facts) {
  const t = tag || { line: '', raise: '' };
  const priority = ewsPri_(t.raise) < ewsPri_(x.priority) ? t.raise : x.priority;
  const row = {
    alert_id: `ED-CLU-${x.id}-${ewsStamp_(now)}`,
    created_utc: ewsCreatedUtc_(now),
    signal_type: 'CLUSTER_EMERGENCE',
    velocity_grain: '',
    cluster_id: x.id,
    signal_key: x.id,
    headline: `Low-tier claim cluster (${x.authors} accounts): ${truncate_(String(x.c.lab || ''), 140)}`,
    topic_product: ewsStoryTopic_(x.c),
    priority_hint: priority,
    unique_low_tier_authors: x.authors,
    mention_count: Math.max(x.authors, x.members),
    platform_count: (x.allPlatforms || x.platforms).length,  // every platform shown; the bar counts x.platforms
    platforms_csv: (x.allPlatforms || x.platforms).join(', '),
    baseline_authors: 0,
    velocity_ratio: 0,
    absolute_author_delta: 0,
    primary_url: (x.reps[0] && x.reps[0].u) || '',
    window_start_utc: ewsIso_(x.start),
    window_end_utc: ewsIso_(x.end),
    representative_posts_json: ewsRepsJson_(x.reps),
    chatbot_card_text: '',
    update_of_alert_id: x.update ? x.update.id : '',
    update_of_authors: x.update ? x.update.au : 0,
    taxonomy_hint: t.line,
  };
  if (facts) {
    row.risk_groups = (x.risk || []).join(',');
    row.tag_raised = !!t.raise;
  }
  return row;
}

/**
 * A velocity spike as an EarlyWaveRow (04's queue insert); null without a post to cite. With `facts`, also its
 * risk-term groups (a risk-term spike's own group and its posts') and whether a taxonomy hint raised it, as
 * ewsClusterRow_. Pure.
 */
function ewsVelocityRow_(v, reps, now, tag, facts) {
  if (!reps || !reps.length) return null;
  const t = tag || { line: '', raise: '' };
  const priority = ewsPri_(t.raise) < ewsPri_(v.priority) ? t.raise : v.priority;
  const label = v.cluster ? String(v.cluster.lab || '') : v.key;
  const topics = {};
  reps.forEach(m => { const k = m.tp && !EWS_NO_TOPIC_RX_.test(m.tp) ? m.tp : 'Brand'; topics[k] = (topics[k] || 0) + 1; });
  const topic = v.grain === 'PRIORITY_TOPIC' ? v.key : Object.keys(topics).sort((a, b) => topics[b] - topics[a])[0] || 'Brand';
  const row = {
    alert_id: `ED-VEL-${v.grain}-${ewsSha_(v.key).slice(0, 32)}-${ewsStamp_(now)}`,
    created_utc: ewsCreatedUtc_(now),
    signal_type: 'VELOCITY_SPIKE',
    velocity_grain: v.grain,
    cluster_id: v.grain === 'CLUSTER' ? v.key : '',
    signal_key: v.key,
    headline: `Low-tier velocity ${v.ratio.toFixed(1)}x (${v.grain}: ${truncate_(label, 140)})`,
    topic_product: topic,
    priority_hint: priority,
    unique_low_tier_authors: v.current,
    mention_count: Math.max(v.current, v.mentions),
    platform_count: v.platforms.length,
    platforms_csv: v.platforms.join(', '),
    baseline_authors: Math.round(v.raw * 100) / 100,
    velocity_ratio: Math.round(v.ratio * 100) / 100,
    absolute_author_delta: Math.round((v.current - v.raw) * 100) / 100,
    primary_url: reps[0].u || '',
    window_start_utc: ewsIso_(now - EWS_VEL_WINDOW_MIN_ * 60000),
    window_end_utc: ewsIso_(now),
    representative_posts_json: ewsRepsJson_(reps),
    chatbot_card_text: '',
    update_of_alert_id: '',
    update_of_authors: 0,
    taxonomy_hint: t.line,
  };
  if (facts) {
    const groups = v.grain === 'RISK_TERM_GROUP' ? [v.key] : [];
    reps.forEach(m => (m.r ? String(m.r).split(',') : []).forEach(g => { if (g && groups.indexOf(g) < 0) groups.push(g); }));
    row.risk_groups = groups.join(',');
    row.tag_raised = !!t.raise;
  }
  return row;
}

// ---------------------------------------------------------------------------------------------------------------
// The early watch: stories still below the promotion bar, raised on the fast triage's answers
// ---------------------------------------------------------------------------------------------------------------

/**
 * The early watch's bars ({about, risk, independent, conf, accounts}), from `bars` or ftBars_(): FastTriage.gs' bars
 * ({watch: the about_google and brand_risk bar, independent, conf, accounts}; their `about` is the hold-back's bar and
 * is not read here), or the five by name. A bar that isn't given is its seed. Pure with `bars`.
 */
function ewsWatchBars_(bars) {
  const b = (bars && typeof bars === 'object' ? bars : null) || (typeof ftBars_ === 'function' ? ftBars_() : {});
  const seeds = typeof FT_BAR_SEEDS_ !== 'undefined' ? FT_BAR_SEEDS_ : { conf: 0.55, watch: 0.80, independent: 0.30 };
  const num = (v, d) => (isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  const hasWatch = num(b.watch, 0) > 0;
  const w = num(b.watch, seeds.watch);
  return {
    about: hasWatch ? w : num(b.about, w),
    risk: num(b.risk, w),
    independent: num(b.independent, seeds.independent),
    conf: num(b.conf, seeds.conf),
    accounts: isFinite(Number(b.accounts)) && Number(b.accounts) >= 2 ? Math.round(Number(b.accounts)) : EWS_WATCH_MIN_AUTHORS_,
  };
}

/**
 * True when the fast triage's answers (`dec`: Decisions.gs decCompact_) raise an early-watch story: about_google and
 * brand_risk each at or above the watch bar, independent_reports at or above its own bar, the answer's confidence at
 * or above the confidence bar (an answer without one raises nothing), and the most probable severity level at
 * EWS_WATCH_MIN_LEVEL_ or higher. Pure.
 */
function ewsWatchRaise_(dec, bars) {
  if (!dec) return false;
  const b = ewsWatchBars_(bars);
  return Number(dec.g) >= b.about && Number(dec.r) >= b.risk && Number(dec.i) >= b.independent &&
    Number(dec.sc) >= b.conf && Number(dec.l) >= EWS_WATCH_MIN_LEVEL_;
}

/** The stories asked about lately (cache 'wt'): {cluster id: [when, accounts then, 1 when it was raised]}. Never throws. */
function ewsWatchMarks_(cache, now) {
  const raw = ewsCacheGet_(cache, 'wt');
  const out = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    Object.keys(raw).forEach(k => {
      const v = raw[k];
      if (Array.isArray(v) && now - (Number(v[0]) || 0) < EWS_ACTIVE_MS_) out[k] = [Number(v[0]) || 0, Number(v[1]) || 0, v[2] ? 1 : 0];
    });
  }
  return out;
}

/**
 * The stories worth asking the fast triage about this check, still below the promotion bar: `minAuthors` (default: the
 * Control tab's distinct-accounts watch bar, seed EWS_WATCH_MIN_AUTHORS_ = 3) accounts or more in the last 180 minutes
 * (at the bar a story is ewsPromote_'s), 2+ links, not a copy-paste ring that never names Google, not signalled within
 * its cooldown, not raised before nor asked about at this size (`marks`), and not a story already told (`priors`: its
 * updates are ewsPromote_'s). Risk-term stories first, then the most accounts, the latest; EWS_WATCH_PICK_MAX_ at most.
 * Each as ewsPromote_'s candidates (the window's numbers, `c`, `id`, `vec`, `priority`). `lim` (optional, the new
 * lanes' leave-out lists: ewsNewLeaveOut_) leaves out the new lanes' members ewsNewLeftOut_ names. A pick that today's
 * lanes' members alone would not get (the accounts, the links, the copy-paste test, the cooldown or the marks) is marked
 * `lifted` (ewsLiftWatch_ holds it in the trial; ewsWatchAsk_ keeps it inside the two caps). Pure.
 */
function ewsWatchPick_(clusters, priors, marks, now, minAuthors, lim) {
  const minAu = isFinite(Number(minAuthors)) && Number(minAuthors) >= 2 ? Math.round(Number(minAuthors))
    : ewsWatchBars_().accounts;
  const out = [];
  // the watch's tests on a window `w` of story `c`, but the upper bar (its accounts, links, copy-paste, cooldown, marks)
  const fits = (c, w) => {
    if (w.authors < minAu) return false;
    if (w.platforms.length < 1 || w.urls < EWS_MIN_URLS_) return false;
    if (w.texts * 3 <= w.authors && !w.brand) return false;  // a copy-paste ring that never names Google
    if (c.al && now - (Number(c.al.at) || 0) < EWS_CLUSTER_COOLDOWN_MS_) return false;
    const mark = (marks || {})[c.id];
    if (mark && (mark[2] || w.authors <= (Number(mark[1]) || 0))) return false;
    return true;
  };
  clusters.forEach(c => {
    const w = ewsStoryWindow_(c, now, lim);
    if (!w) return;
    const bar = Math.max(2, EWS_MIN_AUTHORS_ - (w.platforms.length >= 2 ? EWS_PLATFORM_DISCOUNT_ : 0));
    if (w.authors >= bar || !fits(c, w)) return;
    const x = Object.assign({ c, id: c.id, vec: ewsCentroid_(c), priority: w.risk.length || w.platforms.length >= 2 ? 'P1' : 'P2' }, w);
    if (ewsStoryCheck_(x, priors, now).hits.length) return;
    if (w.allPlatforms) {  // new lanes' members in the window: would today's lanes' members alone be picked?
      const alone = ewsStoryWindow_(Object.assign({}, c, { m: (c.m || []).filter(m => !m.nl) }), now);
      if (!alone || !fits(c, alone)) x.lifted = true;
    }
    out.push(x);
  });
  return out.sort((a, b) => (b.risk.length ? 1 : 0) - (a.risk.length ? 1 : 0) || b.authors - a.authors || b.end - a.end ||
    (a.id < b.id ? -1 : 1)).slice(0, EWS_WATCH_PICK_MAX_);
}

/** True when no older stored story tells what candidate `x` tells (none within EWS_STORY_SIM_ of its centroid). Pure. */
function ewsWatchNovel_(x, clusters) {
  if (!x || !x.vec) return false;
  const born = Number(x.c.t0) || 0;
  return !clusters.some(y => {
    if (y === x.c || !((Number(y.t0) || 0) < born)) return false;
    const v = ewsCentroid_(y);
    return !!v && ewsDot_(v, x.vec) >= EWS_STORY_SIM_;
  });
}

/**
 * An early-watch story as an EarlyWaveRow: a cluster's row (with its risk groups and taxonomy hint) under its own
 * signal type, alert id and headline. Pure.
 */
function ewsWatchRow_(x, now, tag) {
  const row = ewsClusterRow_(x, now, tag, true);
  row.alert_id = `ED-WAT-${x.id}-${ewsStamp_(now)}`;
  row.signal_type = EWS_WATCH_SIGNAL_;
  row.headline = `Early story (${x.authors} accounts): ${truncate_(String(x.c.lab || ''), 140)}`;
  return row;
}

/**
 * Asks the caller's fast triage about this check's early-watch stories (`cands`: [{cid, authors, row, lift?}], in order) once
 * the check's state is saved: EWS_WATCH_MAX_PER_CHECK_ a check and EWS_WATCH_MAX_PER_DAY_ a day; it stops at the first
 * story the fast triage isn't asking about now (a cap, a pause: asked at a later check). A story asked about is
 * marked (never asked again at that size) and told to the caller (`watch.done`); one the answers raise
 * (ewsWatchRaise_) goes into the buffer with them, as a signal of its own. A story only the new lanes lifted
 * (`lift`: ewsLiftWatch_) is skipped while the two caps of lifted stories have no room, and counts against them (and
 * is listed in EWS_SRC_DAY) once raised; with no such story EWS_SRC_DAY is not read. Never throws.
 */
function ewsWatchAsk_(cache, props, st, now, cands, watch, record) {
  try {
    const marks = ewsWatchMarks_(cache, now);
    const day = st.day || {};
    let today = Number(day.watch) || 0;
    let asked = 0;
    const raised = [];
    let lift = null;  // the new sources' day record, read only for a story only they lifted ({rec, cfg, up})
    for (const x of cands) {
      if (asked >= EWS_WATCH_MAX_PER_CHECK_ || today >= EWS_WATCH_MAX_PER_DAY_) break;
      if (x.lift) {  // lifted by the new lanes alone: asked only while the hour's and the day's caps have room
        if (!lift) {
          const cfg = ewsNewCfg_();
          lift = { cfg, rec: ewsLiftRec_({ day: ewsUtcDay_(now) }, now, props), up: false };
        }
        if (!(Number(lift.rec.lh[1]) < lift.cfg.liftedPerHour && Number(lift.rec.ld[1]) < lift.cfg.liftedPerDay)) continue;
      }
      const res = watch.ask(x.row);
      if (!res || res.skipped) break;
      asked++;
      today++;
      const up = !!(res.ok && ewsWatchRaise_(res.dec, watch && watch.bars));
      marks[x.cid] = [now, x.authors, up ? 1 : 0];
      if (up && x.lift) {  // a lifted story raised: it counts against the two caps and is listed for the tab
        const rec = lift.rec;
        rec.lh[1] = Number(rec.lh[1]) + 1;
        rec.ld[1] = Number(rec.ld[1]) + 1;
        const before = rec.ls.find(e => e[1] === x.cid);
        if (before) rec.ls.splice(rec.ls.indexOf(before), 1);
        rec.ls.push([now, x.cid, x.authors, Number(x.lift.links) || 0, nsrcScrub_(x.row.headline, 100), 1, (x.lift.sources || []).join(','), 0]);
        rec.ls = rec.ls.slice(-EWS_LIFTED_KEPT_);
        lift.up = true;
      }
      if (up) {
        const raisedRow = Object.assign({ _at: now }, x.row, { dec: res.dec });
        raised.push(raisedRow);
        if (record && Array.isArray(record.signals)) record.signals.push(raisedRow);
      }
      if (typeof watch.done === 'function') watch.done(x.row, res, up);
    }
    if (lift && lift.up) ewsSaveSrcDay_(props, lift.rec, now);
    if (!asked) return;
    const keep = {};
    Object.keys(marks).sort((a, b) => marks[b][0] - marks[a][0]).slice(0, EWS_WATCH_MARKS_MAX_).forEach(k => { keep[k] = marks[k]; });
    const items = { wt: keep };
    if (raised.length) {
      ewsBufferPut_(items, st, ewsReadBuffer_(cache, st).filter(r => raised.every(x => x.alert_id !== r.alert_id)).concat(raised));
    }
    ewsCachePut_(cache, items);
    st.day = Object.assign({}, day, { watch: today });
    if (st.last) st.last.watch = { picked: cands.length, asked, raised: raised.length };
    ewsSaveState_(props, st);
  } catch (e) {
    console.warn(`Early wave: the early watch stopped: ${(e && e.message) || e}`);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The new sources inside the check (none is read while its Control row is OFF)
// ---------------------------------------------------------------------------------------------------------------

/** The new sources whose Control switch is ON in `sw` ('ami', 'bwl', or a lane def's own `src`), in order. Pure. */
function ewsNewSources_(sw) {
  const on = sw && typeof sw === 'object' ? sw : {};
  const out = [];
  Object.keys(EWS_NEW_SWITCHES_).forEach(k => { if (on[k] === true && out.indexOf(EWS_NEW_SWITCHES_[k]) < 0) out.push(EWS_NEW_SWITCHES_[k]); });
  EWS_NEW_LANE_DEFS_.forEach(d => {
    if (d && d.sw && on[d.sw] === true) { const src = ewsSrcOfDef_(d); if (out.indexOf(src) < 0) out.push(src); }
  });
  return out;
}

/**
 * The AMIE table's Control row (48, `edAmie`) is OFF this run (Main.gs, beside the Watch's own OFF call): its read is
 * forgotten (ewsNewSourceOff_), so ON again starts afresh. Never throws.
 */
function ewsAmieOff_(sw) { ewsNewSourceOff_('ami', sw); }

/**
 * A new source whose Control row is OFF this run (`src`: 'ami' | 'bwl'; `sw`: the run's switches): its marks in
 * EWS_STATE (EWS_SRC_MARKS_) and a job of its own left running are forgotten; once no new source is ON at all, also the
 * new lanes' shared items: the posts carried to the next check ('carry'), the post-key index ('nk:N') and their own
 * same-author signatures ('sn:N'). Never the day counts or the trial date (EWS_SRC_DAY, st.day), and never the
 * leave-out lists ('xb', 'ak': they expire on their own, and a check with every row OFF still uses them for the
 * new-lane posts left in stories). Reads EWS_STATE only; writes it (and touches the cache) only when something of the
 * new sources is there, so with the rows always OFF nothing is written. Never throws.
 */
function ewsNewSourceOff_(src, sw) {
  try {
    const props = PropertiesService.getScriptProperties();
    if (!props.getProperty(EWS_STATE_PROP_)) return;
    const st = ewsState_(props);
    let changed = false;
    (EWS_SRC_MARKS_[src] || []).forEach(k => {
      if (Object.prototype.hasOwnProperty.call(st.marks, k)) { delete st.marks[k]; changed = true; }
    });
    EWS_NEW_LANE_DEFS_.filter(d => d && d.key && ewsSrcOfDef_(d) === src).forEach(d => {
      const job = st.jobs[d.key];
      if (!job) return;
      if (job.id) ewsCancel_(job);
      delete st.jobs[d.key];
      changed = true;
    });
    const items = [];
    if (!ewsNewSources_(sw).length && ('nk' in st || 'sn' in st)) {
      items.push('carry');
      for (let i = 0; i < (Number(st.nk) || 0); i++) items.push(`nk:${i}`);
      for (let i = 0; i < (Number(st.sn) || 0); i++) items.push(`sn:${i}`);
      delete st.nk;
      delete st.sn;
      changed = true;
    }
    if (!ewsNewSources_(sw).length && 'nsf' in st) { delete st.nsf; changed = true; }  // the New sources tab's wait
    if (items.length) {
      const cache = ewsCache_();
      try { if (cache) cache.removeAll(items.map(k => EWS_CACHE_PREFIX_ + k)); } catch (e) { /* they expire */ }
    }
    if (changed) ewsSaveState_(props, st);
  } catch (e) {
    console.warn(`Early wave: couldn't forget the ${src} source's read: ${(e && e.message) || e}`);
  }
}

/** The source of a new lane's def: its `src`, else the source of its switch (EWS_NEW_SWITCHES_), else 'new'. Pure. */
function ewsSrcOfDef_(d) {
  return (d && (d.src || EWS_NEW_SWITCHES_[d.sw])) || 'new';
}

/** The source of a new lane ('ami' for ami / amis, 'bwl' for bwl / bwls, else the lane itself). Pure. */
function ewsSrcOfLane_(lane) {
  const l = String(lane || '');
  return l === 'amis' ? 'ami' : l === 'bwls' ? 'bwl' : l;
}

/** The source of a new lane's member, from its id ('AMI|…' -> 'ami'). Pure. */
function ewsSrcOfId_(id) {
  const m = String(id || '').match(/^([A-Za-z]+)\|/);
  return m ? m[1].toLowerCase() : 'new';
}

/** Adds one to bucket list `key` of new source `src` for `ms` (15 min, 1 h, 3 h, 12 h, more). */
function ewsNewBucket_(nx, src, key, ms) {
  if (!nx || !src) return;
  const c = nx.n[src] = nx.n[src] || {};
  const list = Array.isArray(c[key]) ? c[key] : (c[key] = [0, 0, 0, 0, 0]);
  const min = Math.max(0, Number(ms) || 0) / 60000;
  list[min <= 15 ? 0 : min <= 60 ? 1 : min <= 180 ? 2 : min <= 720 ? 3 : 4]++;
}

/** Adds `n` (1 when not given) to the check's count `key` of new source `src` (`nx.n`, saved in EWS_SRC_DAY). */
function ewsNewCount_(nx, src, key, n) {
  if (!nx || !src) return;
  const c = nx.n[src] = nx.n[src] || {};
  c[key] = (Number(c[key]) || 0) + (n === undefined ? 1 : Number(n) || 0);
}

/**
 * The embedding order with new lanes' posts among `need` (sorted as ewsEmbed_ sorts them): today's lanes' texts first,
 * up to `room` less the new lanes' share (early_wave_new_embed_per_check), the new lanes' texts after them (carried
 * posts first) up to what is left; room one side leaves goes to the other. The new lanes embed only while the day's
 * total (`dayDone`) is under min(EWS_NEW_DAY_CAP_, EWS_EMBED_PER_DAY_ x (UTC hours elapsed + 1) / 24) and their own
 * (`newDone`) under early_wave_new_embed_per_day. {order: one post a text, in order; today, fresh: how many of `order`
 * are today's lanes' and the new lanes'; barred: the day bar held some back}. Pure.
 */
function ewsEmbedSplit_(need, room, dayDone, newDone, now, cfg) {
  const c = cfg || ewsNewCfg_();
  const uniq = list => {
    const seen = new Set();
    return list.filter(p => { if (seen.has(p.chash)) return false; seen.add(p.chash); return true; });
  };
  const today = uniq(need.filter(p => !p.nl));
  const newSide = need.filter(p => p.nl).map((p, i) => [p, i])
    .sort((a, b) => (b[0]._carry ? 1 : 0) - (a[0]._carry ? 1 : 0) || a[1] - b[1]).map(x => x[0]);
  const pace = Math.min(EWS_NEW_DAY_CAP_, Math.floor(EWS_EMBED_PER_DAY_ * (new Date(now).getUTCHours() + 1) / 24));
  const dayRoom = Math.max(0, Math.min(c.embedPerDay - newDone, pace - dayDone));
  const todayHashes = new Set(today.map(p => p.chash));
  const usable = uniq(newSide.filter(p => !todayHashes.has(p.chash))).length;
  const pick = bar => {  // the split with `bar` texts left to the new lanes for the day
    const todayN = Math.min(today.length, Math.max(0, room - Math.min(Math.min(usable, bar), c.embedPerCheck)));
    const chosen = today.slice(0, todayN);
    const chosenHashes = new Set(chosen.map(p => p.chash));
    const newU = uniq(newSide.filter(p => !chosenHashes.has(p.chash)));
    return { todayN, chosen, newU, newN: Math.max(0, Math.min(newU.length, bar, room - todayN)) };
  };
  const got = pick(dayRoom);
  // barred: the day bar, not the check's share, held some back (without it the new lanes would have had more)
  const barred = got.newN < pick(Infinity).newN;
  return { order: got.chosen.concat(got.newU.slice(0, got.newN)), today: got.todayN, fresh: got.newN, barred };
}

/** A new lane's post as carried to the next check (compact). Pure. */
function ewsCarryRecord_(p, now) {
  return [p.id, p.lane, truncate_(p.url, 500), p.platform, truncate_(p.author, 120), p.audience, p.eng, p.t, p.seen, p.text, p.topic,
    p.chash, (p.risk || []).join(','), p.brand ? 1 : 0, p.k || '', Number(p._carryAt) || now];
}

/** A carried record back as a post (marked _carry). Pure (reads GEN). */
function ewsPostOfCarry_(r) {
  if (!Array.isArray(r) || r.length < 16 || !r[0] || !r[2]) return null;
  const lane = String(r[1] || '');
  const url = String(r[2]);
  const platform = String(r[3] || 'Web');
  const author = String(r[4] || url);
  const p = { id: String(r[0]), lane, slow: EWS_SLOW_LANES_.indexOf(lane) >= 0, url, nurl: normalizeUrl_(url) || url.toLowerCase(),
    platform, author, ak: `${platform}:${author}`,
    audience: r[5] === null || r[5] === undefined ? null : Number(r[5]), eng: r[6] === null || r[6] === undefined ? null : Number(r[6]),
    t: Number(r[7]) || 0, seen: Number(r[8]) || 0, text: String(r[9] || ''), topic: String(r[10] || 'Unclassified'),
    chash: String(r[11] || ''), sig: '', risk: String(r[12] || '').split(',').filter(Boolean), brand: !!r[13], nl: true,
    _carry: true, _carryAt: Number(r[15]) || 0 };
  if (r[14]) p.k = String(r[14]);
  return p;
}

/**
 * The new lanes' posts carried from the last checks (cache 'carry'), younger than EWS_CARRY_MS_: {posts, expired:
 * {source: n}} (the expired ones were never embedded). Never throws.
 */
function ewsLoadCarry_(cache, now) {
  const out = { posts: [], expired: {} };
  const raw = ewsCacheGet_(cache, 'carry');
  (Array.isArray(raw) ? raw : []).forEach(r => {
    const p = ewsPostOfCarry_(r);
    if (!p) return;
    if (now - p._carryAt >= EWS_CARRY_MS_) { const s = ewsSrcOfLane_(p.lane); out.expired[s] = (out.expired[s] || 0) + 1; return; }
    out.posts.push(p);
  });
  return out;
}

/**
 * What is carried to the next check: the newest `max` (early_wave_new_carry_max) of the new lanes' posts left without
 * a vector, fewer when one cache item would not hold them (the oldest go first): {records, dropped: {source: n}}. Pure.
 */
function ewsCarryOut_(posts, now, max) {
  const list = (posts || []).slice().sort((a, b) => b.t - a.t || (a.id < b.id ? -1 : 1));
  let keep = list.slice(0, Math.max(0, max)).map(p => ewsCarryRecord_(p, now));
  while (keep.length && JSON.stringify(keep).length > EWS_CACHE_ITEM_CHARS_) keep = keep.slice(0, -1);
  const kept = new Set(keep.map(r => r[0]));
  const dropped = {};
  list.forEach(p => { if (!kept.has(p.id)) { const s = ewsSrcOfLane_(p.lane); dropped[s] = (dropped[s] || 0) + 1; } });
  return { records: keep, dropped };
}

/**
 * The new pool records with the new lanes' share applied: at most `poolMax` (early_wave_new_pool_max) new lanes' posts
 * in the pool, `inPool` of them already there; the newest new ones are kept, today's lanes' records all. Pure.
 */
function ewsNewPoolShare_(records, inPool, poolMax) {
  const nl = records.filter(r => r.nl);
  if (!nl.length) return records;
  const room = Math.max(0, poolMax - Math.max(0, inPool));
  const keep = new Set(nl.slice().sort((a, b) => (Number(b.t) || 0) - (Number(a.t) || 0) || (a.i < b.i ? -1 : 1)).slice(0, room).map(r => r.i));
  return records.filter(r => !r.nl || keep.has(r.i));
}

/**
 * EWS_SRC_DAY: {v, on: {source: 'YYYY-MM-DD' (UTC) its job was first collected while its row was ON; never cleared},
 * d: {day: {source: {count: n}, bar: 1}}, lh: [hour, n], ld: [day, n] (lifted stories sent for review), ls: [lifted
 * stories, newest last]}. Never throws.
 */
function ewsSrcDay_(props) {
  let r = null;
  try { r = JSON.parse(props.getProperty(EWS_SRC_DAY_PROP_) || 'null'); } catch (e) { r = null; }
  if (!r || typeof r !== 'object' || Array.isArray(r)) r = {};
  r.v = 1;
  r.on = r.on && typeof r.on === 'object' ? r.on : {};
  r.d = r.d && typeof r.d === 'object' ? r.d : {};
  r.ls = Array.isArray(r.ls) ? r.ls : [];
  r.lh = Array.isArray(r.lh) ? r.lh : [0, 0];
  r.ld = Array.isArray(r.ld) ? r.ld : ['', 0];
  return r;
}

/** Adds a check's counts (`n`: {source: {key: n or [buckets]}}) and day flags to the record. Pure (but for `rec`). */
function ewsSrcDayAdd_(rec, day, n, flags) {
  const d = rec.d[day] = rec.d[day] || {};
  Object.keys(n || {}).forEach(src => {
    const to = d[src] = d[src] || {};
    Object.keys(n[src]).forEach(k => {
      const v = n[src][k];
      if (Array.isArray(v)) {
        const cur = Array.isArray(to[k]) ? to[k] : [];
        to[k] = v.map((x, i) => (Number(cur[i]) || 0) + (Number(x) || 0));
      } else to[k] = (Number(to[k]) || 0) + (Number(v) || 0);
    });
  });
  Object.keys(flags || {}).forEach(k => { if (flags[k]) d[k] = 1; });
  return rec;
}

/**
 * Saves EWS_SRC_DAY under EWS_PROP_MAX_CHARS_: days older than EWS_SRC_DAYS_KEPT_ go; if still too long, the oldest
 * lifted stories, then the oldest days. Never throws.
 */
function ewsSaveSrcDay_(props, rec, now) {
  try {
    const oldest = ewsUtcDay_(now - (EWS_SRC_DAYS_KEPT_ - 1) * 24 * 3600 * 1000);
    Object.keys(rec.d).forEach(k => { if (k < oldest) delete rec.d[k]; });
    let json = JSON.stringify(rec);
    while (json.length > EWS_PROP_MAX_CHARS_ && rec.ls.length) { rec.ls.shift(); json = JSON.stringify(rec); }
    while (json.length > EWS_PROP_MAX_CHARS_ && Object.keys(rec.d).length > 1) {
      delete rec.d[Object.keys(rec.d).sort()[0]];
      json = JSON.stringify(rec);
    }
    if (json.length <= EWS_PROP_MAX_CHARS_) props.setProperty(EWS_SRC_DAY_PROP_, json);
  } catch (e) {
    console.warn(`Early wave: couldn't save the new sources' day record: ${(e && e.message) || e}`);
  }
}

/** A post key's 64-bit hash: FNV-1a of the key and of the key reversed, 16 hex characters ('' for no key). Pure. */
function ewsKeyHash_(k) {
  const s = String(k || '');
  if (!s) return '';
  const h = x => ('0000000' + parseInt(ewsFnv_(x), 36).toString(16)).slice(-8);
  return h(s) + h(s.split('').reverse().join(''));
}

/** A post's (or member's) key hash: `k` when it has one, else of amPostKey_ of its link (and kept on a post). Pure. */
function ewsPostKey_(p) {
  if (!p) return '';
  if (typeof p.k === 'string') return p.k;
  const k = ewsKeyHash_(typeof amPostKey_ === 'function' ? amPostKey_(p.url !== undefined ? p.url : p.u) : '');
  if (p.url !== undefined) p.k = k;
  return k;
}

/** Four hex characters of an author and four of a content hash: who wrote what, as the post-key index keeps it. Pure. */
function ewsWho_(author, chash) {
  return ('0000000' + parseInt(ewsFnv_(String(author || '').toLowerCase()), 36).toString(16)).slice(-4) +
    (String(chash || '') + '0000').slice(0, 4);
}

/**
 * The same post? Two copies with one key are one post unless both their authors and their content hashes differ
 * ("same link, different post": two comments sharing their thread's link). `a`, `b`: {who} (ewsWho_). Pure.
 */
function ewsSameWho_(a, b) {
  return a.slice(0, 4) === b.slice(0, 4) || a.slice(4) === b.slice(4);
}

/**
 * The leave-out lists a later step fills (cache 'xb': [[key hash, when]], the big posts Sonar knew, 24 hours; 'ak':
 * [[author, when]], the new lanes' excluded authors, 7 days): {big: Set, authors: Set}. Never throws.
 */
function ewsNewLeaveOut_(cache, now) {
  const read = (name, ms) => {
    const raw = ewsCacheGet_(cache, name);
    return new Set((Array.isArray(raw) ? raw : []).filter(r => Array.isArray(r) && r[0] && now - (Number(r[1]) || 0) < ms)
      .map(r => String(r[0]).toLowerCase()));
  };
  return { big: read('xb', EWS_XB_MS_), authors: read('ak', EWS_XA_MS_) };
}

/**
 * Stitching (one post, one alert), before the "already known" step, while a new source is ON (with every row OFF while
 * stories or the pool still hold new lanes' posts, ewsProduce_ calls it with {clusters, pool, now} alone: rule 3). In order:
 *   1. today's lanes' posts are never dropped (their velocity rows included);
 *   2. a new lane's post is dropped when its post key is in the new-lane post-key index ('nk'), or is the key of a
 *      post of today's lanes in this check, a story member or a pool post, or of a new lane's post kept before it in
 *      this check (bwl before ami); except "same link, different post" (ewsSameWho_);
 *   3. a post of today's lanes with the key of a story member that came from a new lane takes that member's place (id,
 *      account, platform, link, followers, engagements; no longer nl) and is not joined a second time (`replaced`; it
 *      keeps its velocity row); a new lane's pool post with that key leaves the pool (`poolGone`);
 *   4. only posts that passed the gates come here, so a copy with no words never blocks a later copy with words;
 *   5. a new lane's post whose key is a big post Sonar knew (`big`) is dropped, and so is one by an excluded author;
 *   6. a new lane's post the alert memory has seen (`seen(url)`) is dropped.
 * `ctx`: {index: {hour: [entry]} (updated: every kept post's entry is added, today's lanes' under 't<hour>'), clusters,
 * pool, big: Set, authors: Set, seen: url -> true, now, marks: {source: its last mark} (optional: a post in the index
 * seen before its source's mark is that source's own repeat, counted 'rep', not 'same')}. Returns {posts, replaced:
 * [{post, cluster, member, gap}], poolGone: [pool post], drops: {source: {same, rep, big, ex, al, sl}}}. Pure (but for
 * `ctx.index`, the members it replaces and `k` on the posts).
 */
function ewsStitch_(posts, ctx) {
  const c = ctx || {};
  const now = Number(c.now) || Date.now();
  const out = { posts: [], replaced: [], poolGone: [], drops: {} };
  const drop = (p, why) => {
    const s = ewsSrcOfLane_(p.lane);
    const d = out.drops[s] = out.drops[s] || {};
    d[why] = (d[why] || 0) + 1;
  };
  const add = (map, k, v) => { if (k) { if (!map.has(k)) map.set(k, []); map.get(k).push(v); } };
  const whoOf = p => ewsWho_(p.author, p.chash);
  const memberWho = m => ewsWho_(String(m.a || '').replace(/^[^:]*:/, ''), m.h);
  const today = (posts || []).filter(p => !p.nl);
  const fresh = (posts || []).filter(p => p.nl)
    .sort((a, b) => (/^bwl/.test(b.lane) ? 1 : 0) - (/^bwl/.test(a.lane) ? 1 : 0) || a.t - b.t || (a.id < b.id ? -1 : 1));
  const index = new Map();
  Object.keys(c.index || {}).forEach(h => (c.index[h] || []).forEach(e => add(index, String(e).slice(0, 16), String(e).slice(16))));
  const hour = String(Math.floor(now / 3600000));
  const entries = [];       // the new lanes' keys kept this check (index hour `hour`)
  const todayEntries = [];  // today's lanes' keys this check (index hour `t<hour>`: trimmed first, ewsNkRecords_)
  // today's lanes: their keys, and (rule 3) the new lanes' members and pool posts they replace
  const nlMembers = new Map();
  (c.clusters || []).forEach(cl => (cl.m || []).forEach(m => { if (m.nl) add(nlMembers, ewsPostKey_(m), { m, cl }); }));
  const nlPool = new Map();
  (c.pool || []).forEach(p => { if (p.nl) add(nlPool, ewsPostKey_(p), p); });
  const todayKeys = new Map();
  const replacedIds = new Set();
  const gone = new Set();
  today.forEach(p => {
    const k = ewsPostKey_(p);
    const who = whoOf(p);
    add(todayKeys, k, who);
    if (k) todayEntries.push(k + who);
    const hit = (nlMembers.get(k) || []).find(x => x.m.nl && ewsSameWho_(memberWho(x.m), who));
    if (hit) {
      const m = hit.m;
      const src = ewsSrcOfId_(m.i);
      const gap = Number(m.ss) > 0 && Number(p.seen) > 0 ? Number(p.seen) - Number(m.ss) : null;
      m.i = p.id; m.a = p.ak; m.p = p.platform; m.u = p.url; m.k = k;
      if (p.audience !== null && p.audience !== undefined) m.f = p.audience; else delete m.f;
      if (p.eng !== null && p.eng !== undefined) m.e = p.eng; else delete m.e;
      if (p.slow) m.sl = 1; else delete m.sl;
      delete m.nl;
      delete m.ss;
      out.replaced.push({ post: p, cluster: hit.cl, member: m, gap, src });
      replacedIds.add(p.id);
      return;
    }
    (nlPool.get(k) || []).forEach(q => { if (!gone.has(q) && ewsSameWho_(ewsWho_(String(q.ak || '').replace(/^[^:]*:/, ''), q.chash), who)) gone.add(q); });
  });
  out.poolGone = Array.from(gone);
  // the new lanes' posts, against everything known (rule 2), then the leave-out lists (rules 5 and 6)
  let members = null;
  let poolKeys = null;
  const keptNew = new Map();
  fresh.forEach(p => {
    const k = ewsPostKey_(p);
    if (!k) { out.posts.push(p); return; }
    const who = whoOf(p);
    const same = list => (list || []).some(w => ewsSameWho_(w, who));
    if (!members) {
      members = new Map();
      (c.clusters || []).forEach(cl => (cl.m || []).forEach(m => add(members, ewsPostKey_(m), memberWho(m))));
      poolKeys = new Map();
      (c.pool || []).forEach(q => { if (!gone.has(q)) add(poolKeys, ewsPostKey_(q), ewsWho_(String(q.ak || '').replace(/^[^:]*:/, ''), q.chash)); });
    }
    if (same(todayKeys.get(k))) { drop(p, 'same'); drop(p, 'sl'); return; }
    if (!p._carry && same(index.get(k))) {
      // a source's own repeat: seen before its last mark (the AMIE table's overlap reads its last hour again)
      const mark = Number((c.marks || {})[ewsSrcOfLane_(p.lane)]) || 0;
      drop(p, mark > 0 && Number(p.seen) > 0 && Number(p.seen) <= mark ? 'rep' : 'same');
      return;
    }
    if (same(members.get(k)) || same(poolKeys.get(k)) || same(keptNew.get(k))) { drop(p, 'same'); return; }
    if (c.big && c.big.has(k)) { drop(p, 'big'); return; }
    if (c.authors && c.authors.has(String(p.author || '').toLowerCase())) { drop(p, 'ex'); return; }
    let seen = false;
    try { seen = !!(typeof c.seen === 'function' && c.seen(p.url)); } catch (e) { seen = false; }
    if (seen) { drop(p, 'al'); return; }
    add(keptNew, k, who);
    if (!p._carry) entries.push(k + who);
    out.posts.push(p);
  });
  out.posts = today.filter(p => !replacedIds.has(p.id)).concat(out.posts);
  // the index: this check's keys, 72 hours at most (today's lanes' under 't<hour>')
  if (c.index) {
    const minHour = Math.floor((now - EWS_NK_MS_) / 3600000);
    Object.keys(c.index).forEach(h => { if (!(Number(String(h).replace(/^t/, '')) >= minHour)) delete c.index[h]; });
    if (entries.length) c.index[hour] = (c.index[hour] || []).concat(entries);
    if (todayEntries.length) c.index[`t${hour}`] = (c.index[`t${hour}`] || []).concat(todayEntries);
  }
  return out;
}

/** Whole days from UTC day `from` to UTC day `to` ('YYYY-MM-DD'). Pure. */
function ewsDaysBetween_(from, to) {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return isFinite(a) && isFinite(b) ? Math.round((b - a) / 86400000) : 0;
}

/**
 * The lifted stories of this check (ewsPromote_'s `lifted`: over the bar only with the new lanes' accounts): while a
 * source that lifts it is in its trial (early_wave_new_trial_days from the day it was first read; 0: no trial) the
 * story is not signalled but noted; after the trial at most early_wave_new_lifted_per_hour and _per_day are signalled
 * (UTC hour and day), the rest noted. A noted story is taken out of `promoted`. Each lifted story is listed in
 * `nx.rec.ls` (the newest EWS_LIFTED_KEPT_, for the New sources tab: ewsLiftedStories_) and counted once a story and
 * size (lf, and lfs sent or lfn noted). Stories over the bar with today's lanes alone are never held back. A source's
 * trial starts the first day its job was collected (`nx.live`), not the day its switch went ON. With every new switch
 * OFF this still runs (a minimal `nx`, ewsProduce_) while stories hold new lanes' members, so turning a row OFF never
 * lets a lifted story through; with nothing lifted and no record read, it reads and writes nothing.
 */
function ewsLiftGate_(promoted, nx, now, props) {
  if (!nx.rec && !promoted.some(x => x.lifted)) return;  // nothing lifted: the record is not read
  const rec = ewsLiftRec_(nx, now, props);
  nx.touched = true;
  const cfg = nx.cfg;
  promoted.slice().forEach(x => {
    if (!x.lifted) return;
    const srcs = ewsLiftSources_(x, now);
    const trial = ewsInTrial_(srcs, rec, nx.day, cfg);
    const send = !trial && Number(rec.lh[1]) < cfg.liftedPerHour && Number(rec.ld[1]) < cfg.liftedPerDay;
    const before = rec.ls.find(e => e[1] === x.id);
    const isNew = !before || Number(before[2]) < x.authors || (send && !before[5]);
    if (send) { rec.lh[1] = Number(rec.lh[1]) + 1; rec.ld[1] = Number(rec.ld[1]) + 1; }
    else promoted.splice(promoted.indexOf(x), 1);
    if (isNew) srcs.forEach(s => { ewsNewCount_(nx, s, 'lf'); ewsNewCount_(nx, s, send ? 'lfs' : 'lfn'); });
    const entry = [now, x.id, x.authors, x.urls, nsrcScrub_(x.c.lab, 100), send ? 1 : 0, srcs.join(','), trial ? 1 : 0];
    if (before) rec.ls.splice(rec.ls.indexOf(before), 1);
    rec.ls.push(entry);
  });
  rec.ls = rec.ls.slice(-EWS_LIFTED_KEPT_);
}

/**
 * The new sources' day record for the lift rules (`nx.rec`, read once a check): the sources read this check (`nx.live`)
 * get their first date, and the hour and day caps start again on a new UTC hour and day. Never throws.
 */
function ewsLiftRec_(nx, now, props) {
  const rec = nx.rec = nx.rec || ewsSrcDay_(props);
  (nx.live || []).forEach(s => { if (!rec.on[s]) rec.on[s] = nx.day; });
  const hour = Math.floor(now / 3600000);
  if (Number(rec.lh[0]) !== hour) rec.lh = [hour, 0];
  if (rec.ld[0] !== nx.day) rec.ld = [nx.day, 0];
  return rec;
}

/** The new sources of a story's new lanes' members in the last 180 minutes (`x.c`), sorted. Pure. */
function ewsLiftSources_(x, now) {
  const win = (x.c.m || []).filter(m => m.nl && (Number(m.t) || 0) >= now - EWS_EVAL_MS_ && (Number(m.t) || 0) <= now + 5 * 60000);
  return Array.from(new Set(win.map(m => ewsSrcOfId_(m.i)))).sort();
}

/**
 * True while one of `srcs` is in its trial on UTC day `day`: early_wave_new_trial_days (`cfg.trialDays`; 0: no trial)
 * from the day it was first read (`rec.on`); a source with no date yet is in its trial. Pure.
 */
function ewsInTrial_(srcs, rec, day, cfg) {
  return cfg.trialDays > 0 && srcs.some(s => !rec.on[s] || ewsDaysBetween_(rec.on[s], day) < cfg.trialDays);
}

/**
 * The early watch's picks (ewsWatchPick_) that only the new lanes' accounts lifted to the watch's bar: while a source
 * that lifts one is in its trial it is not asked about (taken out of `watching`); after the trial it is kept with
 * `lift` ({sources, links}) and ewsWatchAsk_ asks about it only while the two caps (early_wave_new_lifted_per_hour and
 * _per_day) have room, and counts it there once the answers raise it. With nothing lifted the record is not read.
 */
function ewsLiftWatch_(watching, nx, now, props) {
  if (!watching.some(x => x.lifted)) return;
  const rec = ewsLiftRec_(nx, now, props);
  watching.slice().forEach(x => {
    if (!x.lifted) return;
    const srcs = ewsLiftSources_(x, now);
    if (ewsInTrial_(srcs, rec, nx.day, nx.cfg)) watching.splice(watching.indexOf(x), 1);
    else x.lift = { sources: srcs, links: x.urls };
  });
}

/**
 * The stories only the new sources lifted over the bar, the newest last (EWS_SRC_DAY, at most EWS_LIFTED_KEPT_), for the
 * New sources tab: [{at (ms), story (cluster id), accounts, links, headline, sent (true: went for review; false: noted),
 * sources: ['ami' | 'bwl'], trial (true: noted because of the trial)}]. Never throws.
 */
function ewsLiftedStories_() {
  try {
    const rec = ewsSrcDay_(PropertiesService.getScriptProperties());
    return rec.ls.filter(Array.isArray).map(e => ({ at: Number(e[0]) || 0, story: String(e[1] || ''), accounts: Number(e[2]) || 0,
      links: Number(e[3]) || 0, headline: String(e[4] || ''), sent: !!e[5], sources: String(e[6] || '').split(',').filter(Boolean), trial: !!e[7] }));
  } catch (e) {
    return [];
  }
}

/**
 * The stories the new sources' posts reached this check: `st` (a story has a post of the source for the first time)
 * and `sb` (a new story whose first post is the source's), counted in `nx`. Pure (but for `nx`).
 */
function ewsNewStoryCounts_(nx, stories, startedBy, now) {
  (stories || []).forEach(c => {
    const had = new Set();
    const got = new Set();
    (c.m || []).forEach(m => {
      if (!m.nl) return;
      const s = ewsSrcOfId_(m.i);
      if (Number(m.j) === now) got.add(s); else had.add(s);
    });
    got.forEach(s => { if (!had.has(s)) ewsNewCount_(nx, s, 'st'); });
  });
  (startedBy || []).forEach(s => ewsNewCount_(nx, s, 'sb'));
}

/**
 * A check's end for the new sources: the date each source whose job was collected (`nx.live`) was first read (its
 * trial's start, kept for good: turning a row OFF never clears it), the check's counts and day flags, and `nx.rec`
 * (the record, when the check already read it), saved in EWS_SRC_DAY. Never throws.
 */
function ewsNewDayClose_(props, nx, now) {
  try {
    const rec = nx.rec || ewsSrcDay_(props);
    (nx.live || []).forEach(s => { if (!rec.on[s]) rec.on[s] = nx.day; });
    ewsSrcDayAdd_(rec, nx.day, nx.n, nx.flags);
    ewsSaveSrcDay_(props, rec, now);
  } catch (e) {
    console.warn(`Early wave: the new sources' day record: ${(e && e.message) || e}`);
  }
}

/**
 * Adds this check's leave-out rows to the new lanes' lists (`leave`: ewsNewLeaveOut_'s sets, updated) and keeps them
 * for the next checks: 'xbig' rows (links of the big posts Sonar knew, as post-key hashes, cache 'xb', 24 hours) and
 * 'xkof' rows (the AMIE table's staff and KOF authors, as a new lane names an account, cache 'ak', 7 days). Each item
 * keeps the newest entries one cache item holds, and is written only when this check brought something. Today's lanes
 * are never filtered by these lists. Never throws.
 */
function ewsNewLeaveAdd_(cache, now, leave, rows) {
  try {
    const big = [];
    const authors = [];
    (rows || []).forEach(r => {
      if (!r) return;
      if (r.kind === 'xbig' && r.url) {
        const k = ewsKeyHash_(typeof amPostKey_ === 'function' ? amPostKey_(String(r.url)) : '');
        if (k) big.push(k);
      } else if (r.kind === 'xkof' && String(r.author || '').trim()) {
        const url = String(r.url || '').trim();
        const a = ewsNewAuthor_(ewsNewPlatform_(url), r.author, url).toLowerCase();
        if (a) authors.push(a);
      }
    });
    const keep = (name, list, ms) => {
      if (!list.length) return;
      const at = new Map();
      const raw = ewsCacheGet_(cache, name);
      (Array.isArray(raw) ? raw : []).forEach(e => {
        if (!Array.isArray(e) || !e[0] || !(now - (Number(e[1]) || 0) < ms)) return;
        const k = String(e[0]).toLowerCase();
        at.set(k, Math.max(at.get(k) || 0, Number(e[1]) || 0));
      });
      list.forEach(k => at.set(k, now));
      let out = Array.from(at.entries()).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
      while (out.length > 1 && JSON.stringify(out).length > EWS_CACHE_ITEM_CHARS_) {
        out = out.slice(0, Math.max(1, Math.floor(out.length * EWS_CACHE_ITEM_CHARS_ / JSON.stringify(out).length) - 1));
      }
      ewsCachePut_(cache, { [name]: out });
    };
    keep('xb', Array.from(new Set(big)), EWS_XB_MS_);
    keep('ak', Array.from(new Set(authors)), EWS_XA_MS_);
    if (leave) {
      big.forEach(k => leave.big && leave.big.add(k));
      authors.forEach(a => leave.authors && leave.authors.add(a));
    }
  } catch (e) {
    console.warn(`Early wave: the new sources' leave-out lists: ${ewsScrub_((e && e.message) || e)}`);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The AMIE table (Control row 48): its own job in the check, its checks, its mark
// ---------------------------------------------------------------------------------------------------------------

/**
 * A text from outside (BigQuery's error message) made safe to keep, log or show: anything shaped like an email address
 * (whole, URL-encoded or cut short) becomes [address]; one line; cut to `max` characters (default 240). Pure.
 */
function ewsScrub_(s, max) {
  const t = String(s === undefined || s === null ? '' : s)
    .replace(/[A-Za-z0-9._%+-]+(?:@|%40)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/gi, '[address]')
    .replace(/[^\s()[\]<>"',;]*(?:@|%40)[^\s()[\]<>"',;]*/gi, '[address]')
    .replace(/\s+/g, ' ').trim();
  return truncate_(t, max > 0 ? max : 240);
}

/** A setting's regular expression for the SQL (no quote, no line break, it compiles), else `dflt`. Pure. */
function ewsAmiRx_(v, dflt) {
  const s = String(v === undefined || v === null ? '' : v).trim();
  if (!s || s.length > 400 || /['\n\r]/.test(s) || /\\$/.test(s)) return dflt;
  try { new RegExp(s); } catch (e) { return dflt; }
  return s;
}

/**
 * The AMIE table's settings (config/default_config.yaml burson_qa, GEN.settings): {take (amie_rows_per_check: new rows
 * a read at most), overlapMin (amie_overlap_minutes: read again before the mark), maxGb / maxBytes (amie_max_gb: what one
 * read may scan), staleHours / staleMs (amie_stale_hours: no new row for this long is said), staffRx
 * (amie_staff_feeds_rx: the alert feeds of Google's staff and KOFs)}. A setting missing or not usable is its default.
 * Pure (reads GEN).
 */
function ewsAmiCfg_() {
  const s = (typeof GEN !== 'undefined' && GEN && GEN.settings) || {};
  const num = (name, d, min) => {
    const v = s[name];
    const n = Number(v);
    return v === null || v === undefined || v === '' || typeof v === 'boolean' || !isFinite(n) || n < min ? d : n;
  };
  const maxGb = num('amie_max_gb', 1, 0.001);
  const staleHours = num('amie_stale_hours', 3, 0.1);
  return {
    take: Math.min(5000, Math.floor(num('amie_rows_per_check', 300, 1))),
    overlapMin: Math.min(360, Math.floor(num('amie_overlap_minutes', 60, 0))),
    maxGb, maxBytes: Math.round(maxGb * 1e9),
    staleHours, staleMs: Math.round(staleHours * 3600 * 1000),
    staffRx: ewsAmiRx_(s.amie_staff_feeds_rx, EWS_AMI_STAFF_RX_),
  };
}

/** The social networks' domains (GEN.platform_domains) as one RE2 pattern on a lowercased link. Pure (reads GEN). */
function ewsAmiSocialRx_() {
  const doms = [];
  const pd = (typeof GEN !== 'undefined' && GEN && GEN.platform_domains) || {};
  Object.keys(pd).forEach(k => (Array.isArray(pd[k]) ? pd[k] : []).forEach(d => {
    const v = String(d || '').trim().toLowerCase();
    if (/^[a-z0-9.-]+$/.test(v) && doms.indexOf(v) < 0) doms.push(v);
  }));
  return `^https?://([^/?#]*\\.)?(${doms.map(d => d.replace(/\./g, '\\.')).join('|')})([/?#:]|$)`;
}

/**
 * The AMIE job's SQL (a US job of its own, read-only): `opt`, the optional columns the table has (the others read as
 * NULL); `staffRx`, amie_staff_feeds_rx. Rows taken: the overlap before the mark (@ami_from_ms to @ami_mark_ms) again
 * (its newest @ami_over rows at most), then the oldest @ami_take rows after the mark. One post a link and author across the alert feeds; left out: the
 * positive and the non-Google feeds, the staff and KOF feeds and authors with a KOF (returned as 'xkof' rows), MODERATE
 * and HIGH tiers, positive posts, no posting time, links off the social networks (forums aside), the networks in
 * @skip_nets, posts that don't name Google (but in the old Google feeds), and posts with no English words; a post first
 * seen more than @late_min minutes after it was posted is slow ('amis'). Then the shared gates (ewsGateCtes_), once,
 * and the post select, with an 'amark' row: new rows taken (audience), of them with no posting time (eng), rows taken in
 * all (posted_ms), the newest ingestion time taken (seen_ms). Pure (reads GEN).
 */
function ewsAmiSql_(opt, staffRx) {
  const have = new Set((Array.isArray(opt) ? opt : []).map(String));
  const col = (name, as) => `${have.has(name) ? name : 'CAST(NULL AS STRING)'} AS ${as}`;
  const nul = t => `CAST(NULL AS ${t})`;
  const staff = ewsAmiRx_(staffRx, EWS_AMI_STAFF_RX_);
  return [
    `-- ews:ami (early wave: the AMIE table, Brandwatch's alert feeds; read-only)`,
    `WITH ami_raw AS (`,
    `  SELECT url, alert_source, snippet, authorHandle, SocialNetwork, Sentiment, postTime, ingestionTimestamp,`,
    `    ${col('followers', 'followers')}, ${col('KOF', 'KOF')}, ${col('product', 'product')}, ${col('engagement', 'tier')}`,
    `  FROM \`${EWS_AMI_TABLE_}\``,
    `  WHERE ingestionTimestamp > TIMESTAMP_MILLIS(@ami_from_ms)`,
    `    AND ingestionTimestamp <= TIMESTAMP_MILLIS(@until_ms) AND url IS NOT NULL`,
    `),`,
    `ami_taken AS (`,
    `  SELECT * FROM (SELECT * FROM ami_raw WHERE ingestionTimestamp <= TIMESTAMP_MILLIS(@ami_mark_ms)`,
    `    ORDER BY ingestionTimestamp DESC, url LIMIT @ami_over)`,
    `  UNION ALL`,
    `  SELECT * FROM (SELECT * FROM ami_raw WHERE ingestionTimestamp > TIMESTAMP_MILLIS(@ami_mark_ms)`,
    `    ORDER BY ingestionTimestamp, url LIMIT @ami_take)`,
    `),`,
    `ami_posts AS (`,
    `  SELECT url, LOWER(TRIM(REGEXP_REPLACE(IFNULL(authorHandle, ''), r'^@+|^/?u/', ''))) AS h,`,
    `    MIN(postTime) AS posted, MIN(ingestionTimestamp) AS seen,`,
    `    ARRAY_AGG(snippet IGNORE NULLS ORDER BY CHAR_LENGTH(snippet) DESC LIMIT 1)[SAFE_OFFSET(0)] AS raw,`,
    `    ANY_VALUE(SocialNetwork) AS net, MAX(SAFE_CAST(followers AS INT64)) AS audience,`,
    `    COALESCE(ANY_VALUE(NULLIF(TRIM(product), '')), ANY_VALUE(alert_source), 'Unclassified') AS topic,`,
    `    LOGICAL_OR(REGEXP_CONTAINS(LOWER(TRIM(IFNULL(alert_source, ''))), r'${EWS_AMI_GOOGLE_FEEDS_RX_}')) AS gfeed,`,
    `    LOGICAL_OR(REGEXP_CONTAINS(LOWER(IFNULL(alert_source, '')), r'${staff}')`,
    `      OR REGEXP_CONTAINS(IFNULL(KOF, ''), r'${EWS_AMI_KOF_RX_}')) AS kof,`,
    `    LOGICAL_OR(UPPER(IFNULL(tier, '')) IN ('MODERATE', 'HIGH')) AS big,`,
    `    LOGICAL_AND(LOWER(IFNULL(Sentiment, '')) != 'positive') AS notpos`,
    `  FROM ami_taken`,
    `  WHERE NOT REGEXP_CONTAINS(LOWER(IFNULL(alert_source, '')), r'positive')`,
    `    AND NOT REGEXP_CONTAINS(LOWER(TRIM(IFNULL(alert_source, ''))), r'${BQ_NON_GOOGLE_SOURCES_RX_}')`,
    `  GROUP BY url, h`,
    `),`,
    `lanes AS (`,
    `  SELECT IF(TIMESTAMP_DIFF(seen, posted, MINUTE) > @late_min, 'amis', 'ami') AS lane,`,
    `    CONCAT('AMI|', SUBSTR(TO_HEX(SHA256(CONCAT(url, '|', h))), 1, 24)) AS mid, url, net AS platform, h AS author,`,
    `    audience, CAST(NULL AS INT64) AS eng, posted, seen, raw, topic`,
    `  FROM ami_posts`,
    `  WHERE NOT kof AND NOT big AND notpos AND posted IS NOT NULL`,
    `    AND (REGEXP_CONTAINS(LOWER(url), r'${ewsAmiSocialRx_()}') OR REGEXP_CONTAINS(LOWER(IFNULL(net, '')), r'^forums?$'))`,
    `    AND NOT (LOWER(IFNULL(net, '')) IN UNNEST(@skip_nets))`,
    `    AND (gfeed OR REGEXP_CONTAINS(LOWER(IFNULL(raw, '')), r'${EWS_ENTITY_RX_}'))`,
    `    AND ${ewsEnglishWordsSql_('raw')}`,
    `),`,
    ewsGateCtes_('lanes', ['amis']),
    ewsPostSelectSql_(['amis']),
    `UNION ALL`,
    `SELECT 'amark', 'ami', ${nul('STRING')}, ${nul('STRING')}, ${nul('STRING')}, ${nul('STRING')},`,
    `  COUNTIF(ingestionTimestamp > TIMESTAMP_MILLIS(@ami_mark_ms)),`,
    `  COUNTIF(ingestionTimestamp > TIMESTAMP_MILLIS(@ami_mark_ms) AND postTime IS NULL), COUNT(*), UNIX_MILLIS(MAX(ingestionTimestamp)),`,
    `  ${nul('STRING')}, ${nul('STRING')}, ${nul('STRING')}, ${nul('STRING')}, ${nul('STRING')}, ${nul('BOOL')}`,
    `FROM ami_taken`,
    `UNION ALL`,
    `SELECT DISTINCT 'xkof', 'ami', ${nul('STRING')}, url, net, h, ${nul('INT64')}, ${nul('INT64')}, ${nul('INT64')}, ${nul('INT64')},`,
    `  ${nul('STRING')}, ${nul('STRING')}, ${nul('STRING')}, ${nul('STRING')}, ${nul('STRING')}, ${nul('BOOL')}`,
    `FROM ami_posts`,
    `WHERE kof AND h != ''`,
  ].join('\n');
}

/**
 * The AMIE job for a check (EWS_NEW_LANE_DEFS_'s query): {sql, params, win: {since, until}, flags: {mark}, maxBytes}.
 * It reads from amie_overlap_minutes before its mark (st.marks.ami, the newest ingestion time taken; never more than
 * EWS_AMI_MAX_BACK_MS_ back) and, with no mark yet, the last hour (EWS_AMI_FIRST_MS_). Pure (reads GEN).
 */
function ewsAmiQuery_(st, until, skipNets) {
  const cfg = ewsAmiCfg_();
  const marks = (st && st.marks) || {};
  const q = marks.amiq && typeof marks.amiq === 'object' ? marks.amiq : {};
  const mark = Number(marks.ami) || 0;
  const from = mark > 0 ? Math.max(mark - cfg.overlapMin * 60000, until - EWS_AMI_MAX_BACK_MS_) : until - EWS_AMI_FIRST_MS_;
  const markMs = mark > 0 ? Math.max(mark, from) : from;
  const p = (name, type, value) => ({ name, type, value });
  return {
    sql: ewsAmiSql_(Array.isArray(q.opt) ? q.opt : [], cfg.staffRx),
    params: [
      p('ami_from_ms', 'INT64', from), p('until_ms', 'INT64', until), p('ami_mark_ms', 'INT64', markMs),
      p('ami_take', 'INT64', cfg.take), p('late_min', 'INT64', ewsNewCfg_().lateMinutes),
      // the networks Brandwatch live delivers while it is ON and healthy (ewsBwlSkipNets_): AMIE leaves them to it
      { name: 'skip_nets', array: 'STRING', value: Array.isArray(skipNets) ? skipNets : [] },
      p('max_audience', 'INT64', EWS_MAX_AUDIENCE_), p('eng_ceiling', 'INT64', EWS_ENG_CEILING_),
      p('min_chars', 'INT64', EWS_MIN_CHARS_), p('min_tokens', 'INT64', EWS_MIN_TOKENS_),
      p('min_distinct', 'INT64', EWS_MIN_DISTINCT_TOKENS_), p('ami_over', 'INT64', EWS_AMI_OVERLAP_ROWS_),
      // the post select's caps: as many posts as rows taken, so it never cuts (a post is at least one row)
      p('rt_max', 'INT64', cfg.take + EWS_AMI_OVERLAP_ROWS_), p('slow_max', 'INT64', cfg.take + EWS_AMI_OVERLAP_ROWS_),
    ],
    win: { since: from, until },
    flags: { mark },
    maxBytes: String(cfg.maxBytes),
  };
}

/** The AMIE table's checks in EWS_STATE (st.marks.amiq), made when missing. */
function ewsAmiQ_(st) {
  const m = st.marks && typeof st.marks === 'object' ? st.marks : (st.marks = {});
  if (!m.amiq || typeof m.amiq !== 'object' || Array.isArray(m.amiq)) m.amiq = {};
  return m.amiq;
}

/**
 * Records a problem of the AMIE table (`kind`, a plain reason `why`): since when (kept while the same kind goes on), and
 * either a stop for the UTC day (`stop`) or a pause of EWS_AMI_PAUSE_MS_ after which a dry run must pass first. Today's
 * lanes go on either way. Logged once when it starts.
 */
function ewsAmiProblem_(q, kind, why, now, stop) {
  const same = q.prob && q.prob.k === kind;
  q.prob = { k: kind, w: ewsScrub_(why, 200), at: same ? Number(q.prob.at) || now : now };
  if (stop) { q.sd = ewsUtcDay_(now); delete q.pu; } else { q.pu = now + EWS_AMI_PAUSE_MS_; q.nd = 1; }
  if (!same) console.warn(`Early wave: the AMIE table: ${q.prob.w}`);
}

/** BigQuery's refusal in plain words for the AMIE table: ['access' | 'gone' | 'failed', why]. Pure. */
function ewsAmiRefusal_(code, text, what) {
  const t = ewsScrub_(text, 400);
  // BigQuery answers 403 for its quotas and rate limits too: those are a failure that passes, not refused access
  const quota = /quota|rate ?limit/i.test(t) && !/access denied|permission/i.test(t);
  if (!quota && (code === 403 || /access denied|permission/i.test(t))) return ['access', 'BigQuery won\'t let the bot read the AMIE table (access denied), so it isn\'t read'];
  if (code === 404 || /missing Table|not found: (?:Table|Dataset)/i.test(t)) return ['gone', 'BigQuery can\'t find the AMIE table, so it isn\'t read'];
  return ['failed', `${what} (${truncate_(t || (code ? `HTTP ${code}` : 'no answer'), 60)})`];
}

/**
 * The AMIE table's metadata (tables.get, no bytes): the needed columns and their types, the optional ones there, the
 * day partitioning on ingestionTimestamp, when it last changed. A needed column missing or of another type, access
 * refused, the table gone or no longer split by day stops it for the UTC day; no answer pauses it. True when it may
 * be read. Never throws.
 */
function ewsAmiMeta_(q, now) {
  const [project, dataset, table] = EWS_AMI_TABLE_.split('.');
  let code = 0;
  let text = '';
  let body = null;
  q.nc = (Number(q.nc) || 0) + 1;  // a call, for the day's count (ewsAmiCallsOut_)
  try {
    if (typeof apiGuardNote_ === 'function') apiGuardNote_('bigquery', 1);
    const resp = UrlFetchApp.fetch(`${BQ_API_BASE_}${project}/datasets/${dataset}/tables/${table}`, { method: 'get', muteHttpExceptions: true,
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() } });
    code = resp.getResponseCode();
    text = String(resp.getContentText() || '');
    try { body = JSON.parse(text); } catch (e) { body = null; }
    if (code !== 200 && body && body.error && body.error.message) text = body.error.message;
  } catch (e) {
    text = String((e && e.message) || e);
  }
  if (code !== 200) {
    const [kind, why] = ewsAmiRefusal_(code, text, 'BigQuery didn\'t answer the check of the AMIE table');
    ewsAmiProblem_(q, kind, why, now, kind !== 'failed');
    return false;
  }
  const fields = body && body.schema && Array.isArray(body.schema.fields) ? body.schema.fields : null;
  if (!fields) { ewsAmiProblem_(q, 'failed', 'BigQuery didn\'t say which columns the AMIE table has', now, false); return false; }
  const cols = {};
  fields.forEach(f => { if (f && f.name) cols[String(f.name).toLowerCase()] = { type: String(f.type || '').toUpperCase(), mode: String(f.mode || '').toUpperCase() }; });
  const words = { STRING: 'text', TIMESTAMP: 'a time' };
  for (const name of Object.keys(EWS_AMI_NEEDED_)) {
    const c = cols[name.toLowerCase()];
    if (!c) { ewsAmiProblem_(q, 'column', `the AMIE table has no column "${name}" any more, so it isn't read`, now, true); return false; }
    if (c.type !== EWS_AMI_NEEDED_[name] || c.mode === 'REPEATED') {
      ewsAmiProblem_(q, 'column', `the AMIE table's column "${name}" no longer holds ${words[EWS_AMI_NEEDED_[name]]}, so it isn't read`, now, true);
      return false;
    }
  }
  const part = body.timePartitioning || null;
  if (!part || String(part.field || '').toLowerCase() !== 'ingestiontimestamp' || ['DAY', 'HOUR'].indexOf(String(part.type || 'DAY').toUpperCase()) < 0) {
    ewsAmiProblem_(q, 'partition', 'the AMIE table is no longer split by day, so one read would scan all of it; it isn\'t read today', now, true);
    return false;
  }
  q.opt = Object.keys(EWS_AMI_OPTIONAL_).filter(name => {
    const c = cols[name.toLowerCase()];
    return !!c && c.mode !== 'REPEATED' && EWS_AMI_OPTIONAL_[name].indexOf(c.type) >= 0;
  });
  q.chg = Number(body.lastModifiedTime) || 0;
  q.mt = now;
  return true;
}

/**
 * The AMIE job sent as a dry run (jobs.query with dryRun: checks names and access, scans nothing, says the bytes):
 * access refused or the table gone stops it for the UTC day, and so does a read over amie_max_gb; any other refusal
 * pauses it. True when it passed (q.dd: the day, q.gb: the gigabytes). Never throws.
 */
function ewsAmiDryRun_(st, q, now) {
  const cfg = ewsAmiCfg_();
  let a;
  q.nc = (Number(q.nc) || 0) + 1;  // a call, for the day's count (ewsAmiCallsOut_)
  try {
    const job = ewsAmiQuery_(st, now - EWS_SETTLE_MS_);
    const req = ewsJobRequest_({ key: 'ami', location: 'US' }, job, ScriptApp.getOAuthToken());
    const body = JSON.parse(req.payload);
    body.dryRun = true;
    if (typeof apiGuardNote_ === 'function') apiGuardNote_('bigquery', 1);
    a = ewsAnswer_(UrlFetchApp.fetch(req.url, { method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: req.headers, payload: JSON.stringify(body) }));
  } catch (e) {
    a = { ok: false, why: String((e && e.message) || e) };
  }
  if (!a.ok) {
    const code = Number((String(a.why || '').match(/^HTTP (\d{3})/) || [])[1]) || 0;
    const [kind, why] = ewsAmiRefusal_(code, String(a.why || '').replace(/^HTTP \d{3}:\s*/, ''), 'BigQuery refused the AMIE read');
    ewsAmiProblem_(q, kind, why, now, kind !== 'failed');
    return false;
  }
  const bytes = Number(a.res && a.res.totalBytesProcessed);
  if (!(a.res && a.res.totalBytesProcessed !== undefined && a.res.totalBytesProcessed !== null) || !isFinite(bytes)) {
    ewsAmiProblem_(q, 'failed', 'BigQuery refused the AMIE read (its dry run didn\'t say how much it would scan)', now, false);
    return false;
  }
  if (bytes > cfg.maxBytes) {
    ewsAmiProblem_(q, 'cost', `one read of the AMIE table would scan ${(bytes / 1e9).toFixed(1)} GB (the limit is ${cfg.maxGb} GB)`, now, true);
    return false;
  }
  q.dd = ewsUtcDay_(now);
  q.gb = Math.round((bytes / 1e9) * 100) / 100;
  delete q.nd;
  return true;
}

/**
 * Whether the AMIE job goes out this check (EWS_NEW_LANE_DEFS_'s ready; only while row 48 is ON). It sends nothing: the
 * table's checks are made at the end of a check (ewsAmiChecks_), so the job goes out once the metadata was read since
 * the row went ON (or since a stop) and a dry run passed this UTC day with no failure since. Not while it is stopped for
 * the UTC day or paused, nor while a tab named "New sources" that a person made is there (st.nsf: NewSources.gs). A job
 * of its own still running is collected. Never throws.
 */
function ewsAmiReady_(st, now) {
  try {
    if (st.nsf) return false;
    const q = ewsAmiQ_(st);
    const day = ewsUtcDay_(now);
    if (q.sd) {
      if (q.sd === day) return false;
      delete q.sd;  // a new UTC day: the table is checked afresh (at the end of this check)
      q.mt = 0;
      q.nd = 1;
    }
    if (Number(q.pu) > now) return false;
    delete q.pu;
    if (st.jobs && st.jobs.ami && st.jobs.ami.id) return true;
    return Number(q.mt) > 0 && q.dd === day && !q.nd;
  } catch (e) {
    console.warn(`Early wave: the AMIE table's checks: ${ewsScrub_((e && e.message) || e)}`);
    return false;
  }
}

/**
 * The AMIE table's checks, at the end of a check while row 48 is ON (EWS_NEW_LANE_DEFS_'s checks): after today's lanes
 * were read and embedded, so a slow answer never costs them their posts, and each only with EWS_AMI_ROOM_MS_ of the
 * check's time (`deadline`) left (else at the next check). The metadata at the first check after the row goes ON (asking
 * first whether a person's tab is named "New sources": then nothing is read), then hourly, and on a new UTC day after a
 * stop; a dry run once a UTC day and after any failure. Not while stopped for the day or paused. When all it made
 * passed, the problem before is over. What they find stays in st.marks.amiq (ewsAmiStatus_). Never throws.
 */
function ewsAmiChecks_(st, now, deadline) {
  try {
    if (st.nsf) return;
    const q = ewsAmiQ_(st);
    const day = ewsUtcDay_(now);
    if (q.sd === day || Number(q.pu) > now) return;
    const room = () => Number(deadline) - Date.now() >= EWS_AMI_ROOM_MS_;
    if (!room()) return;
    if (!(Number(q.mt) > 0) && typeof nsrcForeign_ === 'function' && nsrcForeign_()) { st.nsf = now; return; }
    const mt = Number(q.mt) || 0;
    let made = false;
    if (!(mt > 0) || now - mt >= EWS_AMI_CHECK_MS_ || now < mt) {
      if (!ewsAmiMeta_(q, now)) return;
      made = true;
    }
    if (q.dd !== day || q.nd) {
      if (made && !room()) return;
      if (!ewsAmiDryRun_(st, q, now)) return;
      made = true;
    }
    if (made) delete q.prob;
  } catch (e) {
    console.warn(`Early wave: the AMIE table's checks: ${ewsScrub_((e && e.message) || e)}`);
  }
}

/**
 * The AMIE job was collected: its mark moves to the newest ingestion time taken (its 'amark' row; never back, and not
 * at all when nothing was taken), the problem it had is over, and the day record counts the rows ('rows': new rows
 * taken, 'npt': of them with no posting time, never a post) and the job ('calls'); q.lr keeps the read's new rows for
 * the New sources tab.
 */
function ewsAmiDone_(st, lane, now, nx) {
  const am = ((lane && lane.rows) || []).find(r => r && r.kind === 'amark');
  const newest = am ? Number(am.seen_ms) || 0 : 0;
  if (newest > (Number(st.marks.ami) || 0)) st.marks.ami = newest;
  const q = ewsAmiQ_(st);
  q.rd = now;
  delete q.prob;
  delete q.pu;
  delete q.sd;
  q.lr = am ? Number(am.audience) || 0 : 0;
  if (nx) ewsNewCount_(nx, 'ami', 'calls');
  if (nx && am) {
    ewsNewCount_(nx, 'ami', 'rows', Number(am.audience) || 0);
    ewsNewCount_(nx, 'ami', 'npt', Number(am.eng) || 0);
  }
}

/**
 * The AMIE job failed: refused access or the table gone stops it for the UTC day (as its checks would); any other failure
 * (refused, or its answer could not be read) is a pause of an hour, then a dry run before the next.
 */
function ewsAmiFailed_(st, lane, now, nx) {
  const q = ewsAmiQ_(st);
  if (nx) ewsNewCount_(nx, 'ami', 'calls');
  const code = Number((String((lane && lane.why) || '').match(/^HTTP (\d{3})/) || [])[1]) || 0;
  const [kind, why] = ewsAmiRefusal_(code, String((lane && lane.why) || '').replace(/^HTTP \d{3}:\s*/, ''), 'BigQuery refused the AMIE read');
  ewsAmiProblem_(q, kind, why, now, kind !== 'failed');
}

/**
 * The AMIE table's metadata reads and dry runs of this check (q.nc, counted where they are sent) go into the check's
 * day counts ('calls', with its jobs: the New sources tab's "calls today"). Never throws.
 */
function ewsAmiCallsOut_(st, nx) {
  const q = st && st.marks && st.marks.amiq;
  if (!nx || !q || typeof q !== 'object' || !(Number(q.nc) > 0)) return;
  ewsNewCount_(nx, 'ami', 'calls', Number(q.nc));
  delete q.nc;
}

/**
 * The AMIE table's state for its Control note and the New sources tab (step 1d words them): {state: 'starting' (not
 * read yet) | 'ok' | 'stopped' (for the UTC day) | 'paused' (until `until`) | 'failing' (a problem not cleared by a read
 * yet), kind: '' | 'column' | 'access' | 'gone' | 'partition' | 'cost' | 'failed' | 'stale', why (plain words, no
 * warning sign or time), since (ms the problem began, 0), until (ms the stop or pause ends, 0), read (ms of the last
 * read collected, 0), mark (the newest ingestion time taken, ms or null), changed (the table's last change, ms or null),
 * newest (the later of the two, ms or null), stale (no new row for amie_stale_hours), gb (the last dry run's GB or
 * null)}. A stop or pause comes before stale (one warning). `st`: EWS_STATE (read when not given). Never throws.
 */
function ewsAmiStatus_(now, st) {
  const t = Number(now) || Date.now();
  let s = st;
  if (!s) { try { s = ewsState_(PropertiesService.getScriptProperties()); } catch (e) { s = { marks: {} }; } }
  const marks = (s && s.marks) || {};
  const q = marks.amiq && typeof marks.amiq === 'object' ? marks.amiq : {};
  const mark = Number(marks.ami) || 0;
  const changed = Number(q.chg) || 0;
  const newest = Math.max(mark, changed);
  const out = { state: Number(q.rd) > 0 ? 'ok' : 'starting', kind: '', why: '', since: 0, until: 0, read: Number(q.rd) || 0,
    mark: mark || null, changed: changed || null, newest: newest || null,
    stale: newest > 0 && t - newest > ewsAmiCfg_().staleMs, gb: typeof q.gb === 'number' ? q.gb : null };
  const prob = q.prob && typeof q.prob === 'object' ? q.prob : null;
  if (prob) {
    out.kind = String(prob.k || 'failed');
    out.why = String(prob.w || '');
    out.since = Number(prob.at) || 0;
    if (q.sd === ewsUtcDay_(t)) { out.state = 'stopped'; out.until = Date.parse(`${q.sd}T00:00:00Z`) + 24 * 3600 * 1000; }
    else if (Number(q.pu) > t) { out.state = 'paused'; out.until = Number(q.pu); }
    else out.state = 'failing';
  } else if (out.stale) {
    out.kind = 'stale';
    out.why = 'the AMIE table has had no new rows';
    out.since = newest;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------------------------------------------

/**
 * Embeds the posts that need a vector (a text not seen before), EWS_EMBED_PER_CHECK_ a check and what's left of
 * EWS_EMBED_PER_DAY_ (risk terms first, then the texts most accounts share, then the newest; slow lanes last), and
 * drops evergreen noise. Returns the posts with `vec` (the others are left without one). With `nlCfg` (ewsNewCfg_, a
 * new source ON) and new lanes' posts among them, the room is split as ewsEmbedSplit_ says and the new lanes' own count
 * for the day is kept in st.day.nl; without either, exactly as before. Never throws.
 */
function ewsEmbed_(posts, known, st, now, deadline, nlCfg) {
  const day = ewsUtcDay_(now);
  if (st.day.key !== day) st.day = { key: day, embedded: 0 };
  const room = Math.max(0, Math.min(EWS_EMBED_PER_CHECK_, EWS_EMBED_PER_DAY_ - (Number(st.day.embedded) || 0)));
  const shared = {};
  posts.forEach(p => { shared[p.chash] = (shared[p.chash] || 0) + 1; });
  posts.forEach(p => { if (!p.vec && known.has(p.chash)) p.vec = known.get(p.chash); });
  const need = posts.filter(p => !p.vec && p.text)
    .sort((a, b) => (a.slow ? 1 : 0) - (b.slow ? 1 : 0) || (b.risk.length ? 1 : 0) - (a.risk.length ? 1 : 0) ||
      (shared[b.chash] || 0) - (shared[a.chash] || 0) || b.t - a.t);
  const texts = [];
  const byText = new Map();
  const split = nlCfg && need.some(p => p.nl)
    ? ewsEmbedSplit_(need, room, Number(st.day.embedded) || 0, Number(st.day.nl) || 0, now, nlCfg) : null;
  if (split) split.order.forEach(p => { byText.set(p.chash, texts.length); texts.push(p.text); });
  else need.forEach(p => { if (!byText.has(p.chash)) { if (texts.length >= room) return; byText.set(p.chash, texts.length); texts.push(p.text); } });
  let vecs = [];
  try { vecs = texts.length ? embedTexts_(texts, { deadline }) : []; } catch (e) { vecs = []; }
  const fresh = vecs.map(ewsUnit_);
  st.day.embedded = (Number(st.day.embedded) || 0) + fresh.filter(Boolean).length;
  if (split && split.fresh) st.day.nl = (Number(st.day.nl) || 0) + fresh.slice(split.today).filter(Boolean).length;
  need.forEach(p => { const i = byText.get(p.chash); if (i !== undefined && fresh[i]) p.vec = fresh[i]; });
  const withVec = posts.filter(p => p.vec);
  let ever = [];
  try { ever = withVec.length ? vecEvergreenOfVecs_(withVec.map(p => p.vec), { deadline }) : []; } catch (e) { ever = []; }
  const noise = new Set();
  withVec.forEach((p, i) => { if (typeof vecIsEvergreenNoise_ === 'function' && vecIsEvergreenNoise_(ever[i])) noise.add(p); });
  const out = { posts: posts.filter(p => !noise.has(p)), evergreen: noise.size, embedded: fresh.filter(Boolean).length,
    skipped: need.filter(p => !p.vec).length };
  if (split) { out.nlEmbedded = fresh.slice(split.today).filter(Boolean).length; out.barred = split.barred; }
  return out;
}

/**
 * One check: read both lanes, keep the posts that pass, embed and cluster them, count accounts for velocity, find the
 * signals, buffer them. {emitted, error}: error when no real-time lane answered (or both are still running) and nothing
 * came out. With `opts` (ewsRows_'s: the fast triage's), the new rows say their risk groups and taxonomy raise, and
 * `watch` lists the early-watch stories to ask about ([{cid, authors, row}]; ewsWatchAsk_ asks once this check is
 * saved). Never throws.
 */
function ewsProduce_(props, st, now, firstMins, opts) {
  const t0 = Date.now();
  const deadline = now + EWS_BUDGET_MS_;
  st.at = now;
  ewsSaveState_(props, st);  // stamped first: a second caller, or a run that dies, doesn't make a second check
  const cache = ewsCache_();
  const last = { at: ewsIso_(now) };
  try {
    const exCached = ewsCacheGet_(cache, 'x') || {};
    const ownDue = !(Number(exCached.ownAt) > 0) || now - Number(exCached.ownAt) >= EWS_OWN_EVERY_MS_;
    const sw = ewsRunSwitches_();  // the run's Control switches (all OFF unless the run set them)
    const lanes = ewsLanes_(sw, st);
    // the new sources' rules apply only while one of their switches is ON: with none ON, `nx` is null and the check is
    // exactly what it was before them (no new state is read or written)
    const nxSources = ewsNewSources_(sw);
    const nx = nxSources.length ? { cfg: ewsNewCfg_(), day: ewsUtcDay_(now), sources: nxSources, n: {}, flags: {} } : null;
    const read = ewsReadLanes_(st, now, deadline, ownDue, firstMins, lanes).lanes;
    const usDone = read.us.state === 'done';
    const c1Done = read.c1.state === 'done';
    const newLanes = lanes.filter(l => l.def);
    // the sources read this check (their job collected): a source's trial starts the first day it is read
    if (nx) nx.live = Array.from(new Set(newLanes.filter(l => read[l.key].state === 'done').map(l => ewsSrcOfDef_(l.def))));
    // a new source's job: its posts only under a new lane's name (its other rows are its own, for its `done`)
    const newRows = [].concat.apply([], newLanes.map(l => (read[l.key].state === 'done' ? read[l.key].rows || [] : [])
      .filter(r => r && (r.kind !== 'post' || EWS_NEW_LANES_.indexOf(String(r.lane || '')) >= 0))));
    const allRows = [].concat(read.us.rows || [], read.c1.rows || [], newRows);
    const ex = ewsExclusions_(exCached, read.us.rows, usDone, now);
    let posts = allRows.map(ewsPostOf_).filter(Boolean);
    last.read = posts.length;
    // the open engine (Control row 51): what each source gave, for the Engine tab (EngineTab.gs); OFF, as before
    if (typeof openOn_ === 'function' && openOn_()) {
      last.lanes = {};
      Object.keys(read).forEach(k => {
        if (read[k] && read[k].state === 'done') last.lanes[k] = (read[k].rows || []).map(ewsPostOf_).filter(Boolean).length;
      });
    }
    if (nx) posts.forEach(p => { if (p.nl) ewsNewCount_(nx, ewsSrcOfLane_(p.lane), 'in'); });
    posts = ewsExclude_(posts, ex);
    const sigs = ewsLoadSigs_(cache, Number(st.sg) || 0);
    // with a new source ON, its posts have their own signatures ('sn:N'): they check both sets, write only theirs
    const nsigs = nx ? ewsLoadSigs_(cache, Number(st.sn) || 0, 'sn') : null;
    posts = nx ? ewsDedupSigsSplit_(posts, sigs, nsigs, now) : ewsDedupSigs_(posts, sigs, now);
    last.kept = posts.length;

    // The stories, the pool and the accounts so far
    const clusters = ewsLoadClusters_(cache, Number(st.cl) || 0);
    const pool = ewsLoadPool_(cache, st.pool, now).map(r => Object.assign(ewsPostOfPool_(r), { _key: r._key })).filter(p => p.vec);
    // a new lane's post waits in the pool early_wave_new_pool_minutes at most (its chunk is written again without it)
    const poolGone = new Set();
    if (nx) {
      for (let i = pool.length - 1; i >= 0; i--) {
        if (pool[i].nl && now - (Number(pool[i].g) || 0) >= nx.cfg.poolMinutes * 60000) { poolGone.add(pool[i]._key); pool.splice(i, 1); }
      }
    }
    const known = new Set();
    clusters.forEach(c => (c.m || []).forEach(m => known.add(m.i)));
    pool.forEach(p => known.add(p.id));
    posts = posts.filter(p => !known.has(p.id));  // a window read again (a run that died) adds nothing twice
    let offReplaced = [];  // with every new row OFF: today's lanes' posts that took a new lane's member's place
    // the new lanes' posts not embedded at the last checks come back (embedded first among the new lanes')
    if (nx) {
      const carried = ewsLoadCarry_(cache, now);
      Object.keys(carried.expired).forEach(s => ewsNewCount_(nx, s, 'ne', carried.expired[s]));
      const ids = new Set(posts.map(p => p.id));
      posts = posts.concat(carried.posts.filter(p => !known.has(p.id) && !ids.has(p.id)));
      // stitching: one post through several sources is one post, and today's lanes' copy always wins
      const leave = ewsNewLeaveOut_(cache, now);
      // this check's own leave-out rows: the big posts Sonar knew ('xbig', us-central1) and the AMIE table's staff and
      // KOF authors ('xkof'), kept for the next checks too
      ewsNewLeaveAdd_(cache, now, leave, newRows.concat(c1Done ? (read.c1.rows || []).filter(r => r && r.kind === 'xbig') : []));
      nx.leave = leave;
      nx.index = ewsLoadSigs_(cache, Number(st.nk) || 0, 'nk');
      const amiMark = Number(st.marks.ami) || 0;  // the AMIE table's mark before this check's read
      const amiEdge = amiMark - 0.75 * ewsAmiCfg_().overlapMin * 60000;
      const sx = ewsStitch_(posts, { index: nx.index, clusters, pool, big: leave.big, authors: leave.authors, now, marks: { ami: amiMark },
        seen: url => { const m = typeof alertMemory_ === 'function' ? alertMemory_() : null; return !!(m && typeof m.seenPost === 'function' && m.seenPost(url)); } });
      posts = sx.posts;
      nx.replaced = sx.replaced;
      Object.keys(sx.drops).forEach(src => Object.keys(sx.drops[src]).forEach(k => ewsNewCount_(nx, src, k, sx.drops[src][k])));
      sx.replaced.forEach(x => {
        ewsNewCount_(nx, x.src, 'rp');
        if (x.gap !== null && x.gap > 0) { ewsNewCount_(nx, x.src, 'sf'); ewsNewBucket_(nx, x.src, 'sfb', x.gap); }
      });
      sx.poolGone.forEach(q => { poolGone.add(q._key); const i = pool.indexOf(q); if (i >= 0) pool.splice(i, 1); });
      posts.forEach(p => {
        if (!p.nl || p._carry) return;
        ewsNewCount_(nx, ewsSrcOfLane_(p.lane), 'used');
        if (p.seen > 0 && p.t > 0) ewsNewBucket_(nx, ewsSrcOfLane_(p.lane), 'dl', p.seen - p.t);
        // a late row the AMIE table's overlap caught (landed after the last read though taken in before its mark), and
        // one caught in the oldest quarter of the overlap (often: the overlap is too short)
        if (amiMark > 0 && ewsSrcOfLane_(p.lane) === 'ami' && p.seen > 0 && p.seen <= amiMark) {
          ewsNewCount_(nx, 'ami', 'lc');
          if (p.seen < amiEdge) ewsNewCount_(nx, 'ami', 'le');
        }
      });
    } else if (clusters.some(c => (c.m || []).some(m => m.nl)) || pool.some(p => p.nl)) {
      // every new row OFF, but stories or the pool still hold new lanes' posts: a later copy from today's lanes still
      // takes their place (rule 3 alone: no new lane's post comes in, no index or list is read or written)
      const sx = ewsStitch_(posts, { clusters, pool, now });
      posts = sx.posts;
      offReplaced = sx.replaced;
      sx.poolGone.forEach(q => { poolGone.add(q._key); const i = pool.indexOf(q); if (i >= 0) pool.splice(i, 1); });
    }
    const vecByHash = new Map();
    pool.forEach(p => { if (p.chash && !vecByHash.has(p.chash)) vecByHash.set(p.chash, p.vec); });
    const memberHash = new Map();
    clusters.forEach(c => (c.m || []).forEach(m => { if (m.h && !memberHash.has(m.h)) memberHash.set(m.h, { c, d: Number(m.d) || 0 }); }));
    const roll = ewsRollup_(props);
    const acc = ewsAcc_(ewsCacheGet_(cache, 'acc'));
    const priors = (ewsCacheGet_(cache, 'story') || []).filter(p => p && now - (Number(p.at) || 0) < EWS_STORY_MS_)
      .map(p => Object.assign({}, p, { vec: ewsDec_(p.v) }));

    // The same text as a story's member joins that story at once (no embedding); the rest are embedded
    const direct = [];
    const rest = [];
    posts.forEach(p => { const hit = memberHash.get(p.chash); if (hit) direct.push({ post: p, cluster: hit.c, sim: hit.d }); else rest.push(p); });
    const emb = ewsEmbed_(rest, vecByHash, st, now, deadline, nx && nx.cfg);
    last.embedded = emb.embedded;
    last.evergreen = emb.evergreen;
    last.unembedded = emb.skipped;
    const evergreenGone = new Set(rest.filter(p => emb.posts.indexOf(p) < 0).map(p => p.id));
    if (nx) {
      if (emb.barred) nx.flags.bar = 1;  // "new sources stopped embedding for today to keep room for Sonar"
      rest.forEach(p => { if (p.nl && p.vec) ewsNewCount_(nx, ewsSrcOfLane_(p.lane), 'emb'); });
      nx.carry = ewsCarryOut_(rest.filter(p => p.nl && !p.vec), now, nx.cfg.carryMax);
      Object.keys(nx.carry.dropped).forEach(s => ewsNewCount_(nx, s, 'ne', nx.carry.dropped[s]));
    }

    // Velocity counts: every real-time post of today's lanes kept (not evergreen noise), with its keys; a new lane's
    // posts add no velocity row (velocity from the new sources is not in this round)
    const realTime = posts.filter(p => !p.slow && !p.nl && !evergreenGone.has(p.id));
    const rowOf = new Map();
    realTime.forEach(p => {
      const row = [Math.floor(p.t / 60000), ewsFnv_(p.ak), p.platform, ewsKeysOf_(p), ewsFnv_(p.id)];
      acc.rows.push(row);
      rowOf.set(p.id, row);
    });
    // a post of today's lanes that took a new lane's member's place keeps its velocity row, in that member's story
    if (nx || offReplaced.length) {
      ((nx ? nx.replaced : offReplaced) || []).forEach(x => {
        if (x.post.slow) return;
        acc.rows.push([Math.floor(x.post.t / 60000), ewsFnv_(x.post.ak), x.post.platform, ewsKeysOf_(x.post).concat([`C|${x.cluster.id}`]), ewsFnv_(x.post.id)]);
      });
    }
    const winHours = [];
    EWS_LANES_.forEach(l => {  // today's two jobs only: a new source's window covers no hour
      const q = read[l.key];
      if (q.state !== 'done' || !q.q || !q.q.win) return;
      for (let h = Math.floor(q.q.win.since / 3600000); h <= Math.floor(q.q.win.until / 3600000); h++) winHours.push(h);
    });
    roll.cov = Array.from(new Set((roll.cov || []).concat(winHours)));
    if (winHours.length && !(Number(roll.since) > 0)) roll.since = now;

    // Stage A: the nearest story (start-of-check centroids), real time and slow lanes alike
    const embedded = emb.posts.filter(p => p.vec);
    const joins = direct.concat(ewsNearestStories_(embedded, clusters));
    const joined = new Set();
    joins.forEach(j => {
      ewsJoin_(j.cluster, j.post, j.sim, now);
      joined.add(j.post.id);
      const row = rowOf.get(j.post.id);
      if (row) row[3].push(`C|${j.cluster.id}`);
    });
    last.joined = joins.length;

    // Stage B: new stories around the new real-time posts, in the pool
    const fresh = embedded.filter(p => !p.slow && !joined.has(p.id));
    const universe = pool.concat(fresh);
    const found = fresh.length ? ewsDiscover_(universe, pool.length) : [];
    const leftPool = new Set();
    const startedBy = [];
    found.forEach(g => {
      const anchor = universe[g.anchor];
      const id = ewsClusterId_(anchor.id);
      if (nx && anchor.nl) startedBy.push(ewsSrcOfId_(anchor.id));
      let c = clusters.find(x => x.id === id);
      if (!c) { c = { id, s: '', n: 0, t0: now, ts: now, m: [], tp: {} }; clusters.push(c); }
      g.members.forEach(([idx, sim]) => {
        const p = universe[idx];
        ewsJoin_(c, p, sim, now);
        if (p.fromPool) leftPool.add(p.id);
        const row = rowOf.get(p.id);
        if (row) row[3].push(`C|${id}`);
        else if (p.fromPool) {
          const h = ewsFnv_(p.id);
          const r = acc.rows.find(x => x[4] === h);
          if (r) r[3].push(`C|${id}`);
        }
        joined.add(p.id);
      });
    });
    last.formed = found.length;

    // The pool: what's left of it, plus the new real-time posts no story took (the newest EWS_POOL_MAX_)
    const changedChunks = new Set();
    pool.forEach(p => { if (leftPool.has(p.id)) changedChunks.add(p._key); });
    poolGone.forEach(k => changedChunks.add(k));
    const unjoined = fresh.filter(p => !joined.has(p.id)).map(p => ewsPoolRecord_(p, now));
    // the new lanes' share: early_wave_new_pool_max of the pool at most (today's lanes keep the rest)
    const newPool = nx ? ewsNewPoolShare_(unjoined, pool.filter(p => p.nl && !leftPool.has(p.id)).length, nx.cfg.poolMax) : unjoined;

    // Signals
    const tidy = ewsTidyStories_(clusters, now);
    ewsCloseHours_(acc, roll, tidy, now);
    // with every new switch OFF, stories may still hold new lanes' members (they stay until they age out): their limits
    // hold all the same (the leave-out lists, the trial and the two caps), so turning a row OFF lifts nothing through
    const lx = nx || (tidy.some(c => (c.m || []).some(m => m.nl)) || offReplaced.length
      ? { cfg: ewsNewCfg_(), day: ewsUtcDay_(now), sources: [], live: [], n: {}, flags: {}, leave: ewsNewLeaveOut_(cache, now) } : null);
    if (!nx && lx && offReplaced.length) {  // the "replaced" and "seen first" counts go into the day record
      offReplaced.forEach(x => {
        ewsNewCount_(lx, x.src, 'rp');
        if (x.gap !== null && x.gap > 0) { ewsNewCount_(lx, x.src, 'sf'); ewsNewBucket_(lx, x.src, 'sfb', x.gap); }
      });
      lx.touched = true;
    }
    const promoted = ewsPromote_(tidy, priors, now, lx ? lx.leave : undefined);
    if (lx) ewsLiftGate_(promoted, lx, now, props);  // stories only the new sources lift: the trial, then the two caps
    if (nx) ewsNewStoryCounts_(nx, tidy, startedBy, now);
    const spikes = ewsVelocity_(acc, roll, tidy, priors, now);
    const facts = !!(opts && opts.facts);
    const watchMinAu = opts && opts.watch && opts.watch.bars ? opts.watch.bars.accounts : undefined;
    // The early watch (only when the caller's fast triage asks for it): stories still below the bar
    const watching = opts && opts.watch
      ? ewsWatchPick_(tidy.filter(c => !promoted.some(x => x.c === c)), priors, ewsWatchMarks_(cache, now), now, watchMinAu, lx ? lx.leave : undefined) : [];
    if (lx) ewsLiftWatch_(watching, lx, now, props);  // the trial holds for the early watch too

    // Representative posts for topic / risk spikes: the window's posts the pool or a story keeps
    const rich = [];
    tidy.forEach(c => (c.m || []).forEach(m => rich.push(m)));
    pool.filter(p => !leftPool.has(p.id)).forEach(p => rich.push(ewsMember_(p, 0, Number(p.g) || now)));
    newPool.forEach(r => rich.push(r));
    const richByHash = new Map();
    rich.forEach(m => { const h = ewsFnv_(m.i); if (!richByHash.has(h)) richByHash.set(h, m); });

    const hintVecs = [];
    const builds = [];
    promoted.forEach(x => { builds.push({ kind: 'c', x }); hintVecs.push(x.vec); });
    spikes.forEach(v => {
      const reps = v.cluster ? (ewsStoryWindow_(v.cluster, now) || {}).reps || []
        : ewsRepsOf_(Array.from(v.posts).map(h => richByHash.get(h)).filter(Boolean),
          (a, b) => (Number(b.e) || 0) - (Number(a.e) || 0) || (Number(b.t) || 0) - (Number(a.t) || 0));
      builds.push({ kind: 'v', v, reps });
      let vec = v.cluster ? ewsCentroid_(v.cluster) : null;
      if (!vec) {
        const sum = new Float64Array(VEC_DIMS_);
        let k = 0;
        reps.forEach(m => { const p = pool.find(x => x.id === m.i) || fresh.find(x => x.id === m.i); if (p && p.vec) { k++; for (let i = 0; i < sum.length; i++) sum[i] += p.vec[i]; } });
        vec = k ? ewsUnit_(sum) : null;
      }
      hintVecs.push(vec);
    });
    watching.forEach(x => hintVecs.push(x.vec));  // after the signals' own, so theirs keep their places
    let hints = [];
    try { hints = hintVecs.some(Boolean) ? vecTagHintsOfVecs_(hintVecs, { deadline }) : []; } catch (e) { hints = []; }
    const rows = [];
    const stories = (ewsCacheGet_(cache, 'story') || []).filter(p => p && now - (Number(p.at) || 0) < EWS_STORY_MS_);
    const tagByCid = new Map();
    builds.forEach((b, i) => {
      const tag = ewsTagHint_(hints[i]);
      if (b.kind === 'c') {
        const row = ewsClusterRow_(b.x, now, tag, facts);
        rows.push(row);
        if (tag.line) tagByCid.set(b.x.id, tag.line);
        b.x.c.al = { at: now, au: b.x.authors, id: row.alert_id };
        stories.push({ id: row.alert_id, cid: b.x.id, at: now, au: b.x.authors, pl: b.x.platforms, v: ewsEnc_(b.x.vec) });
      } else {
        const row = ewsVelocityRow_(b.v, b.reps, now, tag, facts);
        if (!row) return;
        rows.push(row);
        if (b.v.cluster && tag.line) tagByCid.set(b.v.key, tag.line);
        roll.cool[`${b.v.grain}|${b.v.key}`] = [now, b.v.current];
        if (b.v.cluster) stories.push({ id: row.alert_id, cid: b.v.key, at: now, au: b.v.current, pl: b.v.platforms, v: b.v.cluster.s || '' });
      }
    });
    Object.keys(roll.cool).forEach(k => { if (now - (Number(roll.cool[k][0]) || 0) > 14 * 24 * 3600 * 1000) delete roll.cool[k]; });
    last.signals = { cluster: rows.filter(r => r.signal_type === 'CLUSTER_EMERGENCE').length,
      velocity: rows.filter(r => r.signal_type === 'VELOCITY_SPIKE').length };
    // The early-watch stories to ask about: a risk-term group, an Exposure Tag close by, or nothing like it stored
    const watch = [];
    watching.forEach((x, i) => {
      const hint = hints[builds.length + i];
      const tag = ewsTagHint_(hint);
      if (tag.line && !tagByCid.has(x.id)) tagByCid.set(x.id, tag.line);
      const near = hint && (hint.exposure || [])[0];
      const tagged = !!(near && Number(near.sim) >= EWS_TAG_RAISE_SIM_);
      if (!x.risk.length && !tagged && !ewsWatchNovel_(x, tidy)) return;
      const cand = { cid: x.id, authors: x.authors, row: ewsWatchRow_(x, now, tag) };
      if (x.lift) cand.lift = x.lift;  // only the new lanes lifted it: asked only inside the two caps (ewsWatchAsk_)
      watch.push(cand);
    });
    if (opts && opts.record && typeof opts.record === 'object') {
      const velByCid = new Map();
      spikes.forEach(v => { if (v && v.grain === 'CLUSTER' && v.key) velByCid.set(v.key, v); });
      opts.record.at = now;
      opts.record.stories = tidy.map(c => {
        const w = ewsStoryWindow_(c, now) || {};
        const v = velByCid.get(c.id);
        return {
          c,
          w,
          stage: 'watching',
          priority: (w.risk && w.risk.length) || (w.platforms && w.platforms.length >= 2) ? 'P1' : 'P2',
          taxonomy_hint: tagByCid.get(c.id) || null,
          baseline: v ? Math.round(v.raw * 100) / 100 : null,
          ratio: v ? Math.round(v.ratio * 100) / 100 : null,
        };
      });
      const newStoryPosts = [];
      tidy.forEach(c => (c.m || []).forEach(m => {
        if (m && Number(m.j) === now) newStoryPosts.push({ cid: c.id, m, now });
      }));
      opts.record.posts = newStoryPosts;
      opts.record.signals = rows.slice();
    }

    // Keep it all: the buffer first (what earlyWaveCheck_ reads), then the stories, the pool and the counts
    const buffer = ewsReadBuffer_(cache, st).filter(r => now - (Number(r._at) || 0) < EWS_BUFFER_MS_ && rows.every(x => x.alert_id !== r.alert_id))
      .concat(rows.map(r => Object.assign({ _at: now }, r)));
    const items = { story: stories.slice(-60).map(p => ({ id: p.id, cid: p.cid, at: p.at, au: p.au, pl: p.pl, v: p.v })),
      acc: ewsAccStored_(acc), x: { urls: ex.urls, kof: ex.kof, own: ex.own, at: ex.at, ownAt: ex.ownAt } };
    ewsBufferPut_(items, st, buffer);  // 'buf' as before; under row 51 'bf:N' (step S5)
    // the same-author signatures: a day of them, packed into several items (one item no longer holds them)
    const sigChunks = ewsChunks_(ewsSigRecords_(sigs));
    sigChunks.forEach((ch, i) => { items[`sg:${i}`] = ch; });
    const storeChunks = ewsChunks_(tidy.map(ewsStoredStory_));
    storeChunks.forEach((ch, i) => { items[`cl:${i}`] = ch; });
    // the pool: chunks that lost posts are written again; the new posts are one new chunk (or a few)
    const index = (st.pool || []).filter(([stamp]) => now - Number(stamp) < EWS_POOL_MS_);
    const rewrite = {};
    pool.forEach(p => {
      if (!changedChunks.has(p._key) || leftPool.has(p.id)) return;
      (rewrite[p._key] = rewrite[p._key] || []).push(ewsPoolRecord_(p, Number(p.g) || now));
    });
    changedChunks.forEach(k => { items[k.slice(EWS_CACHE_PREFIX_.length)] = rewrite[k] || []; });
    const poolSize = pool.length - leftPool.size;
    const newRecords = newPool.slice(-Math.max(0, EWS_POOL_MAX_ - Math.max(0, poolSize - EWS_POOL_MAX_ + newPool.length) + newPool.length));
    const newChunks = ewsChunks_(newRecords.slice(-EWS_POOL_MAX_));
    if (newChunks.length) {
      newChunks.forEach((ch, j) => { items[`pv:${now}:${j}`] = ch; });
      index.push([now, newChunks.length]);
    }
    // the oldest chunks go once the pool is over its size
    let total = poolSize + newRecords.length;
    while (index.length > 1 && total > EWS_POOL_MAX_) {
      const [stamp, n] = index.shift();
      total -= pool.filter(p => String(p._key).indexOf(`pv:${stamp}:`) >= 0 && !leftPool.has(p.id)).length;
      for (let j = 0; j < n; j++) { try { if (cache) cache.remove(`${EWS_CACHE_PREFIX_}pv:${stamp}:${j}`); } catch (e) { /* expires */ } }
    }
    if (nx) {  // the new lanes' posts left without a vector, for the next check
      if (nx.carry.records.length) items.carry = nx.carry.records;
      else { try { if (cache) cache.remove(`${EWS_CACHE_PREFIX_}carry`); } catch (e) { /* expires */ } }
    }
    ewsCachePut_(cache, items);
    // clusters chunks no longer used
    for (let i = storeChunks.length; i < (Number(st.cl) || 0); i++) { try { if (cache) cache.remove(`${EWS_CACHE_PREFIX_}cl:${i}`); } catch (e) { /* expires */ } }
    st.cl = storeChunks.length;
    // signature items no longer used, and the single item from before they were packed
    for (let i = sigChunks.length; i < (Number(st.sg) || 0); i++) { try { if (cache) cache.remove(`${EWS_CACHE_PREFIX_}sg:${i}`); } catch (e) { /* expires */ } }
    if (!(Number(st.sg) > 0)) { try { if (cache) cache.remove(`${EWS_CACHE_PREFIX_}sig`); } catch (e) { /* expires */ } }
    st.sg = sigChunks.length;
    if (nx) {  // the new-lane post-key index: the new lanes' keys first, then today's, packed like the signatures
      const nkChunks = ewsChunks_(ewsNkRecords_(nx.index || {}, EWS_NK_MAX_));
      const nkItems = {};
      nkChunks.forEach((ch, i) => { nkItems[`nk:${i}`] = ch; });
      ewsCachePut_(cache, nkItems);
      for (let i = nkChunks.length; i < (Number(st.nk) || 0); i++) { try { if (cache) cache.remove(`${EWS_CACHE_PREFIX_}nk:${i}`); } catch (e) { /* expires */ } }
      st.nk = nkChunks.length;
    }
    if (nx) {  // the new lanes' own signatures, written after today's (each set packed alike)
      const snChunks = ewsChunks_(ewsSigRecords_(nsigs, EWS_SN_MAX_));
      const snItems = {};
      snChunks.forEach((ch, i) => { snItems[`sn:${i}`] = ch; });
      ewsCachePut_(cache, snItems);
      for (let i = snChunks.length; i < (Number(st.sn) || 0); i++) { try { if (cache) cache.remove(`${EWS_CACHE_PREFIX_}sn:${i}`); } catch (e) { /* expires */ } }
      st.sn = snChunks.length;
    }
    st.pool = index;

    // Cursors move on only for what was read
    if (usDone) {
      st.marks.spk = read.us.q.win.until;
      if (read.us.q.flags && read.us.q.flags.bw) st.marks.bw = read.us.q.flags.bw;
    }
    newLanes.forEach(l => {
      const state = read[l.key].state;
      const hook = state === 'done' ? l.def.done : state === 'failed' ? l.def.failed : null;
      if (typeof hook !== 'function') return;
      try { hook(st, read[l.key], now, nx); } catch (e) { console.warn(`Early wave: ${l.key}: ${ewsScrub_((e && e.message) || e)}`); }
    });
    // a new source's own checks (the AMIE table's metadata and dry run): now, after today's lanes were read and embedded
    EWS_NEW_LANE_DEFS_.forEach(d => {
      if (!d || typeof d.checks !== 'function' || !sw || sw[d.sw] !== true) return;
      try { d.checks(st, now, deadline); } catch (e) { console.warn(`Early wave: ${d.key}: ${ewsScrub_((e && e.message) || e)}`); }
    });
    if (c1Done) {
      st.marks.sonar = read.c1.q.win.until;
      if (read.c1.q.flags && read.c1.q.flags.tub) {
        const seen = (read.c1.rows || []).filter(r => r.lane === 'tub').map(r => Number(r.seen_ms) || 0);
        st.marks.tub = Math.max(Number(st.marks.tub) || 0, seen.length ? Math.max.apply(null, seen) : read.c1.q.win.until);
        st.marks.tubAt = now;
      }
    }
    if (nx) ewsAmiCallsOut_(st, nx);
    ewsSaveRollup_(props, roll);
    if (nx) ewsNewDayClose_(props, nx, now);
    else if (lx && lx.touched) ewsNewDayClose_(props, lx, now);  // a lifted story while every row is OFF: its record
    // the new sources' log line, the New sources tab and their Control notes (NewSources.gs), after the day record
    if (nx && typeof nsrcAfterCheck_ === 'function') nsrcAfterCheck_(props, st, nx, now, read);
    const problems = EWS_LANES_.filter(l => read[l.key].state === 'failed').map(l => `${l.key}: ${read[l.key].why}`);
    const pending = EWS_LANES_.filter(l => read[l.key].state === 'pending').map(l => l.key);
    // a new source's failure is named in the log line only: C19 (last.problem, the error) keeps today's lanes
    const newProblems = newLanes.filter(l => read[l.key].state === 'failed').map(l => `${l.key}: ${ewsScrub_(read[l.key].why)}`);
    last.stories = tidy.length;
    last.pool = Math.min(EWS_POOL_MAX_, total);
    last.problem = problems.join('; ');
    last.pending = pending.join(',');
    last.ms = Date.now() - t0;
    st.last = last;
    ewsSaveState_(props, st);
    if (problems.length || newProblems.length) console.warn(`Early wave: ${problems.concat(newProblems).join('; ')}`);
    const anyDone = usDone || c1Done;
    const error = anyDone ? ''
      : pending.length && !problems.length ? 'BigQuery: the early-wave query did not finish in time'
        : `BigQuery didn't answer the early-wave check (${problems.join('; ') || 'no answer'})`;
    return watch.length ? { emitted: rows.length, error, watch } : { emitted: rows.length, error };
  } catch (e) {
    console.error(`Early wave check failed: ${(e && e.stack) || e}`);
    last.problem = String((e && e.message) || e).slice(0, 240);
    last.ms = Date.now() - t0;
    st.last = last;
    ewsSaveState_(props, st);
    return { emitted: 0, error: `Early wave check failed: ${String((e && e.message) || e).replace(/Not found:\s*(Table|Dataset)/gi, 'missing $1').slice(0, 200)}` };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Brandwatch live's job (Control row 49): the parcel the reader left (BrandwatchLive.gs) through the shared gates
// ---------------------------------------------------------------------------------------------------------------

// The parcel's rows as the job's parameter @bwl (BrandwatchLive.gs bwlRow_); a number not known travels as -1
const EWS_BWL_STRUCT_ = [['mid', 'STRING'], ['url', 'STRING'], ['platform', 'STRING'], ['author', 'STRING'],
  ['audience', 'INT64'], ['eng', 'INT64'], ['posted_ms', 'INT64'], ['seen_ms', 'INT64'], ['raw', 'STRING'],
  ['topic', 'STRING'], ['lang', 'STRING'], ['sentiment', 'STRING']];
// AMIE's network names for the sources Brandwatch live asks for (what AMIE leaves to it while it is healthy)
const EWS_BWL_NETS_ = { reddit: 'reddit', bluesky: 'bluesky', facebook: 'facebook', facebook_public: 'facebook', instagram: 'instagram',
  instagram_public: 'instagram', tiktok: 'tiktok', youtube: 'youtube', threads: 'threads', tumblr: 'tumblr', forum: 'forums' };

/**
 * The Brandwatch job's SQL (the plan's Q1 and Q4): the parcel's rows (@bwl, never in the SQL text) as a new lane, bwl,
 * or bwls when it was added more than early_wave_new_late_minutes after it was posted; never X or LinkedIn; not
 * positive; English by its tag, and by its words when the tag is empty; it names Google, or its query is one of
 * Google's; then the shared gates once (small accounts, the length, the spam and homonym rules, the age) and the post
 * select, with nothing else feeding it. Pure.
 */
function ewsBwlSql_() {
  return [
    `-- ews:bwl (early wave: Brandwatch live, never X; read-only)`,
    `WITH bwl_in AS (`,
    `  SELECT c.mid, c.url, c.platform, c.author, NULLIF(c.audience, -1) AS audience, NULLIF(c.eng, -1) AS eng,`,
    `    TIMESTAMP_MILLIS(NULLIF(c.posted_ms, -1)) AS posted, TIMESTAMP_MILLIS(NULLIF(c.seen_ms, -1)) AS seen,`,
    `    c.raw, c.topic, c.lang, c.sentiment`,
    `  FROM UNNEST(@bwl) c`,
    `),`,
    `lanes AS (`,
    `  SELECT IF(TIMESTAMP_DIFF(seen, posted, MINUTE) > @late_min, 'bwls', 'bwl') AS lane, mid, url, platform,`,
    `    LOWER(TRIM(REGEXP_REPLACE(IFNULL(author, ''), r'^@+|^/?u/', ''))) AS author, audience, eng, posted, seen, raw, topic`,
    `  FROM bwl_in`,
    `  WHERE LOWER(IFNULL(platform, '')) NOT IN ('twitter', 'x') AND NOT STARTS_WITH(LOWER(IFNULL(platform, '')), 'linkedin')`,
    `    AND LOWER(IFNULL(sentiment, '')) != 'positive'`,
    `    AND ${englishLangSql_('lang')} AND (TRIM(IFNULL(lang, '')) != '' OR ${ewsEnglishWordsSql_('raw')})`,
    `    AND (REGEXP_CONTAINS(LOWER(IFNULL(raw, '')), r'${EWS_ENTITY_RX_}')`,
    `      OR REGEXP_CONTAINS(LOWER(IFNULL(topic, '')), r'${EWS_GOOGLE_CONFIG_RX_}'))`,
    `),`,
    ewsGateCtes_('lanes', ['bwls']),
    ewsPostSelectSql_(['bwls']),
  ].join('\n');
}

/**
 * The Brandwatch job for a parcel (`rows`: bwlRow_'s; `to`: the parcel's mark), at `until`. The post select's caps are
 * the parcel's size, so it never cuts. Pure.
 */
function ewsBwlQuery_(rows, until, to) {
  const list = (Array.isArray(rows) ? rows : []).map(r => Object.assign({}, r, {
    posted_ms: Number(r.posted_ms) > 0 ? Number(r.posted_ms) : -1, seen_ms: Number(r.seen_ms) > 0 ? Number(r.seen_ms) : -1,
    audience: Number(r.audience) >= 0 ? Number(r.audience) : -1, eng: Number(r.eng) >= 0 ? Number(r.eng) : -1,
  }));
  const p = (name, type, value) => ({ name, type, value });
  const cap = Math.max(1, list.length);
  return {
    sql: ewsBwlSql_(),
    params: [
      { name: 'bwl', struct: EWS_BWL_STRUCT_, rows: list },
      p('until_ms', 'INT64', until), p('late_min', 'INT64', ewsNewCfg_().lateMinutes),
      p('max_audience', 'INT64', EWS_MAX_AUDIENCE_), p('eng_ceiling', 'INT64', EWS_ENG_CEILING_),
      p('min_chars', 'INT64', EWS_MIN_CHARS_), p('min_tokens', 'INT64', EWS_MIN_TOKENS_),
      p('min_distinct', 'INT64', EWS_MIN_DISTINCT_TOKENS_), p('rt_max', 'INT64', cap), p('slow_max', 'INT64', cap),
    ],
    win: { since: until, until },
    flags: { to: Number(to) || 0, n: list.length },
  };
}

/** True while a parcel of Brandwatch live waits for its job (BWL_STATE). Never throws. */
function ewsBwlReady_() {
  try { return !!bwlState_(PropertiesService.getScriptProperties()).parcel; } catch (e) { return false; }
}

/** The job of the waiting parcel, or null when none waits (its cache items gone: it is read again from Brandwatch). */
function ewsBwlLaneQuery_(until) {
  const parcel = bwlParcelTake_();
  return parcel && parcel.rows.length ? ewsBwlQuery_(parcel.rows, until, parcel.to) : null;
}

/** The Brandwatch job was collected: the reader's mark moves (bwlParcelCollected_), and its line goes to the log. */
function ewsBwlDone_(st, lane, now, nx) {
  const props = PropertiesService.getScriptProperties();
  const before = bwlState_(props);
  if (!bwlParcelCollected_(props, now)) return;
  console.log(bwlCheckLog_(before.lr, before.parcel && before.parcel.to, before.login));
}

/** The Brandwatch job failed: tried again with the next check, dropped after its second failure (bwlParcelFailed_). */
function ewsBwlFailed_(st, lane, now, nx) {
  bwlParcelFailed_(PropertiesService.getScriptProperties(), (lane && lane.why) || 'the job failed', now);
}

/**
 * The networks the AMIE job leaves to Brandwatch live (the plan's Q6): the ones Brandwatch live asks for, in AMIE's
 * names, while row 49 is ON, Brandwatch live is not stopped and its last read (st.lr, a read that answered) is under an
 * hour old; else none, so AMIE reads every network again. Never throws.
 */
function ewsBwlSkipNets_() {
  try {
    if (!ewsRunSwitches_().edBwLive) return [];
    const now = Date.now();
    const st = bwlState_(PropertiesService.getScriptProperties());
    const at = Number(st.lr && st.lr.at);
    if (st.stop || !(at > 0) || now - at >= BWL_HOUR_MS_) return [];
    const asked = bwlSources_(bwLiveCfg_().sources, Array.isArray(st.srcs) ? st.srcs : null);
    return Array.from(new Set(asked.map(s => EWS_BWL_NETS_[s]).filter(Boolean)));
  } catch (e) {
    return [];
  }
}
