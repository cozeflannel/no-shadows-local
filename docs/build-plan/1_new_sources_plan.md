# Plan: more sources for the bot, stitched together (the AMIE table back, Brandwatch read live without X)

> **For whoever builds from this file in the repository.** It was written against an older commit: line numbers
> have moved, so find each place by its function or constant name. Paths that start with `scratchpad/` point at
> design notes that are not in the repository; this folder holds everything needed. Read `README.md` and
> `STEP_NOTES.md` in this folder first: where they differ from this file, they win.

Final plan, written 2026-11-16 from two designs (`design_staged.md`, `design_one-intake.md`), four reviews
(`attack_api-limits.md`, `attack_detection-quality.md`, `attack_stitching.md`, `attack_operations-rules.md`) and six
maps (`map_*.md`), all in this folder. Repository this repository, branch
`claude/social-listening-clustering-r1i694`, head `3be2e06`, read only (work tree clean before and after).

Short names: EWS = `apps-script-chat-bot/EarlyWaveSource.gs`, PW = `apps-script-chat-bot/ProactiveWatch.gs`,
BQ = `apps-script-chat-bot/BigQuery.gs`, AM = `apps-script-chat-bot/AlertMemory.gs`, T = `apps-script-chat-bot/test/`.
Every line number is for `3be2e06`; BQ and PW numbers move when the larger change merges. **NOT VERIFIED** marks what
nobody here could check (no Brandwatch, BigQuery, sheet or logs).

Code lines I re-opened myself for this plan (the rest is cited from the maps, whose authors checked them at `3be2e06`):
EWS 100-125, 140-160, 245-262, 380-425, 545-600, 638-735, 765-790, 1008-1020, 1176-1240, 1655-1800, 1936-1979;
BQ 3524-3545; Main.gs 330-350, 680-716; AM 175-212, 1000-1030; Speed.gs 386-412; Alert.gs 672-684;
EarlyDetection.gs 400-410; Control.gs 53, 297-298; T/switch_alert_memory.test.js 60-70;
T/switch_early_wave_source.test.js 105-111; function locations PW:929, 1178, 1185, 1201, 1269. In-flight branches
checked with read-only `git diff --name-only 3be2e06...<branch>`: only `Main.gs` is touched by them among the files
this plan edits (one line at Main.gs:328 on `build/ed-2`, `build/ed-tab-1`, `build/ed-1b-fix1`,
`build/watch-1b-r-fix1`; `status()` at Main.gs:192 on `build/watch-2`). None touches EWS, Control.gs, TempCheck.gs,
Speed.gs, AM, the config trio or Generated.gs.

---

## 0. The plan in one screen

| Stage | Switch (new row, OFF) | What it alone gives the owner |
|---|---|---|
| 0 | none | An engineer runs one read-only check that says whether Brandwatch honours the filters this plan needs, how late Brandwatch and the AMIE table really are, and whether the bot can read both. Nothing changes for the owner. |
| 1 | row 48 `Early Detection: also read the AMIE table` | Early Detection sees X posts with their words and Reddit, Facebook, Instagram and other posts from Brandwatch's alert feeds again (lost on 11 November), with no Brandwatch calls, and the New sources tab shows how many it used and how late they came. |
| 2 | row 49 `Early Detection: also read Brandwatch live (not X)` | Early Detection sees Brandwatch's non-X posts from the queries the owner ticks, minutes after Brandwatch adds them (stage 0 measures how many minutes) instead of a day or more later, and they can start stories. |
| 3 | row 50 `Proactive watch: also read the AMIE table` | The Watch gets back Brandwatch's brand-safety and product alert feeds, X with its words and KOF names, about a day sooner than the nightly table, at most 300 extra Gemini looks a day at first. |

The shape, in one sentence: **each new source is its own BigQuery job inside Early Detection's existing check, sent in
the same `UrlFetchApp.fetchAll` as today's two jobs (EWS:663), so it waits side by side with them, fails alone, and
leaves today's two jobs byte-for-byte as they are; Brandwatch is read outside the check, in the run's `finally` after
the Watch, into one small parcel that the next check hands to its Brandwatch job, and Brandwatch's mark moves only when
that job is collected.**

Rules that hold in every stage:

1. With rows 48-50 OFF, nothing new happens: no Secret Manager read, no Brandwatch call, no read of the AMIE table, no
   new tab, no new cache item or property, and the US and us-central1 requests are byte-for-byte today's (a test
   compares them with a snapshot taken at `3be2e06`).
2. A new source only adds. It never removes, rewrites or delays a post that today's lanes bring, never takes away a
   velocity count, and its failure never stops today's lanes.
3. Everything the owner reads is plain words; every column C note fits 200 characters with its warning first.
4. Nothing new ever reaches S-F Burson (B25) or the Burson test copy (B26).

Not in this round: Direct BigQuery cards, the review's AMIE lookups (Mode A), Brandwatch live for the Watch, news sites,
blogs and LinkedIn from Brandwatch, velocity from the new sources (section 12).

---

## 1. Where the designs and reviews disagreed, and what I decided

| Question | Staged | One-intake | Decision and the evidence |
|---|---|---|---|
| Where Brandwatch is read | inside the 40 s check, between the two job submissions | its own step every 5 min, into a script-cache buffer | **Outside the check, into one parcel at a time; the mark moves only when the check's job carrying it is collected.** Each job is sent with `jobs.query` and `timeoutMs: EWS_BQ_WAIT_MS_` = 20 s (EWS:113, 589-593), so a call blocks until the job ends; today both go in one `fetchAll` (EWS:663) and wait side by side. A Brandwatch read between them adds its time to the check, `UrlFetchApp` has no timeout (Decisions.gs:42), and with under 15 s left no embedding starts (Vectors.gs:30) while the cursors still move (EWS:1943-1954): every lane's posts of that check are lost (api-limits P1, detection P4, operations P2, stitching P14). A script-cache buffer whose mark already moved loses posts when an item is evicted ("about 1,000 items, shared", Vectors.gs:15-16) or when the intake reads faster than the check takes (api-limits P3, operations P3, detection P6). One parcel, consumed before the next read, cannot run ahead, and a lost parcel is simply read again because the mark did not move. |
| AMIE in the US job or its own job | one more part of the US job, `@ami_on` to turn it off | its own job in the intake | **Its own job, in the same `fetchAll`.** A boolean parameter does not remove a table name from SQL, so a dropped column or lost access fails the whole US job, which also carries Sprinklr's comments, the nightly lane and DSD's exclusions (EWS:429-482); after 2 hours the missed window is skipped (EWS:117, 553) (api-limits P5, operations P1). A separate job in the same `fetchAll` costs no extra wall time. |
| AMIE's window | the US window shifted 30 min back | its own mark from the data, 40 min overlap | **Its own mark from the data (newest `ingestionTimestamp` taken), read from 60 min before it, repeats dropped by id** (api-limits P6, detection P19, operations P10). |
| Brandwatch rows into SQL | `@bwa` parameter in the US job | `@ink` parameter in the US job | **A parameter, but in the Brandwatch job of its own** (operations P1: a bad row in a parameter must not fail Sprinklr's job). The shared gates still apply in one copy (`ewsGateCtes_`, EWS:374-408). |
| AMIE rows with no `postTime` | posting time = ingestion time | dropped | **Dropped**: the bar counts members by `m.t` (EWS:1180-1181), not by "slow", so a filled-in time makes a day-old post count as fresh (api-limits P15, detection P3, stitching P2). |
| Late posts | slow (join only) after 3 h | real time whatever the delay | **Staged's split**: a new-source post first seen more than 180 min after it was posted gets a slow lane name (`amis`, `bwls`): 72 h age, join only, no pool (stitching P6: as real time, AMIE's day-late posts would be dropped by the 24 h age gate at EWS:387). |
| Velocity | new lanes out | new lanes out, but repeats of any lane dropped | **New lanes out; today's lanes never lose a velocity row** (stitching P4, detection P1). |
| The pool | new lanes out | new lanes in, no limit | **In, with a share: at most 300 of the 1,200 for 2 hours** (detection P5 and P12). |
| Same post | new copy dropped against old only | first copy wins, any lane | **Both ways, and today's lanes always win**: a new-lane copy is dropped against a known post; a later copy from today's lanes takes the new-lane member's place (stitching P1, P13). |
| Post identity | `postKey_` | `amPostKey_` | **`amPostKey_`** (AM:177-209): it calls `postKey_` for platform ids and is the alert memory's key, so one key serves stitching and "already alerted". |
| X out of the request | positive `pageType` list | `xpageType=twitter` | **Positive list built daily from `GET /metrics`, never `twitter` or `linkedin*`; any X that still arrives stops the source** (operations P6, api-limits P4, P8). A positive list never asks for X even if the meaning of `xpageType` is not what the docs say; an ignored filter of either kind fails open, which the stop catches. |
| Which queries | a Brandwatch query group named "SLRR bot live" | a bot tab where the owner ticks queries | **A tab** (operations P11, api-limits Q1): the owner chooses on the sheet; no group whose `users` list holds email addresses is ever fetched; nothing named "bot" is created inside a shared Brandwatch project. One tab, `New sources`, holds both the source status and the query list. |
| Column check | daily dry run | metadata call | **Both** (api-limits P21): the free metadata call (`tables.get`) hourly for columns, types, partitioning and last change; the dry run daily for access and bytes. |
| Build order | AMIE, Brandwatch, Watch | Brandwatch, AMIE, Watch, Direct | **Probe, AMIE, Brandwatch, Watch** (api-limits Q15, detection Q15): AMIE needs no Brandwatch call and none of the ten unverified API behaviours; Brandwatch's speed is unmeasured (detection P13) and stage 0 measures it before stage 2 is built. |
| Help row | moved one row a stage | moved one row a stage | **Moved once, in stage 1, to row 52** (operations P17), so stages 2 and 3 add rows 49 and 50 with no help move and no churn in the ten test files that pin it. |

One review claim I refute: detection P9 (comments under one Reddit thread pass the 2-links test). The bar counts links
with `normalizeUrl_` (EWS:1189), which folds every Reddit comment to its thread (`reddit.com/comments/<thread>`,
Alert.gs:676-679), so five comments in one thread are one link and fail `EWS_MIN_URLS_` = 2 (EWS:154, 1233). A test pins
it (section 14, case E13). Forum replies with their own permalinks are handled by the "same link, different post" rule
in section 8 and the trial in section 5.

---

## Q1. Which Brandwatch mentions

**Decision.**

- **Project:** setting `bw_live_project_id` = `1998344909` ("[SLRR] Private", already the bot's project:
  `PW_BW_PROJECT_`, PW:98). One project in this round.
- **Queries: the owner ticks them on the bot-made tab `New sources`.** With row 49 ON, the bot reads
  `GET /projects/{project}/queries/summary` once a UTC day (the call Temp checks already make, TempCheck.gs:578) and
  writes one row a query below the source rows: `Read` (written `OFF` by the bot, never set ON by it; an ON/OFF
  dropdown), `Query`, `Collects` (its `contentSources`), `Languages`, `Suggested` (`yes` when the name matches
  `EWS_GOOGLE_CONFIG_RX_`, EWS:219, or the old Google feed names, `5fa77f1^:analytics/early_detection/01_setup_and_config.sql:280`),
  `Mentions today`, `Posts used today`. Only `id`, `name`, `contentSources`, `languages` are kept from the answer;
  `lastModifiedUsername` and `lockedByUsername` (map_bw-api 7.1) are never read into memory beyond the parse, storage,
  logs or the sheet. Query groups are never fetched.
- **At most 20 ticked queries are read** (`bw_live_queries_max`); more ticked: the first 20 by row, and the note says
  how many were left out. Nothing is read until at least one is ticked.
- **Content sources (never X):** each read asks `pageType=<name>` once per name (repeated, as
  `slrr_campaigns/brandwatch.py:609-613` sends several values) for the names in setting `bw_live_sources` =
  `[reddit, bluesky, facebook, facebook_public, instagram, instagram_public, tiktok, youtube, threads, tumblr, forum]`
  that also appear in today's `GET /metrics` `contentSources` (read once a UTC day; the reliable list for this
  account, map_bw-api 2.2; the `_public` names are this account's, TempCheck.gs:78-81). `twitter` and anything
  starting `linkedin` are refused by code even if a setting lists them. A source on the list that gives zero mentions
  for a whole day is named in the tab's row ("no Instagram mentions today").
- **Left out of Early Detection:** `news`, `lexis_nexis_licensed_news`, `blog`, `review` (publishers, not small
  accounts; their audience figure is the site's, PW:107-108), `linkedin*` (no text through the API, map_bw-api 5.4),
  and everything else not in the list.
- **Language:** `language=en` in the request; English is enforced again in SQL with `englishLangSql_` (Alert.gs:766-769)
  on the mention's `language`, and `ewsEnglishWordsSql_` (EWS:365-367) when the tag is empty (detection P16).
- **Sentiment:** not in the request; the Brandwatch job's SQL keeps `LOWER(IFNULL(sentiment,'')) != 'positive'` as the
  nightly lane does (EWS:455).
- **Entry types:** `xthreadEntryType=share` (reposts out; the one exclusion already sent live, TempCheck.gs:413). Not
  "posts only": Brandwatch leaves `threadEntryType` empty on non-threaded mentions (`slrr_campaigns/conversation.py:358-359`).
- **Google only** (detection P15): a mention is kept only when its text names Google (`EWS_ENTITY_RX_`, EWS:207-209) or
  its `queryName` matches `EWS_GOOGLE_CONFIG_RX_` (EWS:219).
- **Small accounts:** the shared gate unchanged (5,000 followers or fewer or unknown, under 500 engagements, EWS:126-127,
  381). Followers come from the platform's own field as `pwBwRow_` reads them (PW:1279-1280); `potentialAudience` only
  for `PW_BW_SOCIAL_` networks (PW:108). Big posts Sonar knew are kept out by the `xbig` list (section 8).
- **Short or withheld text:** a mention with no text or under 40 characters after cleaning fails the shared length gate
  (EWS:393) and is counted per source as "no words". When more than half of one source's mentions in a day had no words
  (the January 2026 Reddit restrictions are the likely case, map_bw-api 5.4, NOT VERIFIED), the note says so. Such a
  mention never enters the post-key index (section 8), so a later copy with words (AMIE, Sonar) is not blocked
  (stitching P3).

**Code places.** New file `apps-script-chat-bot/BrandwatchLive.gs` (prefix `bwl`): `bwlQueries_()`, `bwlSources_()`,
`bwlRequestUrl_(o)` (pure). New file `apps-script-chat-bot/NewSources.gs` (prefix `nsrc`): the tab. Reuses, without
editing: `pwBwToken_` (PW:1201), `pwHttpWhy_` (PW:1185), `pwBwTime_` (PW:1178), `pwBwRow_` (PW:1269) for link,
network, author, followers, engagements and times, `tcCleanHandle_` / `tcMentionAuthor_` (TempCheck.gs:717-744).

---

## Q2. The call

**Decision.**

```
GET https://api.brandwatch.com/projects/{bw_live_project_id}/data/mentions
  ?queryId=<A>&queryId=<B>...                 (the ticked queries, at most 20)
  &startDate=<now - 72 h, ISO Z>&endDate=<now + 5 min, ISO Z>   ("+" sent as %2B; bounds the posting time)
  &sinceAdded=<taken mark - 5 min, ISO Z>      (Brandwatch's own overlap recipe, map_bw-api 1.5)
  &orderBy=added&orderDirection=asc            (oldest added first: a page does not shift as new mentions arrive)
  &pageSize=300&page=0                          (page=1 only under the stall rule below)
  &pageType=reddit&pageType=bluesky&...         (Q1's list, never twitter)
  &language=en&xthreadEntryType=share&sourceType=new
```

Headers `Authorization: bearer <token>`, `Accept: application/json` (as PW:1236); GET only; `muteHttpExceptions: true`.

- **When.** In `poll()`'s `finally`, right after the Watch block (after Main.gs:713, operations P5: never in front of
  the Watch), through one call `bwLiveRun_(runStart, wanted.switches)` that never throws. It reads only when all hold:
  rows 49 and 19 ON; no parcel waiting (section Q5); at least `bw_live_every_minutes` = 10 min since the last read; at
  least 60 s left before `RUN_HARD_STOP_MS_` (Main.gs:774); not paused. In practice one read per Early Detection check
  (every 15 min, BQ:2888), which halves the overlap's repeats against a 5-minute rhythm (api-limits P12).
- **Two marks.** `taken`: the newest `added` of a parcel whose BigQuery job was collected (kept in `BWL_STATE`, a
  script property). `read`: the newest `added` **returned** by the last read, kept or dropped (X, no words, repeats),
  never moved back (api-limits P18). The parcel carries `to = read`; when the check collects the job carrying the
  parcel, `taken = to` and the parcel is deleted.
- **No gaps:** each read asks `sinceAdded = taken − 5 min`. A lost parcel (cache item evicted) is read again because
  `taken` did not move.
- **No repeats:** repeats from the overlap and from two queries matching one post are dropped twice: within a read by
  `queryId + resourceId` and by link key; across reads by the 24-hour new-lane post-key index of section 8 (they never
  reach embedding). The day count counts them anyway (it counts what Brandwatch returned).
- **Stall rule (api-limits P2).** If a read's first page is full and holds nothing added after `taken`, ask `page=1`
  (still one read); if that too holds nothing new, the next read asks `sinceAdded = taken` with no overlap, once, and
  the log line says "overlap skipped once: too many mentions in 5 minutes". A test with 1,250 mentions in the 5 minutes
  before the mark moves forward within two reads.
- **Checks on every page (api-limits P7, one-intake's idea):** `added` must not go down along the page, and none may be
  more than 60 s before `sinceAdded`. On failure the source stops (C49: "ignored 'added since'") until the row is
  turned OFF and ON; the marks do not move. An ignored filter would otherwise mean reading 72 hours oldest first forever.
- **First read after the switch goes ON:** `bw_live_first_minutes` = 30 minutes back. No backfill.
- **After a pause** (row OFF then ON, bot paused, reads skipped): `sinceAdded` is never older than `now − 2 h` (the rule
  of `EWS_MAX_WINDOW_MS_`, EWS:117). What was skipped is said in the note ("3 h 10 min were not read").
- **Several queries in one call:** `queryId` repeated (documented, map_bw-api 2.6). A 400 that names the query list:
  split the list in two for the next read and say so (the ceiling on ids per call is NOT VERIFIED).
- **The Watch's reader is not copied** (newest first, no overlap, mark jumps to the newest: PW:1230, 1249-1258,
  1082-1085). Only its pure helpers are called.

**Parcel.** `{from, to, n, rows}` in the script cache under `ews:bwl:p:<i>` items of at most 90,000 characters each
(at most 6 items), plus `{to, n, parts, at}` in `BWL_STATE`. Each row is the struct of section Q4 with text cut to
1,500 characters (the hash reads 1,500 characters of normalised text and the kept text is 600, EWS:397-398;
api-limits P17). At most `bw_live_parcel_max` = 300 mentions.

---

## Q3. Budgets

| Budget | Ceiling | Why this number |
|---|---|---|
| Brandwatch mention calls | 1 a read (2 under the stall rule); 1 `/metrics` and 1 `/queries/summary` a UTC day | about 100 calls a day |
| This bot's own calls in any 10 minutes (new reader only) | `bw_live_calls_per_10min` = 20, a ledger of call times in `BWL_STATE` | 3.3% of the shared login's 600 (`docs/discovery.md:70-71`); the Watch adds at most 8 (map_bw-code 8.5) |
| The shared login's use | read `x-rate-limit-used` and `x-rate-limit` on **every** answer, header names matched case-insensitively (operations P13); `x-rate-limit` parsed as `<limit>/<period>m` or bare digits; when used is 450 or more (`bw_live_pause_at_used`), no read for 10 minutes; a missing header shows "the shared login's use: unknown" on the tab | leaves 150 calls for everyone else; the reading is the answer's own, not a stale one (api-limits P10) |
| HTTP 429 | no read for 10 minutes | |
| Mentions a read | 300 (`bw_live_parcel_max`) | about 1 MB a page (3.2 KB a mention, map_bw-api 1.5); fits the new-lane share of embedding (Q5) |
| Mentions a day | 30,000 (`bw_live_mentions_per_day`), counted as every mention Brandwatch returned, kept or not, on the Eastern day (as `PW_TODAY`, PW:131-135) | 5% of the owner's 600,000 a day. Nobody knows whether other Google teams share it (owner question 1). At 300 a read and about 96 reads a day the bot cannot pass 28,800 by construction; the ceiling is a backstop. |
| Pacing (api-limits P13, operations P16) | a read is skipped when today's count is above `30,000 × (hours since midnight ET + 1) / 24`; it reads on at the next hour from where it stopped | a busy morning cannot blind the afternoon |
| Counts survive OFF (operations P4) | the day's mention and call counts live in their own property `BWL_DAY` that turning a row OFF never clears; only marks and the parcel are cleared | flipping the row cannot reset the ceiling |
| Every Brandwatch mention the bot reads, all features (api-limits P11) | step 2c adds one shared counter `bwCountMentions_(n, feature)` called by the Watch's `pwBwMentions_` and Temp checks; C49 then says "the bot read 41,200 Brandwatch mentions today, all features"; until 2c is built the note says "this reader" | the Watch alone can return 5,760 to 92,160 a day (api-limits P11) |
| Repeated refusals (api-limits P14) | 401: tried again next read; three 401s in a row: hourly. Any other 4xx: no read for an hour, Brandwatch's message in C49 (token and addresses removed) | the token is renewed only by `slrr-campaigns` after its own 401 (map_bw-code 0.7) |
| AMIE | one BigQuery job a check (with the two existing), `maximumBytesBilled` 1 GB (`amie_max_gb`); one dry run a UTC day; one `tables.get` an hour | counted by `apiGuardNote_('bigquery', n)` as every lane is (EWS:661) |
| Apps Script time | the Brandwatch read: starts only with 60 s left before the hard stop; a second page only with 45 s left; the new jobs wait inside the existing `fetchAll` (no added wall time) | the Watch needs 20 s (PW:83) and runs before it |
| Apps Script fetches | about 100 Brandwatch calls, 100 Secret Manager reads, 200 BigQuery calls and 24 `tables.get` a day | the daily quota is NOT VERIFIED (map_control-tests 3.4); the tab's first row shows "calls today" for the new sources so the first live week tells how close it is |
| X embed lookups | none: the new sources never call X's embed data (AMIE carries X words; Brandwatch is never asked for X) | api-limits P16 / operations P18 do not arise |

---

## Q4. Gates

**Decision: in SQL, in one copy, for both new sources.** Each new source is its own BigQuery job whose SQL is
`WITH lanes AS (<the source's part>), <ewsGateCtes_(slowLanes)> <ewsPostSelectSql_(slowLanes)>` plus its own extra
rows. So the clean text, length, tokens, homonym, spam, script, age, Grok, content hash, signature, risk groups and
Google naming (EWS:374-422) are the same text as every other lane's, and the hash and signature come out the same way.

- `ewsGateCtes_` and `ewsPostSelectSql_` gain one optional argument, the list of slow lane names. Called with none they
  return exactly today's text (`IN ('bw', 'tub')` at EWS:387, 405, 419), so the US and us-central1 SQL do not change.
  The AMIE job passes `['amis']`, the Brandwatch job `['bwls']`.
- The Brandwatch job reads its rows from `@bwl`, an array-of-structs parameter built by `pwParam_` (PW:929-946, called,
  not edited). `ewsJobRequest_` (EWS:587-597) maps a parameter with a `struct` field to `pwParam_`, every other one to
  `ewsParam_` as today. Unknown numbers travel as `-1` and come back as NULL with `NULLIF(c.f, -1)` (map_ed-intake 5.3).
- `ewsLaneQuery_` (EWS:549-579) stays pure (its test calls it with no services, T/switch_early_wave_source.test.js:62-63):
  the parcel rows and AMIE's mark are passed in as arguments, never read inside it.
- The only rule in JavaScript is the X drop (Q7), before rows are put in the parcel.

**Drift, and how tests pin it** (no test executes SQL, map_ed-intake 9.3): (1) wording tests that each new part holds
its own rules (not positive, the English tests, the Google rule, the staff and KOF feed rule, `posted IS NOT NULL`);
(2) a test that each new job's SQL contains `ewsGateCtes_` applied once to `lanes` and nothing else feeds the post
select; (3) a snapshot test that with rows 48 and 49 OFF the US and us-central1 request bodies equal the `3be2e06` ones;
(4) the hand-run live check (stage 0, `verifyNewSourcesLive`) sends both new jobs as BigQuery **dry runs** with three
sample `@bwl` rows, which proves the SQL compiles with the array parameter (operations P19).

---

## Q5. Into the stories

**Lane names and the slow split.** `ami` and `bwl` are real time; `amis` and `bwls` are slow (first seen more than
`early_wave_new_late_minutes` = 180 min after posting, decided in each job's SQL). One constant
`EWS_SLOW_LANES_ = ['bw', 'tub', 'amis', 'bwls']` replaces the name test in `ewsPostOf_` (EWS:725); the SQL uses the
per-job list (Q4). `EWS_NEW_LANES_ = ['ami', 'amis', 'bwl', 'bwls']`. `ewsPostOf_` sets `nl: true` for these; members
and pool records keep it as `nl: 1` (`ewsMember_`, EWS:998-1007; `ewsPostOfPool_`, EWS:1015-1019), written only on
new-lane posts, so records of today's lanes are unchanged.

**The jobs.** `EWS_LANES_` (EWS:109) becomes a function `ewsLanes_(sw)` returning today's two entries, plus
`{key: 'ami', location: 'US'}` while row 48 is ON (and AMIE not paused), plus `{key: 'bwl', location: 'US'}` while
row 49 is ON and a parcel waits. `ewsReadLanes_` (EWS:641-707) already loops over the list, so the new jobs go in the
same `fetchAll` and wait side by side. A new job still running is collected by a later check like today's
(EWS:648-651). `ewsProduce_` (EWS:1692-1979) takes the new lanes' rows into `allRows` (EWS:1706), and four places keep
them apart: `anyDone` and the C19 error (EWS:1966-1969) count only `us` and `c1`, so C19 says nothing new; covered hours
(EWS:1748-1754) count only `us` and `c1`; the cursor block (EWS:1942-1954) adds `marks.ami` (the `amark` row, Q6) and,
for `bwl`, `taken = flags.to`; the `problems` line names a failed new job, but `last.problem` for C19 keeps only
today's lanes.

| Place | Today | With the new lanes |
|---|---|---|
| Starting a story (Stage B, EWS:1770) | real-time posts | `ami`, `bwl` posts can start one, with posts of the same check and the pool |
| The 5-account bar, 3 for the early watch (EWS:1181-1237) | members posted in the last 180 min | unchanged; new-lane accounts count when fresh, with three limits below |
| Velocity (EWS:1741) | every real-time post | `posts.filter(p => !p.slow && !p.nl && ...)`; today's lanes never lose a row (section 8) |
| The `acc` cache item (EWS:1904) | close to full (map_ed-intake 6.4) | unchanged: new lanes add no rows |
| Covered hours (EWS:1748-1754) | the two jobs | unchanged |
| The pool (EWS:1798, 1919-1930) | the newest 1,200 unjoined real-time posts, 6 h | new-lane posts too, at most `early_wave_new_pool_max` = 300 of the 1,200 and for `early_wave_new_pool_minutes` = 120 min; today's lanes keep at least 900 places (detection P5, P12) |
| Embedding a check (EWS:1658-1683) | 400, newest first, slow last | today's lanes first, up to 300; new lanes up to `early_wave_new_embed_per_check` = 100; room one side leaves goes to the other; with no new-lane post today's lanes get 400 as now |
| Embedding a day (EWS:137) | 20,000 | new lanes embed only while the day's total is under `min(15000, 20000 × (UTC hours elapsed + 1) / 24)` and their own day count is under `early_wave_new_embed_per_day` = 5,000 (detection P10); "new sources stopped embedding for today to keep room for Sonar" on the tab |
| A new-lane post with no embedding | n/a | kept for the next check in one cache item `ews:carry` (at most `early_wave_new_carry_max` = 100, 2 hours), embedded first next time; beyond that counted "not embedded" on the tab (detection P6) |
| Same-author signatures (EWS:768-782) | one set | two sets: today's lanes check and write only theirs (exactly as now); new-lane posts check both and write only `sn:N` items (detection P1) |

**Three limits on what new-lane accounts can do at promotion** (all inside `ewsStoryWindow_` / `ewsPromote_`,
EWS:1180-1240, by an optional argument, so with no new-lane member the result is today's):
1. A member whose author is on the new-lane exclusion lists (AMIE's KOF and staff authors, Q6) or whose post key is on
   the `xbig` list (section 8) is not counted.
2. Platforms that lower the bar to 4 (EWS:1232) and make a story P1 (EWS:1237), and "a platform it didn't have" in the
   same-story check (EWS:1215-1216), count only platforms with a member from today's lanes (detection P7c; stitching P8
   becomes harmless: a `Forum` vs `Forums` split from a new lane adds no platform).
3. **Trial, then a cap (detection P7).** A story whose accounts without the new-lane members would be under the bar is
   "lifted". For `early_wave_new_trial_days` = 7 days after a source's row first goes ON (date kept in `EWS_SRC_DAY`,
   never cleared by OFF), lifted stories are not signalled: they are listed on the New sources tab (newest 20: time,
   headline, accounts, links) and counted ("noted, not sent for review"). After the trial, at most
   `early_wave_new_lifted_per_hour` = 2 and `early_wave_new_lifted_per_day` = 20 lifted stories are signalled; the
   rest are noted. Stories that pass the bar with today's lanes alone are never held back.

**Not in this round:** velocity from the new sources (it needs a warm-up per source; the intake map measured 8 false
signals a day for 4 days from a new flow, map_ed-intake 8.2); the late-post defect in today's lanes
(EWS:1286-1319, map_ed-intake 8.3: fixing it changes today's velocity, so it is its own small fix for the owner to
approve; the new lanes do not worsen it because they add no velocity rows).

---

## Q6. The AMIE table

**Paths and order.** Early Detection (stage 1), the Watch (stage 3). Direct BigQuery cards and the review's Mode A
lookups: not in this round (Q10).

**Which rows.** Every network, X first by nature (it is the one source besides Sonar with X words), with:
- the feeds in `BQ_NON_GOOGLE_SOURCES_RX_` (BQ:133-138) and any feed named `positive` left out;
- staff and KOF feeds left out of Early Detection: setting `amie_staff_feeds_rx` = `kof|kol|\binfs?\b|exec|googler|reps|posts by google`
  on `alert_source` (detection P2: `chrome execs`, `chrome kofs`, `googlers posting on x`, `google reps & execs` are in
  the old "Google feeds" list); their authors are returned as `xkof` rows and kept 7 days, and any new-lane post by
  them is left out (today's lanes are not filtered by it: rule 2);
- rows whose `KOF` reads as a KOF (the old pipeline's test, `5fa77f1^:...01_setup_and_config.sql:277`) left out, authors
  to `xkof` too;
- rows with tier `MODERATE` or `HIGH` (500+ engagements by the alert emails' scale, `docs/discovery.md:40`) left out:
  not low tier;
- only links on a social network's domain (a regex built from `GEN.platform_domains`, Generated.gs:1295) or rows whose
  `SocialNetwork` is a forum: no news sites or blogs through AMIE (detection P8);
- feeds in the old Google list need no keyword; every other feed must name Google in the text (the old pipeline's
  `requires_entity_match`);
- while row 49 is ON and Brandwatch's last read is under an hour old, AMIE's rows on the networks Brandwatch live is
  asked for are skipped (`@skip_nets`), so AMIE fills X and what the API leaves out (detection P17; the owner: AMIE is
  "the gap in brandwatch api and their missing x data"). When Brandwatch live stops, AMIE reads every network again.

**The SQL** (built from the columns the hourly metadata check found; an optional column missing becomes `NULL`;
`<...>` marks text the code inserts):

```sql
WITH raw AS (
  SELECT url, alert_source, snippet, authorHandle, SocialNetwork, Sentiment, postTime, ingestionTimestamp,
         <followers | NULL> AS followers, <KOF | NULL> AS KOF, <product | NULL> AS product, <engagement | NULL> AS tier
  FROM `brand-social-central-data.social_alerts_dataset.all_sundar_mentions`
  WHERE ingestionTimestamp > TIMESTAMP_MILLIS(@ami_from_ms)            -- the partition filter (DAY(ingestionTimestamp))
    AND ingestionTimestamp <= TIMESTAMP_MILLIS(@until_ms) AND url IS NOT NULL
),
taken AS (SELECT * FROM raw ORDER BY ingestionTimestamp, url LIMIT @ami_take),   -- oldest landing first; the mark
rows AS (
  SELECT url, LOWER(TRIM(REGEXP_REPLACE(IFNULL(authorHandle, ''), r'^@+|^/?u/', ''))) AS h,
    MIN(postTime) AS posted, MIN(ingestionTimestamp) AS seen,
    ARRAY_AGG(snippet IGNORE NULLS ORDER BY CHAR_LENGTH(snippet) DESC LIMIT 1)[SAFE_OFFSET(0)] AS raw,
    ANY_VALUE(SocialNetwork) AS net, MAX(SAFE_CAST(followers AS INT64)) AS audience,
    COALESCE(ANY_VALUE(NULLIF(TRIM(product), '')), ANY_VALUE(alert_source), 'Unclassified') AS topic,
    LOGICAL_OR(REGEXP_CONTAINS(LOWER(TRIM(IFNULL(alert_source, ''))), r'<old Google feeds list>')) AS gfeed,
    LOGICAL_OR(REGEXP_CONTAINS(LOWER(IFNULL(alert_source, '')), r'<amie_staff_feeds_rx>')
      OR REGEXP_CONTAINS(IFNULL(KOF, ''), r'(?i)^(yes|true|1)|\b(KOFs?|INFs?|KOLs?)\b')) AS kof,
    LOGICAL_OR(UPPER(IFNULL(tier, '')) IN ('MODERATE', 'HIGH')) AS big,
    LOGICAL_AND(LOWER(IFNULL(Sentiment, '')) != 'positive') AS notpos
  FROM taken
  WHERE NOT REGEXP_CONTAINS(LOWER(IFNULL(alert_source, '')), r'positive')
    AND NOT REGEXP_CONTAINS(LOWER(TRIM(IFNULL(alert_source, ''))), r'<BQ_NON_GOOGLE_SOURCES_RX_>')
  GROUP BY url, h                                         -- one row a post and author, across the feeds (stitching P10)
),
lanes AS (
  SELECT IF(TIMESTAMP_DIFF(seen, posted, MINUTE) > @late_min, 'amis', 'ami') AS lane,
    CONCAT('AMI|', SUBSTR(TO_HEX(SHA256(CONCAT(url, '|', h))), 1, 24)) AS mid, url, net AS platform, h AS author,
    audience, CAST(NULL AS INT64) AS eng, posted, seen, raw, topic
  FROM rows
  WHERE NOT kof AND NOT big AND notpos AND posted IS NOT NULL
    AND (REGEXP_CONTAINS(LOWER(url), r'<social domains>') OR REGEXP_CONTAINS(LOWER(IFNULL(net, '')), r'^forums?$'))
    AND NOT (LOWER(IFNULL(net, '')) IN UNNEST(@skip_nets))
    AND (gfeed OR REGEXP_CONTAINS(LOWER(IFNULL(raw, '')), r'<EWS_ENTITY_RX_>'))
    AND <ewsEnglishWordsSql_('raw')>                      -- no language column (map_sources-history 1g)
),
<ewsGateCtes_(['amis'])>
<ewsPostSelectSql_(['amis']), its cap @ami_max>
UNION ALL SELECT 'amark' AS kind, ..., UNIX_MILLIS(MAX(ingestionTimestamp)) AS seen_ms, ... FROM taken
UNION ALL SELECT DISTINCT 'xkof' AS kind, ..., h AS author, ... FROM rows WHERE kof AND h != ''
```

The two extra row kinds use the same 16 columns as `xurl`/`xkof`/`own` (EWS:460-480). Parameters: `@ami_from_ms`,
`@until_ms` (the check's `until`, EWS:642), `@ami_take` = `amie_rows_per_check` = 300, `@ami_max` = 300, `@late_min`
= 180, `@skip_nets` (ARRAY<STRING>), plus the shared gate parameters (EWS:556-560). The engagement column is not read
as a count ("BMIE's engagementScore is empty", `ace865c^:apps-script-chat-bot/BigQuery.gs:2306`).

**Window and mark.** `@ami_from_ms = max(marks.ami − amie_overlap_minutes (60) min, until − 6 h)`; first read:
`until − 60 min`. `marks.ami` = the `amark` value, moved only when the AMIE job is collected; never back. Repeats
brought by the overlap are dropped by `mid` against the 24-hour new-lane post-key index (section 8) and counted
("late rows caught by the overlap" = repeats whose `seen` was before the previous mark; when that number is often
near the overlap's edge, the overlap is too small and the tab says so).

**The column check.** Hourly while row 48 is ON (and at the first check after it goes ON), one
`GET https://bigquery.googleapis.com/bigquery/v2/projects/brand-social-central-data/datasets/social_alerts_dataset/tables/all_sundar_mentions`
(`tables.get`, no bytes; `tables.get` is already used, BQ:428). Needed: `url`, `alert_source`, `snippet`,
`authorHandle`, `SocialNetwork`, `Sentiment` (STRING), `postTime` and `ingestionTimestamp` (TIMESTAMP). Optional:
`followers`, `KOF`, `product`, `engagement`. It also reads `lastModifiedTime` and `timePartitioning`. Once a UTC day,
and after any failure, the AMIE job is first sent as a **dry run** (`dryRun: true` on `jobs.query`; checks names and
access, scans nothing, returns the bytes; NOT VERIFIED here that the request field is spelled so, from memory of the
API). Then:
- a needed column missing or of another type, or access refused: AMIE stops for the day; C48 says why; the other lanes
  go on;
- the dry run's bytes over 1 GB (`amie_max_gb`), or the table no longer partitioned by `ingestionTimestamp`: AMIE stops
  for the day ("would scan 3.2 GB");
- an AMIE job that fails for any reason: AMIE pauses an hour, then must pass a dry run before its next job (operations P1);
- **stale** (operations P7, api-limits missing 6): when the newest `ingestionTimestamp` seen (from `amark` or
  `lastModifiedTime`) is more than `amie_stale_hours` = 3 h old, the note starts "⚠️ the AMIE table has had no new rows
  since ...". Nothing is skipped: the mark waits for the rows.

**Cost.** Partition-pruned to one or two days; about 24,800 rows a day on 29 October (`9e5f0b1^:docs/discovery.md:96`);
bytes never recorded (NOT VERIFIED); the dry run's figure goes on the tab the first day.

**Freshness as recorded.** Written every few minutes, a row landing about 20 minutes after its `ingestionTimestamp`
(`5fa77f1^:analytics/early_detection/02_low_tier_ingestion.sql:10-11`), but "most posts arrive about a day after they
went up" (`ace865c^:apps-script-chat-bot/README.md:264`). So most AMIE posts will come in as `amis` (join only); AMIE
gives Early Detection more posts with words more than speed. The tab measures the delay per day.

**Approved-table tests changed on purpose (stage 1, step 1c), the owner's approval of 16 November named in the commit:**
- `T/switch_alert_memory.test.js:17-34`: add `brand-social-central-data.social_alerts_dataset.all_sundar_mentions` to
  `approved`; `:67`: take `all_sundar_mentions` out of the retired-token pattern; the title "6" becomes "7".
- `T/switch_early_wave_source.test.js:60-74` and `T/switch_i_early_wave.test.js:231-245`: titles say 7; with row 48 ON
  the AMIE job names only AMIE and no us-central1 table; the us-central1 check stays.
- Stage 3 only: `T/switch_proactive_watch.test.js:39` (`DROPPED_TABLES` loses `all_sundar_mentions`), `:28-29`
  (`US_SOURCES` gains `amie`), `:541` (title); `:546` and `:548` stay (no source `bmie`, no `bmie_*` parameter).
- Unchanged: `T/switch_fast_triage.test.js:306` (a fixture leak test) and `tests/test_review_fixes.py:289-317` (the
  Python deep dive stays off AMIE).
- The documents that state the rule, same commit (operations P14): `docs/discovery.md:90` (the approved list gains the
  table, "approved by the owner, 2026-11-16"), `apps-script-chat-bot/README.md:541, 777, 1442` (say 7),
  `apps-script-chat-bot/README.md:307-308` (read again, since when, behind row 48). The PW header (PW:35-38) changes in
  stage 3 with the Watch's code.
- Code name: `ami` / `AMI|` in code, "AMIE" for people; never `BMIE`/`bmie`, which at head means "DSD + the nightly
  table" (map_sources-history 5).

---

## Q7. X

| Path | X after this plan | From Brandwatch's API? |
|---|---|---|
| Early Detection | Sonar's first-seen posts (EWS:501-527), Sprinklr comments on Google's X posts, and AMIE's X rows with their words (stage 1) | never |
| Proactive watch | Sonar, the election query `bwq` as today (X words from X's embed data, PW:1319-1323), AMIE (stage 3) | only the existing `bwq`, unchanged |
| Direct BigQuery cards | unchanged: Sonar and DSD | never |

- **The request never asks for X:** the positive `pageType` list (Q1), with `twitter` refused in code.
- **The check in code** (`bwlIsX_`, pure): a mention whose `contentSource` or `pageType` is `twitter` or `x`, whose
  `url` or `originalUrl` is on `x.com` / `twitter.com`, or that has a numeric `guid` and no `url` (the shape of an X
  mention, map_bw-api 5.1) is dropped before the parcel and counted. **One such mention stops the source** (api-limits
  P4, operations P6): the marks move to the newest `added` returned (so the same X is never read again), the parcel of
  that read is still handed over without the X, and nothing more is read until the row is turned OFF and ON. C49:
  "⚠️ stopped: Brandwatch sent 3 X posts although the bot asked for none ...".
- No X embed lookup is ever made by the new sources.
- AMIE's X links: kept as they come (the record shows `twitter.com/<handle>/statuses/<id>`, map_sources-history 1g).
  The author rule never takes `i`, `intent`, `home`, `search` or `web` from an X link (stitching P7; Alert.gs:631-632 has
  the same list): it falls back to `authorHandle`.

---

## Q8. Stitching: one post, one person, one alert

**Where each path does it today** (map_sources-now 4.1-4.4): Early Detection keeps lane ids apart (EWS:1717-1720) and
compares links only with DSD's alerted list (EWS:761); the Watch keys a post by an SQL link key inside a look
(PW:807-808) and by `recordKey_` on its tab (PW:1404); Watch alerts and Direct cards ask the alert memory (`seenPost`,
`claim`, `amPostKey_`, AM:177-209, 1006-1043); an Early Detection card is remembered by its primary post only
(EarlyDetection.gs:405-407).

**One post: the post key** `k = amPostKey_(url)` (AM:177-209; X `x:<id>` whatever the link form, Instagram `/p/` and
`/reel/`, TikTok with or without the handle, Bluesky handle or DID, Facebook `posts/` or `story_fbid=`; a Reddit
comment `rd:<thread>/<comment>` apart from its thread). In Early Detection it is stored as a 64-bit hash
(`ewsFnv_` of the key and of the key reversed, 16 hex characters: detection P21) in:
- the **new-lane post-key index**: keys of every new-lane post that passed the gates, and of every post of today's lanes
  in the same check (while a new switch is ON), 72 hours (stitching P17: as long as the slow age gate), in chunked
  cache items `ews:nk:N` rewritten each check like the signatures (EWS:768-787), each under 95,000 characters;
- members and pool records, as `k`, written only while a new switch is ON.

**The rules, in order, before the "already known" step (new function `ewsStitch_`, between EWS:1711 and 1715):**
1. **Today's lanes are never dropped.** Their posts go on exactly as today, velocity rows included.
2. **A new-lane post is dropped** when its key is in the index, or equals the key of a post of today's lanes in this
   check, a story member or a pool post; within one check `bwl` is kept before `ami` (detection P17: the live copy is the
   fresher). Counted "same post as another source". Exception: **same link, different post** (stitching P10): when the
   matching post has a different author **and** a different content hash, both are kept.
3. **A later copy from today's lanes takes the new-lane member's place** (stitching P1): when a post of today's lanes
   has the key of a story member that came from a new lane, the member's id, account, platform, link, followers,
   engagements and `nl` are replaced by the copy's; it is not joined a second time; it keeps its velocity row (rule 1).
   Counted "replaced by another source's copy", and the gap between the two `seen` times is the "seen first" measure
   (Q13).
4. **A later new-lane copy that brings what the first lacked** (stitching P3): only posts that passed the gates enter the
   index, so a copy with no words never blocks a later copy with words. A later copy that marks a member as a KOF
   (AMIE's `xkof`) or as big (`xbig`) makes the bar skip that member (Q5 limit 1).
5. **Big posts Sonar knew** (stitching P5): while any new switch is ON, the us-central1 job also returns `xbig` rows: the
   links of Sonar posts in its window that failed only the audience, engagement or influencer tests (a part added to
   `ewsC1Sql_` only when its flag is ON, so the OFF text is unchanged). Their keys are kept 24 hours in cache item
   `ews:xb`; a new-lane post with such a key is dropped.
6. **Already alerted** (stitching P5, missing 1): a new-lane post that the alert memory has seen in 24 hours or emailed
   in 14 days (`alertMemory_().seenPost(url)`, AM:136, 1006-1027) is dropped, like a post DSD alerted (EWS:745, 761).
   Today's lanes are not filtered by it in this round (rule 2 of section 0).

**Which fields win:** the copy from today's lanes wins in full (rule 3). Between the two new sources, the first copy
wins and no field is merged in this round, except as rule 4 says.

**One person: `ewsNewAuthor_(platform, author, url)`**, applied to new-lane rows in `ewsPostOf_` only (today's lanes
keep their account keys, rule 2 of section 0): lowercased; leading `@`, `u/`, `/u/` removed; for X, Bluesky, TikTok and
Threads the handle from the link the way Sonar's lane does (EWS:504-508), but never `i`, `intent`, `home`, `search`,
`web`; never a subreddit (`r/...`); a value shaped like an email address is replaced by the link (and never logged);
blank: the link. Platform: from the link's domain first (`ewsPlatform_`, EWS:330-341); a new-lane post on an unknown
domain is `Web`.

Worked examples (each a test):

| Copies | Result |
|---|---|
| Sonar `x.com/newsdesk/status/2116390716536770729`, AMIE `twitter.com/newsdesk/statuses/2116390716536770729`, same check | one post (Sonar's); AMIE's dropped; account `X:newsdesk` once |
| `bwl` Reddit post at 10:15 (author `u/alice`), Sonar's copy at 10:45 (author blank) | one member: at 10:45 Sonar's copy replaces it (account `Reddit:<link>` from Sonar's lane, as today); the story's accounts are not counted twice; "seen first: Brandwatch, 30 min sooner" |
| Instagram `/p/C1abc/` from `bwl`, `/reel/C1abc/` from Sonar | one post (`ig:C1abc`) |
| `bwl` Reddit `u/alice` and Sonar `alice` on two different posts | `Reddit:alice` from both: one account |
| Five AMIE X posts as `x.com/i/status/<n>` by five handles | five accounts (from `authorHandle`), never `X:i` |
| Two Reddit comments sharing the thread link, different authors, different words | two posts |
| A TikTok post Sonar saw at 2 million followers, then `bwl` with followers unknown | `bwl` copy dropped (`xbig`) |
| A post a Watch alert claimed an hour ago, then `ami` | `ami` copy dropped (alert memory) |

**One alert across paths.**
- Early Detection: its 24-hour story keys (BQ:3158-3230) as today; because a new-lane copy of a known post is dropped,
  it cannot make a second story.
- The Watch (stage 3): the `amie` source's in-look key uses the X status id (`(twitter|x).com/.../status(es)/<id>` →
  `x.com/status/<id>`) only in the `amie` part, so AMIE's and `bwq`'s copies of one X post share a key (stitching P12:
  links are never rewritten). Sonar (us-central1) and AMIE (US) are different jobs, so both may be asked: counted.
  Watch alerts for rows from `amie` and `bwm` (sources that arrive more than 24 hours late) ask
  `seenPost(url, {hours: 168})`, a 7-day window, so a nightly copy days later gets no second card (stitching P11).
- **Before stage 3 is switched on (precondition, step 3a):** every member of a carded Early Detection story is claimed
  in the alert memory (`claim(url, 'early', ...)`, AM:1029-1043), not only its primary post (EarlyDetection.gs:405-407),
  so the Watch never cards a post an Early Detection card already covers (operations P9, detection P18, stitching P5).
- Direct cards: unchanged (no new source).

**Not in this round:** learning account aliases from repeats (stitching P9: the replace rule and the
today's-lanes-only platform rule remove the cases that lift a story; aliases come after two weeks of the tab's
"replaced" counts); normalising today's lanes' authors (it changes today's account keys: its own fix); moving the four
older keys (`normalizeUrl_`, `recordKey_`, the Watch's SQL key) to `amPostKey_` everywhere.

---

## Q9. Other data we have

| Candidate | Verdict | Reason |
|---|---|---|
| AMIE `all_sundar_mentions` for Early Detection | now (stage 1) | X with words and Brandwatch's alert feeds; no API allowance; the owner approved it |
| Brandwatch API, social networks and forums, for Early Detection | now (stage 2) | the only live source of non-X Brandwatch posts |
| AMIE for the Watch | now (stage 3) | restores what the Watch lost on 11 November |
| The alert memory as a leave-out list for new-lane posts | now (stage 1) | stops a second card for one post (Q8 rule 6) |
| Sonar's posts too big for Early Detection, as a leave-out list | now (stage 1) | stops a big post entering through a source that has no follower count (Q8 rule 5) |
| Sonar `sonar_raw`, Sprinklr comments and outbound, the nightly Brandwatch table, Tubular, DSD | keep as they are | the owner said keep; the new lanes stitch to them by post key |
| AMIE for Direct cards and Mode A lookups (KOF list names, tier) | later | BigQuery.gs is being rewritten; the owner ranks Direct cards third; AMIE's engagement column is recorded as empty |
| Brandwatch API news, blogs, reviews | later, for the Watch | publishers are not small accounts; reach is the Watch's measure |
| Brandwatch live in place of the Watch's `bwq` reader and nightly `bwm` | later | after stage 2 has run a week |
| `brandwatch_automated_exports.raw_brandwatch_exports` | later, after a live look | CSV exports with ids and full text; freshness never recorded (map_sources-history 4) |
| SLRR alert log at Early Detection's intake | later | accuracy, not more posts; same-day rows may be missing (Escalate.gs:649-656) |
| Brandwatch API X (with X embed fill) | never | the team's X rule (PW:1218-1219); Sonar and AMIE carry X with words |
| Brandwatch API LinkedIn | never in this form | no text through the API |
| DSD story selection as Early Detection input | never | already-alerted posts, left out on purpose (EWS:12, 745-747) |
| The Other alerts space for Early Detection | never | they are alerts, not posts |
| Sonar posts that grew, for Early Detection | never | Early Detection is the low tier by definition |
| Brandwatch query groups | never | their `users` list holds email addresses; the tab does the job |
| `DSD.brandwatch_daily`, `reddit_pulse.reddit_items_raw`, `DSD.content_vectors`, `social_alerts_dataset.brandwatch_mentions` | never | stale (20 Sep, 25 Oct, 24 Sep, 21 Mar) |
| `google_bg.sonar_post_aggregates_7d_materialized` | never | a 7-day aggregate; `sonar_raw` covers it |
| `google_bg.collection_alerts`, `google_bg.slrr` | never | Burson's own collection: what the bot races, not a source |
| `early_detection.vw_chatbot_pending_early_alerts`, `stg_sprinklr_outbound_media_assets_json_source` | never | orphaned; replaced |

---

## Q10. The Watch and Direct BigQuery

- **The Watch, stage 3:** AMIE back as source key `amie` (name "Brandwatch alert feeds (AMIE)"), US look, its SQL taken
  from `ace865c^:apps-script-chat-bot/ProactiveWatch.gs:597-649` with these changes: key and parameter names `amie`,
  `@amie_from`; read from 40 min before its mark with the keys of rows handed over in the last 24 hours kept as hashes
  (cache item `pw:amie:k`), so late-landing rows are caught and not sent twice (operations P10); links kept as they come
  and the X status-id key (Q8); a day cap `watch_amie_per_day` = 300 for the first weeks (operations Q10; the old figure
  was about 1,800 a day from the Google feeds plus about 700 with a sign of trouble, `ace865c^` README.md:264);
  `staleMs` 2 h as before; at most 100 a look to Gemini (the old `cap`). Its own switch, row 50 (needs row 34). One row
  on the Watch sources tab, and the existing per-source error and stale words there.
- **Cost:** at most 300 Gemini (AI.IF) looks a day more at first. How many more cards: NOT VERIFIED; the owner reads the
  Watch's scorecard for a week before the cap is raised.
- **Precondition:** step 3a (Q8). Stage 3 starts after the larger change has merged (it edits PW and WatchAlerts.gs).
- **Brandwatch live for the Watch:** not in this round.
- **Direct BigQuery cards:** nothing new. BigQuery.gs is being rewritten; Direct posts at most 2 cards a check (BQ:80)
  and needs 500+ engagements, which AMIE does not carry as a number; the owner ranks it third.

---

## Q11. Switches and settings

**Switches** (entries appended to `CONTROL_SWITCHES_` after Control.gs:568, each with `row`, written OFF by
`ensureSwitchRows_`, Control.gs:643-660, never set ON by code). Stage 1 moves "How it works" once, from row 49 to
row 52 (`CONTROL_HELP_ROW_`, Control.gs:297; the blank row before it becomes 51; precedent commit `51a5880`), and adds
row 48; stages 2 and 3 add rows 49 and 50 with no further move. Rows 49 and 50 stay blank until then. No existing row
moves.

| Row | Key | Label (column A) | OFF text | Waiting text | ON text |
|---|---|---|---|---|---|
| 48 | `edAmie` | `Early Detection: also read the AMIE table` | `OFF (Early Detection does not read the AMIE table)` | `✓ ON, but waiting: it needs Early wave & velocity check (row 19) ON, which it adds posts to` | `✓ ON: each Early Detection check also reads new rows of the AMIE table (Brandwatch's alert feeds, X with its words)` (115 characters) |
| 49 | `edBwLive` | `Early Detection: also read Brandwatch live (not X)` | `OFF (Early Detection does not call Brandwatch)` | the row-19 waiting text, or `✓ ON, but waiting: tick Read = ON for at least one query on the New sources tab` | `✓ ON: reads new Brandwatch mentions (never X) from the queries ticked on the New sources tab, for Early Detection (row 19)` (122) |
| 50 | `watchAmie` | `Proactive watch: also read the AMIE table` | `OFF (the Watch does not read the AMIE table)` | `✓ ON, but waiting: it needs Proactive watch (row 34) ON` | `✓ ON: the Watch (row 34) also checks new rows of the AMIE table (Brandwatch's alert feeds, X with its words)` (108) |

Help lines (each starting `• <label>: `, T/switch_control.test.js:45-46) in plain words; the row-19 line
(Control.gs:144-146) gains "with row 48 or 49 ON, Brandwatch's posts can start a story too"; the switch-rows line
(Control.gs:124) lists 48-50; `CONTROL_HELP_ROWS_` (Control.gs:298) +3.

**Column C notes** (after ` · `, written by `noteSwitch_`, cut at 200 characters, Control.gs:842; **the warning comes
first, at most one warning, counts last**, operations P8; every failure says since when, operations P7c). Lengths
measured (scratch `spec/len.js`):

| Row, situation | Note | chars |
|---|---|---|
| 48 healthy | `read 10:15 AM · today: 1,240 rows, 310 posts used, 41 same as another source, 22 in stories (4 started) · most arrive 1-12 h after posting · New sources tab` | 156 |
| 48 trial | `trial until Nov 23: 3 stories it alone lifted were noted, not sent for review (New sources tab) · read 10:15 AM · today: 1,240 rows, 310 used` | 141 |
| 48 column changed | `⚠️ since Nov 16 10:15 AM (2 h): the AMIE table has no column "snippet" any more, so it isn't read. The other sources go on (New sources tab)` | 140 |
| 48 no access | `⚠️ since Nov 16 10:15 AM (2 h): BigQuery won't let the bot read the AMIE table (access denied), so it isn't read. The other sources go on` | 137 |
| 48 stale | `⚠️ the AMIE table has had no new rows since 6:40 AM (3 h; it is usually written every few minutes). It reads on when rows come` | 126 |
| 48 too costly | `⚠️ stopped for today: one read of the AMIE table would scan 3.2 GB (the limit is 1 GB). It tries again tomorrow; the other sources go on` | 136 |
| 48 job failed | `⚠️ since 10:15 AM (1 h): BigQuery refused the AMIE read (<reason, 60 characters>). It tries again in an hour` | ≤ 138 |
| 49 healthy | `read 10:15 AM: 84 new · today: 2,310 of 30,000 mentions, 640 used, 22 in stories (6 started) · usually 15 min after posting · New sources tab` | 141 |
| 49 key refused | `⚠️ since Nov 16 10:15 AM (3 h): Brandwatch refuses the shared key. The service that renews it may be down. It tries again every hour` | 132 |
| 49 login busy | `⏸ until 10:25 AM: Brandwatch's shared login has used 452 of its 600 calls in 10 minutes (other tools share it). It reads on from where it stopped` | 145 |
| 49 HTTP 429 | `⏸ until 10:25 AM: Brandwatch said too many calls on the shared login (other tools share it). It reads on from where it stopped` | 126 |
| 49 day's ceiling | `⏸ today's 30,000 Brandwatch mentions are used; it reads again after midnight ET. A pause of more than 2 hours skips what came in meanwhile` | 138 |
| 49 X arrived | `⚠️ stopped: Brandwatch sent 3 X posts although the bot asked for none. Nothing more is read until this row is turned OFF and ON again` | 133 |
| 49 filter ignored | `⚠️ stopped: Brandwatch ignored "added since" (it sent older mentions). Nothing more is read until this row is turned OFF and ON again` | 133 |
| 49 gap | `⚠️ 3 h 10 min were not read after a pause (after 2 hours it starts from the last 2 hours) · read 10:15 AM: 84 new · today: 2,310 of 30,000` | 138 |
| 49 nothing for hours | `⚠️ no Brandwatch mentions for 4 h (usually about 120 an hour). Check the queries ticked Read = ON on the New sources tab` | 120 |
| 49 no words | `⚠️ most Reddit mentions came without their words today, so they can't be used · read 10:15 AM: 84 new · today: 2,310 of 30,000` | 126 |
| 49 other refusal | `⚠️ since 10:15 AM (1 h): Brandwatch refused the read (HTTP 403: <reason, addresses removed>). It tries again in an hour` | ≤ 142 |
| 48/49 foreign tab | `⚠️ waiting: a tab named "New sources" exists that the bot didn't make; rename it to let the bot make its own` | 108 |

"Pause" words (api-limits P19): no note promises "nothing is lost"; the ceiling note says what a pause past 2 hours
skips. A source with nothing wrong rewrites its note every check, so it never expires (`SWITCH_NOTE_MS_`,
Control.gs:384); a source that stopped writing (row 19 OFF) shows the waiting text from its `on` function. After the
larger change merges, step 2d adds one ending to C19's note while a source fails: ` · ⚠️ a new source is failing (row
49)` (38 characters, operations P7d).

**The log line a read leaves** (one per source per check, `console.log`):
`early wave source ami: 1240 rows 10:00-10:14 UTC (overlap 60 min), 310 kept, 41 same post, 6 late caught, mark 10:13:58Z, 0.2 GB`
`early wave source bwl: 1 call, 300 mentions (0 X, 41 repeats, 37 no words), parcel to 10:14:03Z, login 37/600, 2.1 s`
`bw live read: 300 mentions, 1 call, login 37/600, today 2,310 of 30,000, all features 41,200`

**Settings** (`burson_qa:` in `config/default_config.yaml`, declared in `BursonQAConfig` in `triage_agent/config.py`
(`extra="forbid"`), `Generated.gs` rebuilt with `.venv/bin/python -m scripts.build_apps_script`; model commit
`c8970d1`; none in `SETTINGS_OFF`, `T/golden_flows.js:53-61` stays the seven):

| Setting | Default | Stage | Why |
|---|---|---|---|
| `early_wave_new_embed_per_check` | 100 | 1 | today's lanes keep 300 of 400 |
| `early_wave_new_embed_per_day` | 5000 | 1 | a quarter of 20,000 |
| `early_wave_new_late_minutes` | 180 | 1 | the bar's own window (`EWS_EVAL_MS_`, EWS:151) |
| `early_wave_new_pool_max` / `early_wave_new_pool_minutes` | 300 / 120 | 1 | Sonar keeps 900 places |
| `early_wave_new_carry_max` | 100 | 1 | one cache item |
| `early_wave_new_trial_days` | 7 | 1 | a week to read the lifted stories |
| `early_wave_new_lifted_per_hour` / `_per_day` | 2 / 20 | 1 | a third of the 6 ordinary reviews an hour being built |
| `amie_rows_per_check` | 300 | 1 | about a check's share of 25,000 rows a day |
| `amie_overlap_minutes` | 60 | 1 | three times the recorded 20-minute landing lag |
| `amie_max_gb` | 1 | 1 | a fifth of the 5 GB job ceiling (EWS:118) |
| `amie_stale_hours` | 3 | 1 | the old Watch called it stale after 2 h with no change |
| `amie_staff_feeds_rx` | `kof\|kol\|\binfs?\b\|exec\|googler\|reps\|posts by google` | 1 | detection P2 |
| `bw_live_project_id` | 1998344909 | 2 | the bot's project |
| `bw_live_sources` | the 11 names of Q1 | 2 | social networks and forums |
| `bw_live_queries_max` | 20 | 2 | one call reads them all |
| `bw_live_page_size` / `bw_live_parcel_max` | 300 / 300 | 2 | about 1 MB an answer |
| `bw_live_every_minutes` | 10 | 2 | one read a check |
| `bw_live_first_minutes` | 30 | 2 | no backfill |
| `bw_live_calls_per_10min` | 20 | 2 | 3.3% of 600 |
| `bw_live_pause_at_used` | 450 | 2 | 150 left for others |
| `bw_live_mentions_per_day` | 30000 | 2 | 5% of 600,000 |
| `bw_live_source_type_new` | true | 2 | backfills out; false only if stage 0 shows it drops new mentions |
| `watch_amie_per_day` | 300 | 3 | a first-weeks cap |

**How the producer learns the switches** (the seam): `ewsRows_` gets no switches (BQ:2933-2938) and must be called
without `opts` while row 38 is OFF (T/switch_fast_triage.test.js:606). So BigQuery.gs is not touched: one line right
after `wanted = readControl_(control)` (Main.gs:346), `ewsRunSwitches_(wanted.switches)`, defined in EWS, sets a
run-scope value; anything not set reads as all OFF (fail closed). The Brandwatch reader is called with
`wanted.switches` in the `finally`. Turning a row OFF: `bwLiveOff_()` / `ewsAmieOff_()` (called like
`proactiveWatchOff_`, Main.gs:711) clear marks, parcel, carry and indexes of that source, never the day counts or the
trial date.

**Other lists:** `mcp/slrr_live_ops_server.js:138` gains rows 46, 48, 49, 50 (46 is already missing), and its
description's switch count; the MCP audit's `all_switches_default_off` covers the new rows with no edit
(`mcp/slrr_dev_pipeline_server.js:94-111`).

---

## Q12. Failure and safety

- **The token** is read with `pwBwToken_()` (PW:1201-1214) once per read, kept in a local variable, sent only to
  `api.brandwatch.com`, replaced by `[token]` in any error text (as PW:1315). Never in a property, the cache, the sheet,
  a log line or BigQuery.
- **Only GET** to Brandwatch: `BrandwatchLive.gs` has one fetch helper with no `method` and no `payload`.
- **Email addresses** (operations P12, api-limits P20): every error text from Brandwatch or BigQuery passes
  `nsrcScrub_` before it is stored, logged or noted: the token out, anything shaped like an address replaced by
  `[address]`. Query lists keep four named fields; query groups are never fetched; authors shaped like addresses
  become the link. Test fixtures use `.test` addresses only (`scripts/repo_safety_scan.js`).
- **S-F Burson:** the new posts reach people only through Early Detection cards (never B25 or B26,
  EarlyDetection.gs:17-18, 48-49) and Watch alerts (never S-F Burson, WatchAlerts.gs:194). The guard word lists are not
  changed (that would change today's guards: "Brandwatch" is not in them, map_bw-code 3.5); a test runs a full poll with
  rows 48-50 ON and asserts no outbox row, relay post or B25/B26 post holds a new-lane post's text, a query name,
  "AMIE" or "Brandwatch".
- **Tab ownership:** one new bot tab, `New sources`, made only while row 48 or 49 is ON, A1 title as the mark
  (`nsrcIsTab_`, the Watch sources tab's way, PW:401-404, 409-492), protection that only warns. A foreign tab of that
  name is never read or written; the source waits and says so. `Brand safety groups` is never touched.
- **Cell size:** every cell the tab writes is cut to 500 characters (far under `SHEET_CELL_MAX_CHARS_` = 49,000,
  Sheets.gs:129). Cache items stay under 95,000 characters (`EWS_CACHE_ITEM_CHARS_`, EWS:196); `BWL_STATE`,
  `BWL_DAY` and `EWS_SRC_DAY` under 8,800 (`EWS_PROP_MAX_CHARS_`, EWS:193). New cache items: `ews:bwl:p:0-5`,
  `ews:carry`, `ews:nk:N` (about 4 items), `sn:N` (about 2), `ews:xb` (1), `ews:ak` (AMIE `xkof`, 1): about 15 at most,
  against "about 60" today (EWS:93) and about 1,000 in the shared cache.
- **One source down:** each new job fails alone (Q5, Q6); the Brandwatch reader never throws; a parcel whose job fails
  twice is dropped, the mark moves past it and the note says how many mentions were lost; an empty parcel or a failed
  AMIE job leaves the check exactly today's check. Each source's state is in its own row's column C and on the tab.
- **Live findings** (operations missing 8): what stage 0 and the first live week show (field names, sample mentions,
  query names) go to the ignored `notes/` folder or the hand-over, never into the repository or test fixtures
  (AGENTS.md rule 7). `node scripts/repo_safety_scan.js` prints `clean` before each commit.

---

## Q13. What the owner sees, and proof

**Turning it on, in order** (each needs row 19 ON):
1. The engineer runs stage 0's check and writes its plain answer into the hand-over (not the owner: operations P15).
2. Row 48 ON. Within 15 minutes C48 shows "read ..." with today's counts, or a plain reason; the `New sources` tab
   appears with an AMIE row. After the first day it says how late AMIE's posts arrive.
3. Row 49 ON. Within 5 minutes the tab lists the project's queries, all `Read = OFF`. Tick `Read = ON` for Google's
   queries (the `Suggested` column helps). Within 15 minutes C49 shows "read ...: N new" and "today: N of 30,000".
4. A week later (after the trial): read the tab's list of lifted stories and say if they were worth reviewing.
5. Row 50 ON (with row 34), once stage 3 is built; within 10 minutes the Watch sources tab has an AMIE row.

**Turning it off:** set the row OFF. The next run reads nothing more from that source; posts it already added stay in
their stories until they age out (24 h); its marks, parcel and indexes are forgotten, so ON again starts from the last
30 minutes (Brandwatch) or 60 minutes (AMIE); the day's counts and the trial date stay. Ticked queries stay ticked.

**Where status lives:** column C (one line, warning first) and the `New sources` tab: rows 1-2 title and a one-line
summary ("calls today ..."), then one row a source, then the Brandwatch query list, then the trial's lifted stories.

| Column (a source row) | Example |
|---|---|
| Source | `Brandwatch live (not X)` |
| Status | `✓ live: 84 new at the last read` / `⚠️ ...` / `⏸ ...` |
| Last read (ET) | `10:15 AM` |
| Today: in / used / same post as another source / replaced by another source's copy | `2,310 / 640 / 41 / 12` |
| Usual minutes from posting to seen (median today; buckets 15 min, 1 h, 3 h, 12 h, more) | `22 min` |
| Seen first (posts two sources both had) | `first on 140 posts, a median 95 min before Sonar` |
| No words / X dropped / not embedded today | `37 / 0 / 0` |
| Stories today: with its post / started by it / lifted only by it (sent / noted in trial) | `18 / 6 / 3 (0 / 3)` |
| Brandwatch today: calls / mentions / ceiling / all features | `41 / 2,310 / 30,000 / 41,200` |
| AMIE: newest row / table last changed / bytes a read | `10:13 AM / 10:12 AM / 0.08 GB` |

**Proof that it made alerts faster and stories more frequent** (kept per source per day for 7 days in `EWS_SRC_DAY`,
under 8,800 characters): (1) minutes from posting to seen, median, against the nightly table's 1-6 days and Sonar's
own; (2) seen first: for posts both a new source and Sonar had, which had it first and by how many minutes (from Q8
rule 2 and rule 3 events); (3) stories started by it and stories lifted only by it, and how many of the lifted ones
were sent for review. Compare a week before and a week after each row goes ON, beside C19's daily "found" count and the
Early Detection tab being built. Not in this round (detection M3, M4): the reviews' verdicts by source, and "minutes
sooner" per story; both need the review code being rewritten in BigQuery.gs and EarlyDetection.gs.

---

## Q14. Tests

**The fake.** New helper `T/fake_brandwatch.js` (not `fakes.js`, which other branches edit; not a `switch_*` file, so
`run_tests.js:4670` does not run it on its own), built from the two copies (T/switch_proactive_watch.test.js:118-146,
T/switch_temp_checks.test.js:79-179): Secret Manager answers the token `bw-shared-token-0f1e2d3c4b5a` or an error;
`/metrics` answers `contentSources`; `/queries/summary` answers a list (with `lastModifiedUsername` set to a `.test`
address, to prove it is never kept); `/data/mentions` **applies** `sinceAdded`, `orderBy=added`, `orderDirection`,
`page`, `pageSize`, `pageType`, `queryId` to a list of mentions with `added` times, and can be told to ignore any one
filter, to answer 400, 401, 403, 429 or 500, to set `x-rate-limit: 600/10m` and `x-rate-limit-used` in any letter
case or not at all, or to be slow (advancing the fake clock); every call recorded with host, method, path, parameters
and headers. The BigQuery fakes of T/switch_early_wave_source.test.js:15-39 learn three things: more than two jobs,
`dryRun: true` (a byte figure or an error), and `tables.get` (a schema).

**Cases** (files: `T/switch_ed_new_lanes.test.js` stage 1 rules with a fake lane; `T/switch_ed_amie.test.js`;
`T/switch_bw_live.test.js`; `T/switch_new_sources_control.test.js`; stage 3 in `T/switch_proactive_watch.test.js`):

| # | Case | Stage |
|---|---|---|
| E1 | Rows 48-50 OFF, row 19 ON, six polls: zero Secret Manager, Brandwatch, `tables.get` or dry-run calls; no request names `all_sundar_mentions`; exactly two BigQuery jobs a check (T/switch_early_wave_source.test.js:109); the US and us-central1 bodies equal the `3be2e06` snapshot; no `New sources` tab, no `BWL_*`/`EWS_SRC_DAY` property, no new cache item; C48-C50 the OFF texts (model: T/switch_temp_checks.test.js:294-301) | 1, 2, 3 |
| E2 | The golden records unchanged (`T/switch_golden_flows.test.js` passes with no `GOLDEN_UPDATE_DEFAULTS`) | 1, 2, 3 |
| E3 | Row 48 ON, row 49 OFF: no Brandwatch or Secret Manager call; row 49 ON, 48 OFF: no AMIE read; rows 48/49 ON and row 19 OFF: nothing at all | 1, 2 |
| E4 | A story started by new-lane posts alone in one check (5 accounts, posted in the last hour), after the trial; during the trial it is noted, not signalled; past 2 an hour, noted | 1 |
| E5 | New-lane posts add no `acc` row and fire no velocity signal over 4 simulated days of steady inflow | 1 |
| E6 | A `bwl` post at t, Sonar's copy at t+30 min: Sonar's copy replaces the member, keeps its velocity row (`acc` row count as with the new lane OFF), the story counts one account | 1 |
| E7 | Same post: the eight worked examples of Q8, each | 1, 2 |
| E8 | Pool: 1,000 Sonar posts and 600 new-lane posts unjoined: the pool keeps at most 300 new-lane posts, none older than 2 h | 1 |
| E9 | Embedding: 500 Sonar + 200 new texts → 300 + 100; 50 Sonar + 500 new → 50 + 350; the day bar stops new-lane embedding and the tab says so; 100 unembedded new posts are embedded first next check | 1 |
| E10 | Late split: seen 4 h after posting → `amis`/`bwls`, joins, cannot start, not pooled | 1, 2 |
| E11 | An AMIE row with no `postTime` never becomes a post and is counted | 1 |
| E12 | Staff/KOF feeds and a `KOF = Yes` row stay out; their author's new-lane posts stay out; a Sonar post by that author is untouched | 1 |
| E13 | Five Reddit comments in one thread (five authors) do not promote (one link) | 1 |
| E14 | A new-lane platform `Forum` beside Sonar's `Forums` does not lower the bar to 4 | 1 |
| E15 | AMIE: a schema without `snippet` stops AMIE only, C48 says so, the Sprinklr lane's mark still moves; `postTime` as STRING the same; an optional column missing reads as NULL; "Access Denied" in plain words; dry run over 1 GB stops it for the day; a failed AMIE job pauses it an hour and needs a dry run to resume | 1 |
| E16 | AMIE window and mark: the mark is the newest `ingestionTimestamp` taken, not the clock; a row landing 45 min late is caught by the overlap once, not twice; no new rows for 3 h gives the stale note | 1 |
| E17 | Brandwatch paging and overlap: three reads with overlapping answers give each mention once; 1,250 mentions in the 5 minutes before the mark move forward within two reads | 2 |
| E18 | The marks: `taken` moves only when the `bwl` job is collected; a parcel cache item deleted between read and check is read again from Brandwatch; a pending `bwl` job blocks the next read; a job failing twice drops the parcel with a note | 2 |
| E19 | Filters ignored: `sinceAdded` ignored (older `added` back) stops the source; `orderDirection` ignored (descending pages) stops it; `pageType` ignored so X comes back: one X mention stops it, the marks move past it | 2 |
| E20 | 401 (three in a row: hourly), 403 with a `.test` address in its body (no address in C49, `SWITCH_NOTES` or the log), 429 (10 min), 500, a thrown fetch, a 10-second answer: each note's words; marks unmoved; Sonar's posts of the next check still embedded | 2 |
| E21 | Header `X-Rate-Limit-Used: 460` with `x-rate-limit: 600/10m`, and the same in lower case, and with a bare `600`: paused; no header: "unknown" on the tab | 2 |
| E22 | Ceilings: 20 calls in 10 minutes; the pacing rule; 30,000 a day; reach the ceiling, turn row 49 OFF and ON: still no read until the next ET day | 2 |
| E23 | The token in no SQL, property, cache item, cell or log (as T/switch_proactive_watch.test.js:709-711); every Brandwatch call a GET; no `lastModifiedUsername` value anywhere | 2 |
| E24 | `ewsLaneQuery_` stays pure (called with no services); the `bwl` request's `@bwl` carries the mentions and the SQL text never does | 2 |
| E25 | Warning first: every combination of one warning with the longest healthy counts keeps the warning whole after the 200-character cut | 1, 2 |
| E26 | A full poll with rows 48-50 ON: no outbox row, relay post or B25/B26 post holds a new-lane post's text, a query name, "AMIE" or "Brandwatch" | 1, 2, 3 |
| E27 | Control: rows 48-50 OFF on a new tab and on a tab from before them; every OFF text starts `OFF (`; every label has its help line; help at row 52 | 1, 2, 3 |
| E28 | Approved tables: the changed tests of Q6 pass; a `.gs` naming a table outside the list still fails | 1, 3 |
| E29 | Watch: the restored `ace865c^` tests under key `amie`; the X status-id key gives one Gemini row for AMIE's and `bwq`'s copies; the 300-a-day cap; a story member claimed by an Early Detection card gets no Watch card; row 50 OFF gives byte-identical Watch SQL | 3 |

Run one filter at a time, for example `node apps-script-chat-bot/test/run_tests.js "new lanes"`. The full suite and
`node scripts/repo_safety_scan.js` (must print `clean`) before each commit.

**The live check** `verifyNewSourcesLive()` in `apps-script-chat-bot/LiveVerify.gs` (read-only, run by hand by the
engineer, the model is `verifyEarlyWaveBqLive`, LiveVerify.gs:208; also from `live_verify_runner.js`): see stage 0.

---

## Q15. Build order

Each stage is switchable and useful alone. Stage 0 and step 1b can start now (they touch no file the larger change
edits, and stage 0 touches only LiveVerify.gs). Every step that edits `Main.gs` waits for the larger change to merge
(several build branches add a line at Main.gs:328). Stage 3 waits for that merge (it edits PW, WatchAlerts.gs and
EarlyDetection.gs). Stages 1 and 2 never edit EarlyDetection.gs, Bot.gs or BigQuery.gs; step 2d adds one call to
BigQuery.gs after the merge and is optional.

### Stage 0: the live check (no switch)
*Alone it gives:* a plain answer, before anything is built, to whether Brandwatch honours the filters, how late each
source really is, and whether the bot can read both sources.
- **0a** `verifyNewSourcesLive()` in `LiveVerify.gs`: one Brandwatch call with `pageSize=5` and every parameter of Q2
  (two queries); reports whether `sinceAdded` and `orderDirection=asc` were honoured, whether X came back, the header
  names and forms, which fields came (`contentSource`, `guid`, `resourceId`, follower fields), whether Reddit mentions
  have words; one call of 24 hours of `added` (`pageSize=500`) for the chosen queries giving the median and 90th
  percentile of `added − date` by source (detection M1); `/metrics` content sources; the AMIE table's schema,
  partitioning, `lastModifiedTime`, newest `ingestionTimestamp`, median `ingestionTimestamp − postTime` over a day, X
  share, and a dry run's bytes; both new jobs' SQL as dry runs with three sample `@bwl` rows. Results go to the
  hand-over or `notes/`, never the repository. Tests: one with the fakes, that it makes only GETs and dry runs.
- **Gate to stage 2:** if Brandwatch's median delay from posting to `added` is over 2 hours for a source, that source
  is taken out of `bw_live_sources` (detection P13): it would add volume, not speed, and belongs to the Watch later.

### Stage 1: the AMIE table in Early Detection (row 48)
*Alone it gives:* Early Detection reads X posts with their words and other networks' posts from Brandwatch's alert
feeds, with no Brandwatch call, and the New sources tab says each day how many it used and how late they came.

| Step | Work | Files | Must not change |
|---|---|---|---|
| 1a | Row 48, help moved once to row 52, `ewsRunSwitches_` seam, OFF clearing call, test churn of the ten files that pin rows and the help (map_control-tests 1.6, incl. `switch_head_start.test.js:1619-1620`), live-ops switch rows | `Control.gs` (after :568, :124, :144-146, :297-298, header :50-53), `Main.gs` (one line after :346, one OFF call next to :711), the ten test files, `mcp/slrr_live_ops_server.js:138`, `apps-script-chat-bot/README.md` (switch table :530-557, :561-564, :775-782), new `T/switch_new_sources_control.test.js` | rows 11-47 and their texts; the recorded `control_tab_*.json` fixtures |
| 1b | New-lane rules with a fake lane: `EWS_SLOW_LANES_`, `EWS_NEW_LANES_`, `nl`, `ewsLanes_`, slow list argument of the gate SQL, velocity and covered-hours exclusion, pool share, embedding split and day bar, carry, split signatures, `ewsStitch_` and the post-key index, `ewsNewAuthor_`, promotion limits and trial, `EWS_SRC_DAY`; the settings | `EarlyWaveSource.gs`, `config/default_config.yaml`, `triage_agent/config.py`, `Generated.gs` (rebuilt), new `T/switch_ed_new_lanes.test.js` | the US and us-central1 request text; every existing EWS test |
| 1c | The AMIE job: SQL, `amark`/`xkof` rows, mark, metadata check, dry run, stale and pause rules, `xbig` part of the us-central1 job (only while a new row is ON), alert-memory leave-out; the approved-table change and the documents | `EarlyWaveSource.gs`, `T/switch_alert_memory.test.js`, `T/switch_early_wave_source.test.js`, `T/switch_i_early_wave.test.js`, `docs/discovery.md`, `apps-script-chat-bot/README.md`, new `T/switch_ed_amie.test.js` | `tests/test_review_fixes.py`, `T/switch_fast_triage.test.js:306`, the Watch tests |
| 1d | The `New sources` tab (source rows, trial list), C48 notes, log line | new `NewSources.gs`, `EarlyWaveSource.gs` (the note call at the end of a check), tests in `T/switch_ed_amie.test.js` and `T/switch_new_sources_control.test.js` | any other tab |

### Stage 2: Brandwatch live in Early Detection (row 49)
*Alone it gives:* Early Detection sees Brandwatch's non-X posts from the ticked queries minutes after Brandwatch adds
them, able to start stories, and C49 shows the day's mentions against the 30,000 ceiling.

| Step | Work | Files | Must not change |
|---|---|---|---|
| 2a | The reader: query list on the tab, `/metrics`, request URL, page checks, stall rule, X stop, marks, parcel, ledger, header pause, 429/401/4xx, pacing, `BWL_DAY`, address and token scrubbing; the shared fake | new `BrandwatchLive.gs`, `NewSources.gs` (query rows), new `T/fake_brandwatch.js`, new `T/switch_bw_live.test.js` | PW's reader functions (called only) |
| 2b | Wiring: row 49, its notes, `bwLiveRun_` after the Watch in the `finally`, the `bwl` job from the parcel, `taken` at collection, two-failure drop, `@skip_nets` for AMIE, the settings | `EarlyWaveSource.gs`, `Control.gs`, `Main.gs` (one call after :713, one OFF call), config trio, `T/switch_bw_live.test.js`, `T/switch_new_sources_control.test.js`, README | the Watch's block and its timing |
| 2c | One count of every Brandwatch mention the bot reads (after the merge): `bwCountMentions_` called from the Watch's reader and Temp checks | `BrandwatchLive.gs`, `ProactiveWatch.gs` (one line in `pwBwMentions_`), `TempCheck.gs` (one line in `tcBwBody_`'s caller of `/data/mentions`), tests | what those readers read |
| 2d | Optional, after `build/ed-2` merges: C19's note ends ` · ⚠️ a new source is failing (row N)` while one fails | `BigQuery.gs` (one call), test | C19's other words |

### Stage 3: the AMIE table back in the Watch (row 50), after the larger change merges
*Alone it gives:* the Watch checks Brandwatch's brand-safety and product alert feeds again, X with its words and KOF
names, about a day sooner than the nightly table, at most 300 more Gemini looks a day.

| Step | Work | Files | Must not change |
|---|---|---|---|
| 3a | Every member of a carded Early Detection story is claimed in the alert memory (precondition) | `EarlyDetection.gs`, its tests | the card's text |
| 3b | Source `amie` from `ace865c^` with the overlap and key set, X status-id key in its part, day cap, 7-day seen check for `amie`/`bwm` rows in Watch alerts, row 50, help line, the PW header (PW:35-38), the Watch tests changed on purpose | `ProactiveWatch.gs`, `WatchAlerts.gs`, `Control.gs`, `T/switch_proactive_watch.test.js`, `T/switch_new_sources_control.test.js`, README | the other Watch sources' SQL with row 50 OFF |

### What only the live deployment can prove (a list for the owner and whoever deploys)
1. The service that renews the shared Brandwatch key (`slrr-campaigns`) is running, and the bot's account can read the
   key (stage 0 says; C49 says "refuses the shared key" if not).
2. Brandwatch honours "added since", oldest-first order, the list of sources, `language=en`, "leave reposts out" and
   "new mentions only" in one request (stage 0).
3. The real form of the shared login's call-count header, and how many calls other tools use in 10 minutes.
4. How long after posting Brandwatch adds a mention, by source; whether Reddit mentions come with their words.
5. The AMIE table still exists with the columns the plan reads, the bot may read it, how late its rows come, how much
   of it is X, how many bytes a read scans.
6. That BigQuery takes the Brandwatch job with 300 rows as a parameter (the log line).
7. The account's Apps Script limits: fetches a day and run time a day (read on the account's quota page before stage 1).
8. What the 600,000 a day counts, on which clock, and who shares it (only the owner and Brandwatch can say).
9. That nothing new appears in S-F Burson: watch B25 for a day after each stage.
10. After a week of each stage: whether the stories the new sources lifted were worth a review (the tab's trial list).

---

## What this plan gives up

- **Velocity from the new sources**: they help stories form and grow, but a jump in their posts raises no velocity
  signal in this round.
- **Many AMIE posts only join**: most are recorded as arriving about a day late; AMIE adds words and volume more than
  speed.
- **A ceiling on Brandwatch volume per check** (300 mentions every 15 minutes, about 1,200 an hour): a busier stream falls
  behind and, past 2 hours, the oldest part is skipped and said so.
- **Stories lifted only by new sources wait a week**, then at most 2 an hour and 20 a day go for review.
- **Merged copies**: when two new sources carry one post the first copy is kept; only a copy from today's lanes replaces
  a new-lane copy.
- **Display-name people**: a Facebook page or site named differently by two sources is still two accounts; aliases are
  not learned in this round.
- **Today's lanes are not improved**: their authors, the late-post velocity defect (EWS:1286-1319), the `acc` item near
  its size limit (EWS:1904), the subreddit-as-author defect (Escalate.gs:544-551) and Early Detection's leave-out by
  `normalizeUrl_` stay as they are; each is its own small fix that changes today's behaviour.
- **Direct BigQuery cards and the review's lookups** get nothing new; the Watch's own Brandwatch reader is not moved to
  the new one; news, blogs, reviews and LinkedIn from Brandwatch are not read.
- **One Brandwatch project** in this round.
