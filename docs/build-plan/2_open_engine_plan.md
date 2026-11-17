# Plan: opening up the engine (equal sources, sooner, judgment in place of caps, only real walls)

> **For whoever builds from this file in the repository.** It was written against an older commit: line numbers
> have moved, so find each place by its function or constant name. Paths that start with `scratchpad/` point at
> design notes that are not in the repository; this folder holds everything needed. Read `README.md` and
> `STEP_NOTES.md` in this folder first: where they differ from this file, they win.

Final plan, 17 November 2026, for the owner's direction of today (`scratchpad/open/owner_direction.md`). Written from
two designs (`design_judgment-first.md` = **JF**, `design_capacity-first.md` = **CF**), three reviews
(`attack_flood.md` = **FL**, `attack_wrongness.md` = **WR**, `attack_walls.md` = **WL**) and three maps
(`map_walls.md`, `map_turned-away.md`, `map_judgment.md`), all in `scratchpad/open/`. Also read: `scratchpad/spec_v2.md`
(**V2**, the merged fix plan), `scratchpad/review3/decisions.md` (**G1-G4**), `docs/build-plan/1_new_sources_plan.md` (**SPEC**,
the new-sources plan), and the G3 fix branch `build/mfb-g3` (commit `2f02234` is G3.1, `6933d88` is G3.2) with
read-only `git log` / `git show`.

**Code.** Read at **b2ee90f** in my own unpacked copy (`scratchpad/open/fin_b2`), and at **50aa822** (build/src-base)
with `git show`. Every `File.gs:N` is `apps-script-chat-bot/File.gs` at b2ee90f unless marked `@50aa822`. Short
names: EWS = EarlyWaveSource.gs, BQ = BigQuery.gs, ED = EarlyDetection.gs, EDN = EarlyDetectionNotes.gs, EDT =
EarlyDetectionTab.gs, FT = FastTriage.gs, DEC = Decisions.gs, AG = ApiGuard.gs, AC = AutoCorrect.gs, PW =
ProactiveWatch.gs, WA = WatchAlerts.gs, OA = OtherAlerts.gs, GEM = Gemini.gs, VEC = Vectors.gs, TN = ThreadNotes.gs,
CFG = `config/default_config.yaml`.

**Lines I re-opened myself** for the disputes: EWS 105-200, 380-425, 430-540, 545-580, 715-770, 1077-1120, 1176-1250,
1286-1400, 1650-1830, 1880-1979; AC 25-45, 110-235; AG 100-130; Bot.gs 1785-1880; ED 1160-1185; WA 1349-1380, 70-71,
121, 2066; TN 45-59; Main.gs 280-310, 778-790; the constant blocks of BQ (80, 1614, 3312-3351), AG (19-35), DEC
(60-87), FT (36-48, 70-76); EDT 20-40; GEM 52, 116-122, 276-284, 406, 449; VEC 24, 30, 169; docs/discovery.md 68-72,
115-119; README.md 681-684. The rest is cited from the maps and reviews, whose authors read it at b2ee90f.

**What I ran:** a length check of every owner-facing text in this plan (`scratchpad/open/len_open.js`). No test, no
suite. Timings and velocity simulations below are the reviewers' and designers' **[RAN]** results (Node, the bot loaded
by `test/fakes.js`), quoted with their source. **NOT VERIFIED** marks what nobody here could check: there is no
access to the sheet, BigQuery, the logs, Brandwatch, Vertex AI or Google's quota pages.

**A correction carried from both designs:** `map_walls.md` gives EarlyWaveSource.gs line numbers from 50aa822 (35 lines
lower) although it says b2ee90f. Example: `EWS_EVERY_MS_` is EWS:111 at b2ee90f, not 146. This plan uses b2ee90f's.

---

## A. Decisions of the plan's owner (17 Nov 2026). They override anything below that differs.

The bot's owner must not be handed work or questions that the bot or the code can answer. Four changes follow from
that, and three clarifications.

**A1. No person labels pairs. Gemini is the judge of "same story", and no source waits for it.** (Replaces the
labelling by a person in O1 "How it is measured", S1, S9's "a lane only after its S1 labels", section 7 point 6,
section 8's sentence about three hours, and question 1.)
- `verifySameStoryLive()` stays a hand-run, read-only function (one click in the Apps Script editor, like
  `verifyNewSourcesLive`). It samples and embeds as written, then asks Gemini for every pair "do these two posts tell
  the same story: yes / no / can't tell" with the quick-look service's client (structured answer, the two snippets
  only, links and handles removed), about 660 short calls, sent side by side in batches.
- **The judge is checked first on what is already known.** The 300 Sonar reference posts give pairs in the same bands;
  the bars were set by people reading such pairs (EWS:59-76: [0.80, 0.82) same story; different stories at most 0.800).
  If Gemini's labels on the Sonar reference do not match that reading (fewer than 80% "yes" in [0.80, 0.82), or more
  than 20% "yes" under 0.78), the report says the judge is not reliable here, writes no bars, and the tab's blank
  column `Your call` is the fallback for a person. Otherwise Gemini's labels stand.
- The function writes the bot-made tab `Same-story check` (pairs, similarity, lanes, `Gemini says`, a blank
  `Your call` column that wins where a person fills it in, and at the top one line a lane: "Tubular: keeps today's
  bars" or "Tubular: start 0.83, join 0.85"). It stores the measured bars in a script property `OPEN_LANE_BARS`
  (JSON, under 500 characters, with the date). Under row 51 the engine reads that property when the setting
  `open_lane_bars` is empty; the setting, when filled, wins. C51's Engine line names lanes that run on measured bars.
  Running the function again recomputes with any `Your call` entries.
- **Every lane has equal standing as soon as S9 is on.** Until a lane is measured it uses today's bars, the review
  gets the one line "Most of these posts come from <source>, where the same-story grouping has not been checked yet…"
  and the tab's Sources column shows it, exactly as the plan's "Until a lane is measured" paragraph says. S9 depends
  on S7 and S8 only.

**A2. "Measure first" is a hand-run function plus the ledger, not a task for a person, and nothing waits for it.**
(Replaces S0 as "no code".)
- New hand-run, read-only `measureEngineLive()` in LiveVerify.gs, built with S1: this project's triggers; the
  properties store's use (`getProperties()` summed, per key family, no values printed); `tables.get` for each table
  the engine reads (partitioning, last change); dry-run bytes of each job; each lane's lag from posting to arrival
  over the last 24 hours (one small read-only query a lane, only with columns `tables.get` shows); Sonar's share of
  blank usernames and its batching on one `received_at`; the Sprinklr inbound table's rows of the last 7 days by
  network and by "is_brand_post"; the last 7 days of C19 / C35 counts as the tabs hold them. It prints a report and
  writes nothing but its own bot-made tab. No email address, token or post text in the report.
- The run-time ledger records from the moment it is deployed, with row 51 OFF too, so the day's run time shows on C51
  after one day without anyone measuring.
- Defaults are chosen to be safe without S0: `open_runtime_other_hours` 1.5, `open_velocity_lag_minutes` 60,
  `open_queue_max` 24. What S0 would have gated is instead adjusted by the engine or reported: the ledger's steps act
  on the measured run time; C51 says when a property write failed for lack of room.
- What only the account's owner can see (the account type, other scripts on the account, the bill) stays in section 7
  as "only a live deployment can prove", told to the owner once in plain words, optional.

**A3. No questions to the owner remain.**
- Question 2 (who else uses the 600,000 Brandwatch mentions): not asked. The owner said the bot falls well below it;
  the bot reads at most about 86,000 a day by construction and shows the day's count against 600,000 on the New
  sources tab.
- Question 3 (Direct BigQuery's 500 engagements): not asked. It stays, as a split of work and not a limit on what is
  alerted: a post with 100 to 499 engagements is judged by the Watch, a smaller one by Early Detection (stories, and
  the single-post path for serious risk words). The table of limits says so.
- "The inbound Sprinklr table" is settled from the code (owner_direction.md, last section): it is
  `reporting_data.sprinklr_inbound_comments`, read today by all three paths; Early Detection reads every appended
  row that has a comment id, is not deleted, spam, hidden, Google's own or positive, and is English (EWS ewsUsSql_),
  with no join that would drop rows. Nothing to change beyond equal standing; `measureEngineLive()` reports its rows.

**A4. The new sources' caution rules (trial week, lifted-story caps, shares) with row 51 OFF.** As the plan says they
are removed under row 51. With row 51 OFF they remain only as the fallback of rows 48-50, with one change now: the
trial defaults to 0 days (`early_wave_new_trial_days: 0`), because the owner rejected a trial outright. The Brandwatch
reader's day ceiling and pacing are not built at all (stage 2 of the new-sources plan is built to Q2/Q3 as amended in
O8: a parcel of 300 a read, no day ceiling, no pacing; with row 51 OFF it reads at Early Detection's 15-minute check).

**A5. Order and base.** The open engine is built on the merged fix plan (with G1-G5) joined with the new sources
(steps 0a, 1a-1d, 2a-2c, 3a-3b). Chains, by the files they own, so that no two chains edit one function:
- guards and views: S2 -> S3 -> S4 -> S18 (Control.gs, Main.gs, OpenEngine.gs, ApiGuard.gs, AutoCorrect.gs, Gemini.gs
  guards, EngineTab.gs, Bot.gs's B10 loop);
- the producer: S7 -> S8 -> S9 -> S10 (EarlyWaveSource.gs, Vectors.gs);
- reviews: S5 -> S6 -> S11 -> S12 -> S15 -> S16 -> S17 (BigQuery.gs's check, EarlyDetection.gs, FastTriage.gs,
  Decisions.gs; their few lines in EarlyWaveSource.gs are named in each step and merged after the producer chain);
- the Watch and Direct: S13, S14 (after S4);
- the live checks: S1 with `measureEngineLive()` (LiveVerify.gs), any time.
S2 comes first and alone: every other step reads row 51 and the ledger through it.

**A6. Row 51 is one switch, written OFF, and the owner is told plainly to turn it ON** together with rows 48, 49 and
50 when the build is deployed: the repository's rule is that code never turns a new switch ON. With all four OFF the
bot is exactly the bot of the merged fix plan.

**A8. "Requirements first, then clustering" is part of this plan.** The bot's owner proposed it on 17 Nov, after
this plan was written (owner_direction.md, last part): every post from every source is first checked against the alert
requirements; a post that meets one alone goes straight to review and alert; everything else is grouped whatever its
size. Its design is `docs/build-plan/3_requirements_first_plan.md`: section B (the amendment, steps S19a to S19g, the changes to
S1, S2, S3, S8, S11 and S18, and S15 dropped) as changed by its own section C (the plan owner's decisions: no
counting-only week, the account type read by the bot, a first screen of many posts a call as step S19h, the order).
Where that file and this one differ, that file wins; within it, section C wins over section B.

**A7. Words for the owner.** Section 8's paragraph loses its sentence about three hours of marking and gains: "The bot
checks its own grouping on each new source by asking Gemini about a few hundred pairs of posts, once, when you run one
function."

---

## 0. The plan in one screen

**One new Control row, 51 "Open engine: judgment in place of caps", written OFF and never set ON by code.** Every
behaviour below runs only while row 51 is ON (and row 19 is ON), except the run-time ledger of step S2, which only
records. With row 51 OFF the bot is today's bot, including G3.1-G3.7 when they merge.

What row 51 ON does, in one line each:

1. **Every source has the same standing.** Freshness (first read by the bot within 180 minutes of posting) decides what
   may start a story, never the source's name. One post counts once (link key plus who wrote it), one person once.
   The similarity bars are measured on each new source's real posts by a person before that source is opened.
2. **Sooner.** Checks every 5 minutes. Gemini's quick look is asked about a story at 2 accounts. A single worrying post
   is acted on alone: through the Watch when it has reach, through a new single-post story when it is small and
   carries a serious risk word.
3. **Judgment in place of caps.** Every candidate gets the quick look; reviews go most serious first; what does not fit
   waits for the next check and is not dropped while it is fresh; everything still turned away has a row with its
   reason.
4. **Capacity.** Story reviews are sent side by side; quick looks too; work a check cannot finish is carried; storage
   that silently fails at volume is split.
5. **Only real walls, plus guards that make work wait.** The 6-minute run, the one-minute trigger and one run at a
   time, the account's daily trigger run time, the shared Brandwatch login, storage sizes, Gemini's rate limits and
   Burson's alert requirements stay. A **run-time ledger** slows background work in steps (never Burson's alerts) as the
   day's run time fills; **yield to Burson** ends background work in a run as soon as a Burson alert waits; **one
   safety stop**: 2,000 background reviews a day.

**What the owner reads:** C51 (one line, warning first), the new bot-made **Engine** tab (one row a check), the Early
Detection tab (one row per story ending, new endings added), C19/C35/C38 as today.

**Order:** S0 measure first (no code). Then the ledger and stop (S2) before anything opens; velocity is made correct
(S8) before any source gets equal standing (S9); a source is opened only after its same-story pairs are labelled (S1).

---

## 1. Where the designs and reviews disagreed, and what I decided

Every "must fix" of the three reviews is answered here (fixed, or refuted with evidence). "Should fix" items are
answered in the sections; the ones I did not take say why.

| # | Must fix (review) | Decision and evidence |
|---|---|---|
| FL-F1 | JF growth rule floods threads (a note every 3 accounts, no cap) | **Fixed.** Growth notes go at geometric steps (1.5x and 3 more), the full review stays at today's bar (2x and 3 more, or a new platform), and notes stop once the story's newest post is older than 180 minutes (O3 row 12; step S16). A story going 5 to 200 accounts gets about 8 notes and 5 reviews, not 65. |
| FL-F2 / WL-3 | JF has no run-time guard over reviews; the daily quota can run out before the stop | **Fixed.** A rolling 24-hour run-time ledger with graded shedding (O4 "run-time ledger"; step S2). The stop is no longer asked to protect the quota. |
| FL-F3 / WL-3 | JF's stop of 400 is not far above a busy day and stops Watch and Direct on the event day | **Fixed.** The stop is 2,000 background reviews a day, with derived ceilings for quick looks, Watch checks and BigQuery bytes (O3 "the one safety stop"). Re-set after S3's first week to 5x the busiest measured day, never below 1,000. |
| FL-F4 / FL-F6 | Busy-day readability is a hope (JF); CF's "8-12 top-level cards" contradicts its own counts | **Fixed by restating O6 with all three paths** (Story, Watch, Direct) and making the readability steps the default under row 51: the hourly card for quiet stories ON, related stories threaded on the review's own judgment, spikes inside carded stories as thread notes. FL-F4(c) (Watch/Direct cards as replies in a story's thread) is **refuted**: the flow triages only top-level messages (`!m.threadReply`, Bot.gs:1806, 1842), so a card posted as a reply would never be reviewed. They stay top level with V2's "Part of a story" note. |
| FL-F5 / WR-M6 | CF's single Watch flag goes out alone with no pre-read | **Fixed.** Alone only when the pre-read said `meaningful === true` **and** named a P0/P1 tag or a Sensitive Topic (JF's rule). `pwSolo_` tests `p && p.meaningful === false` (WA:1358), so "not judged not meaningful" includes "never read": that is the defect, confirmed. A flag with no pre-read follows today's rules. A run where flags waited 10+ minutes reserves time for the pre-read (O2). |
| FL-F8 | JF's update compares the quick look's level with the full review's severity | **Fixed.** Compare like with like: the quick look's level for the card's own signal (kept on the queued row as `dec`) against the new quick look; a rise of one level on two asks in a row sends a full review (O3 row 12). |
| WR-M1 | The 7-day velocity warm-up does not stop false spikes | **Confirmed in the code and fixed.** Once a same-hour slot has 7 days, EWS:1305 updates `e.d[hod] + (n - e.d[hod]) / 7`: a moving mean that holds only 1-(6/7)^7 = 66% of a new level after 7 days. WR [RAN] 8 false spikes a day on days 7-13 at 100 accounts an hour. Fix: a warming lane keeps its **own** same-hour baseline as a true mean (EWS:1305's `days < EWS_BASE_DAYS_` branch with its own day count), counts in neither the shared baseline nor the current count, and at the end of the warm-up its baseline is added to the shared one. WR [RAN] 0 false spikes over 22 days at 100 and 300 an hour; a real burst on day 10 still fires (O1 velocity; S8). |
| WR-M2 | JF filters the warming lane in the wrong function | **Confirmed and fixed** by the same rule: `ewsHourCount_` (EWS:1322) feeds `rolling`, part of the baseline (EWS:1366-1368); the current count is the `cur` map (EWS:1347-1358). The filter goes on `cur`. |
| WR-M3 | Equal standing turns velocity on before the velocity step exists | **Fixed by order and by a field.** `slow` keeps its velocity meaning; a new `late` field carries freshness. Velocity correctness (S8) comes before equal standing (S9), and S9 refuses to give a lane velocity rows until S8's setting is on. Test: row 51 ON with S8 off gives no `acc` row to any lane that has none today. |
| WR-M4 | Counting a post once by its link merges all comments under one Google post | **Confirmed and fixed.** Sprinklr comments carry the Google post's link: `post_url AS url`, own id only in `mid` (EWS:435). Identity = link key **plus who** (author, else content hash), as `ewsSameWho_` does @50aa822:2170-2181; for `spk` the comment id (`mid`) is the identity. Test: 40 commenters under one post = 40 accounts, 40 velocity rows. |
| WR-M5 | "First copy wins" plus the warm-up takes Sonar's own rows out of velocity | **Fixed.** A velocity row records every lane that saw the post; a later copy (found by key + who) adds its lane; the row counts in the current count when any of its lanes is past its warm-up. |
| WR-M7 | Reviews side by side can put two cards on one story | **Fixed.** Never two signals in one batch that share a cluster id or 2+ post keys; after the batch, the same-story check (`edStoryVerdict_` with a fresh `edLedger_`, ED:1121, 1259) and the alert-memory claim run again right before each card is posted (S12). Test: a promotion and a velocity spike on one story in one batch give one card and one thread update. |
| WR-M8 | A single-post card is invisible to "one story, one card" | **Confirmed and fixed.** `need = Math.min(2, keys.size)` uses the pending story's keys only (ED:1172), so a 1-key card can never match a 5-key story. Becomes `Math.min(2, keys.size, L.keys.size)`, and the single post is claimed in the alert memory when carded (S15). |
| WR-M9 | CF's 5-minute step (row 51 OFF) drops burst posts for good | **Fixed by not doing it.** The interval changes only under row 51 and no per-check number is shrunk (JF): 400 embeddings and 15 quick looks a check stay with row 51 OFF. At b2ee90f a post over the embedding room is never grouped and the cursor moves on (EWS:1661-1670, 1942-1954): shrinking 400 to 134 would lose posts. |
| WR-M10 | JF leaves the seen map at 200 entries | **Fixed.** Under row 51 the seen map's story keys spread over up to 8 properties (about 2,300 entries, each property tested at its worst case at 8,800 characters), on top of G3.2's split (`6933d88`); an entry pushed out is counted on the Engine tab. The producer's list of stories told goes from 60 (EWS:1903) to 24 hours in chunked cache items (WR-S11). |
| WL-1 | Watch alerts and Direct cards are reviewed inside Burson's pass; a backlog there turns Early Detection off | **Confirmed and fixed (interim form).** The flow triages its own Watch alerts and Direct cards in the B10 loop (Bot.gs:1806-1877); any time-out with such a card waiting sets `analyst_backlog` (Bot.gs:1798, 1814, 1827, 1833, 1854, 1867); `slaBusy` includes it (AC:124-128); `apiGuardAllowBackground_` returns false when `slaBusy` (AG:117), so the Direct poll (AC:132) and Early Detection's check and reviews (AC:148-149; ED:1903) stop. Under row 51: a card the bot posted itself never sets `analyst_backlog` (a new `bg_backlog` instead); a non-serious bot card waits when the story queue's top entry is serious; Watch and Direct post a new card only while fewer than 3 of their cards wait unreviewed in B10 (S4). The full fix ("review before posting", one queue for all three paths) is **not in this round** (section 6): it rewrites the paths V2 just built in Bot.gs. |
| WL-2 | Long background runs delay Burson's alerts through the lock | **Fixed.** Yield to Burson: before each background review or batch, one list of S-F Burson since its cursor; a new alert ends background work for this run. A daily gauge of Burson pick-up time (p50, p90) on the Engine tab and C51; when p90 passes 120 s, each run's background time shrinks by 30 s (floor 60 s) until it recovers (S2). |
| WL-4 | CF's run-time guard stops everything until midnight and loses those hours' stories | **Fixed.** Graded steps on a rolling 24-hour ledger; the check (cheap, keeps stories forming inside their 180-minute window, EWS:1181) and serious reviews are the last to stop (O4). |
| WL-5 | CF ships the 5-minute interval outside row 51 and without the guard | **Fixed.** Interval only under row 51; S6 depends on S2. |
| WL-6 | JF's pool of 3,000 and 60-second check rest on random-vector timings | **Confirmed and fixed.** WL [RAN]: 3,000 + 1,000 new takes 4.4 s with random vectors but 16.2-17.0 s with clustered ones; `ewsDiscover_` checks no deadline (EWS:1077-1118). The pool stays 1,200, the check 40 s, and Stage B gets a slice decided **before** it is called from the last check's measured cost per post; the rest is carried (S7). |
| WL-7 | Brandwatch live at 5,000 a read does not fit the parcel route | **Fixed.** A read stays at the parcel's 300 mentions (SPEC Q2: at most 6 cache items); throughput comes from reading at every 5-minute check (about 86,000 a day by construction) instead of a ceiling; the 30,000-a-day ceiling and pacing go. A Cloud Run feed into a table is the way past this and is **not in this round** (section 6). |
| WL-8 | CF's Watch caps x3 and 9-minute job limit can lose windows | **Fixed by not doing it.** A look's caps and the 4-minute job limit stay (PW:73, 82, 138-139) until the Engine tab records job time against posts; only bwm's 1,000-a-day cap goes (bwm already carries the rest, PW:131-135). |
| WL-9 | JF's derived stop of 100,000 grouped texts can end grouping on a Brandwatch-live day | **Fixed.** Embeddings get **no stop**: they are bounded by construction (only posts read, once per text, inside the check's slice) and counted on C51 and the Engine tab. |

Other disagreements decided:

| Question | JF | CF | Decision and why |
|---|---|---|---|
| Raise rule at 2-4 accounts | severity mass + about_google | + brand_risk | **CF.** On the 8 recorded answers brand_risk is >= 0.94 on all 3 risks and <= 0.25 on all 5 noise (map_judgment 1.7): a free guard (FL-F14, WR-N2). |
| `Web` platform | never a second platform | one platform "Web" that counts | **JF.** A single forum copy would lower the bar to 4 and make a P1 (EWS:1231-1236; WR-N1). |
| Reviews side by side | not this round | batches of 6 | **CF with WR-M7, FL-F16, WL-15 fixes.** Serial runs at about 35-50 an hour in the one-space flow (WL-11 arithmetic) and spends ~40 s of daily run time a review against ~17 s in batches (CF O4): the run-time wall, not the hour, is what binds a busy day. Start at 3, grow to 6. |
| Same-story sample | 50 highest pairs per lane, run last (S13) | 15 random a band | **Neither as written (WR-S12).** Random pairs in bands around the bars, post-to-centroid pairs too, run in S1 before a lane opens. |
| "Fresh" clock | source's own seen time | source's own seen time | **The bot's own read time** (WR-S1): Tubular's `seen` is `MIN(first_seen_at_utc)` (EWS:532), Tubular's discovery, not the row's arrival. WL preferred the source's clock so that a bot pause does not make posts late; refuted: a post older than 180 minutes at read time cannot count toward the bar anyway (members count by posting time, `ewsStoryWindow_`, EWS:1180-1181). |
| Event threads | none (one card that grows) | fold at 0.75 + same tag | **Neither.** 0.75 is the calibration's "half topical only" band and two different hacks scored 0.777 (EWS:65-72; WR-S9, FL-F11). A story goes under another card only when the review names that card as the same event (judgment), never by a similarity guess. |
| Seen map / stories told | not sized | 8 properties | **CF**, plus the producer's list (WR-M10, WR-S11). |
| Queue | 40 | 24 | **24**, with a test that the worst case of every Early Detection property stays <= 300 KB (FL-F15, WL-10); the rest waits in the chunked buffer. |
| Carry | cache | cache | **Cursor where rows were never returned; cache with a manifest where rows were returned** (WL-18). Re-reading returned rows would hit the same-author signature dedup, which records a post's signature at first read and drops it the second time (`ewsDedupSigs_`, EWS:765-782). |
| Tubular "must name Google" | dropped | dropped | **Dropped**, checked by S1's sample (Tubular's table is "videos that mention Google", PW:185 per map_turned-away 1.2). |
| ApiGuard ceilings | Gemini 60/240, Decisions 300/1,200, BigQuery unchanged | 120/500, 600/2,400, 150/700 | **CF's** (WL-14: JF's BigQuery 50/180 would silently hold back the open engine at an estimated 130-280 calls an hour). |
| Single small post (`SINGLE_POST`) | owner question | built | **Built, narrowed** to P0/P1 risk-term groups (not the 0.70 tag hint alone, WR-N3), with WR-M8's ledger fix; counted on the Engine tab. The owner already said "if something is there then alert on it". |
| O5 positive posts | not in this round | not in this round | **Not in this round, settled by the owner** (owner_direction.md:45-51). The task's request to design a setting is overridden by the owner's later answer. |

---

## O1. Every source has the same standing

### Decision

**1. Freshness replaces the source's name, for every lane** (today's `sonar`, `spk`, `bw`, `tub`; new `ami`, `bwl`).
- New field `late` in `ewsPostOf_` (EWS:725): `late = readAt - posted > open_fresh_minutes` (180), where `readAt` is
  the check's `until` (the moment the bot first read the row). The source's own `seen` is kept only for the "seen
  first" measure, and only for lanes where it is a BigQuery arrival time (`spk` `_CHANGE_TIMESTAMP`, EWS:438; `bw`
  `load_timestamp`, EWS:450; `ami` `ingestionTimestamp`). Not Tubular's (EWS:532).
- A **fresh** post may start a story (Stage B, EWS:1770), sit in the pool (EWS:1798) and, once S8 is on and its lane has
  warmed, count for velocity (EWS:1741). A **late** post only joins an existing story (Stage A, EWS:1759).
- `slow` keeps exactly today's meaning for velocity until S8 is on (WR-M3). The four SQL name tests become per-table
  facts, not standing:
  - age gate (EWS:387): stays 24 h for `sonar` and `spk`, 72 h for `bw`, `tub`, `ami`, `bwl`. This decides only how far
    back a lane's rows are worth reading as members; it never decides who may start a story. Keeping 24 h for Sonar
    answers WR-S14: Sonar's first-sighting look-back is 24 h (EWS:494-499), so at 72 h a post Sonar receives again
    after a day would come back as a new member.
  - "must name Google" (EWS:405): kept for `bw` (its feed mixes competitors' queries, EWS:218), kept for `bwl` queries
    the bot does not mark `Suggested` (SPEC Q1), dropped for `tub`. `ewsGateCtes_` takes the list of lanes it applies to
    (SPEC Q4 already plans the argument).
  - row cap (EWS:418-419): one cap for every lane (O4: 5,000, the page size, with a cursor carry).
- Embedding order (EWS:1666): fresh before late, then risk terms, then the most shared texts, then the newest.
- Reading Tubular and the nightly table: when `tables.get` says the table changed since the bot's mark (CF), from a
  mark with a 60-minute overlap and the keys of rows taken in the last 24 hours kept as hashes (WR-S13: a batch landing
  later with earlier find times is not skipped). The nightly table is read by `load_timestamp` since the mark, not
  `report_date = yesterday` (EWS:562-563). Bytes of both: **NOT VERIFIED** (S0's dry runs say).

**2. One platform rule for every lane.** `ewsPlatform_` (EWS:330-341) names the platform from the link's domain
first; an unknown domain whose raw name is not a known network is `Web`. `Web` never counts as a second platform for
the four-account discount (EWS:1231), "P1 on two platforms" (EWS:1236) or "a platform it didn't have" (EWS:1215-1216).
This replaces "platforms count only from today's lanes" (@50aa822:1423-1435).

**3. One post counts once; identity is the link key plus who (WR-M4).** `amPostKey_` (AlertMemory.gs:177-209) plus the
author (or, when blank, the content hash), as `ewsSameWho_` (@50aa822:2170-2181) already does for new lanes; for `spk`
the comment id (`mid`) is the identity. Rules (S9), replacing SPEC Q8 rules 1-3:
- The first copy keeps the member's slot, whatever its source.
- A later copy fills what the first lacks: words, audience, engagements, author; **an exact posting time replaces an
  inexact one** (WR-S2): the SQL marks `posted_exact` false for Sonar's date-only fallback (EWS:513-515); when a later
  copy (often Tubular's `published_at_utc`, EWS:532) has an exact time, the member's time is corrected, it leaves the
  180-minute window if old, and its velocity row goes.
- A later copy adds its lane to the member's and the velocity row's lane list (WR-M5).

**4. One person counts once (WR-S3).** One author function for every lane: lowercase; leading `@`, `u/`, `/u/` off; X,
Bluesky, TikTok, Threads handle from the link (EWS:504-508) never `i`, `intent`, `home`, `search`, `web`; never a
subreddit; a value shaped like an email address becomes the link and is never logged. An author that is the link
fallback (EWS:510, 721) is **unknown**; at most one unknown counts toward a story's accounts. This changes today's
account keys for `u/` names (a few velocity keys move once): under row 51 only. How often Sonar's username is blank:
**NOT VERIFIED** (S0 measures).

**5. Exclusion lists for every lane.** AMIE's KOF and staff authors (SPEC Q6), big posts **and big authors** from every
lane's job (`xbig`, WR-S5: a lane's job returns the rows that failed only the size test), DSD-alerted links (EWS:745,
761) as today. The **alert memory marks, it does not drop** (WR-S4): a post a Watch alert or Direct card already
carded stays a story member (so the story still reaches 5 accounts); V2 P4a's cross notes link the story card to that
card. Only DSD-alerted posts are dropped, as today.

**6. No quota by source.** The 50aa822 rules are removed (section O8): trial week, lifted-story caps, embedding and pool
shares, platforms from today's lanes, one-sided exclusions, today's copy always wins.

### What "tuned on two sources" means in the code

The four similarity bars, `EWS_START_SIM_` 0.80, `EWS_JOIN_SIM_` 0.82, `EWS_STORY_SIM_` 0.83 and `EWS_TAG_RAISE_SIM_`
0.70 (EWS:140-142, 179), were set by reading pairs of 1,198 posts (700 Sonar + 498 Sprinklr comments, 11 Nov) and 3,900
(2,500 + 1,400, 10 Nov) (EWS:59-76): unrelated pairs p99.9 0.75; [0.80, 0.82) the same story "bar format look-alikes";
[0.75, 0.78) "half topical only"; the highest pair of different stories 0.800. The 40-character / 7-token floor
(EWS:128-130) was set on the same texts. No Tubular title, nightly Brandwatch row, AMIE row or Brandwatch-live mention
was in the sample.

### How it is measured (step S1), and what is done with the result

- **What the live check samples** (`verifySameStoryLive()`, LiveVerify.gs, run by hand, read-only, like
  `verifyNewSourcesLive`): for the four lanes not yet calibrated (`tub`, `bw`, `ami`, `bwl`), 300 posts of the last 24
  hours that pass today's gates (`ami` by reading the AMIE table; `bwl` by one Brandwatch call of 300 mentions, never
  X), plus 300 Sonar posts as the reference. Embedded with the production call (`embedTexts_`): 1,500 texts, once.
  - Post-to-post pairs: **30 random pairs in each band** [0.78, 0.80), [0.80, 0.82), [0.82, 0.85) within the lane, and
    **15 random pairs a band** between the lane and Sonar. 4 x (90 + 45) = 540 pairs.
  - Post-to-story pairs (joins compare a post with a story's centroid, EWS:1054-1068): a dry grouping run of the 300 +
    300 posts with today's code (`ewsDiscover_`, no state written); 30 joins per lane in [0.80, 0.86). 120 pairs.
  - Short texts: for each lane, the p99.9 of unrelated pairs among texts of 20-39 characters (reported, not labelled).
- **What a person runs**: the check writes the 660 pairs to a bot-made tab `Same-story check` (A1 title as the bot's
  mark, ownership as AGENTS.md 2.5): two snippets of 280 characters with links and handles removed as
  `decSignalInput_` does (DEC:375-388), the similarity, the lanes, and a dropdown `Same story?` (yes / no / can't
  tell). Someone on the SLRR team fills it in: about 660 x 15 s = **about 3 hours**. Nothing is written to the
  repository.
- **What is done with the result** (S1's report, then a setting): for each lane, the share of "yes" per band.
  - The lane keeps today's bars when at least 24 of 30 pairs (80%) are "yes" in [0.80, 0.82) and 27 of 30 (90%) in
    [0.82, 0.85), and joins at 0.82+ are at least 90% "yes".
  - Otherwise the lane gets its own start and join bars from the lowest band that meets those shares, in the setting
    `open_lane_bars` (for example `{"tub": {"start": 0.83, "join": 0.85}}`), read by `ewsDiscover_` (EWS:1086) for
    anchors and `ewsNearestStories_` (EWS:1054) for joins; a pair from two lanes uses the higher of the two bars.
    A bar of its own is not second-class standing: it is the same rule ("only the same story joins") made true for that
    lane's kind of text.
  - Short texts stay out (EWS:128-130) unless a lane's 20-39-character unrelated p99.9 is below 0.78; then that lane's
    floor drops to 20 characters in a later change (not this round, section 6).
- **Order, not a trial:** a lane's equal standing (S9) is turned on only once its pairs are labelled (hours, not a
  week). The owner was told the rule "is measured on real posts from each source, not assumed" (owner_direction.md:17).

**Until a lane is measured** (for example if equal standing is on for `tub` before labelling ends because the owner asks
for it): every lane uses today's bars; the review payload (ED:897-929) gets one line when half or more of a story's
members come from lanes not yet measured: `Most of these posts come from Tubular, where the same-story grouping has not
been checked yet: say in reason if they do not tell one story.` (139 characters); the Early Detection tab gains a
column **Sources** listing the lanes of a story's members, so a person sees which cards a new source shaped.

### Velocity for a new flow without false spikes (step S8)

All under row 51 with setting `open_velocity_fix` (true). With it false, velocity is today's.
1. **Late posts never count** (the late-post defect, EWS:1286-1319): a post whose hour is closed (`floor(t/3600000) <
   floor(now/3600000) - EWS_OPEN_HOURS_`, EWS:173) gets no `acc` row.
2. **Like with like (WR-S7):** a row counts for velocity, in the baseline and in the current count alike, only when the
   bot read it within `open_velocity_lag_minutes` (60) of posting. S0 measures each lane's lag; if Sonar's median lag is
   over 45 minutes the setting is raised to 120 before S8 is turned on (today's velocity would otherwise lose most of
   Sonar).
3. **Warm-up by lane, done right (WR-M1, M2):** each lane family's first-read date in `EWS_STATE` (about 20 characters
   a lane). For `open_velocity_warmup_days` (7) a warming lane's rows build **its own** same-hour baseline (a true mean
   from day 0, in its own property `EWS_ROLL_<lane>`, at most 8,800 characters) and count in neither the shared baseline
   nor the current count (`cur`, EWS:1347). On day 8 its baseline is added to the shared one (`e.d[hod] += lane.d[hod]`
   per key) and its rows count in full. WR [RAN] (`wr_tools/warmup_fix_sim.js`): 0 false spikes over 22 days at 100
   and 300 accounts an hour; a real burst of 60 extra Sonar accounts on day 10 still fires.
4. **Rows know their lanes (WR-M5):** an `acc` row carries the lane family characters of every lane that saw the post;
   it counts in `cur` when any of them has warmed.
5. **Coverage per lane (WR-S8):** an hour is covered for a lane only when that lane's job answered; a lane absent for 6
   hours or more warms again (its own baseline paused while absent).
6. **One topic vocabulary (WR-S6):** each lane's topic (Sonar `brand_classification` EWS:517; `spk` Product/brand/account
   EWS:439; `bw` `product_config_name` EWS:451; `tub` `Unclassified` EWS:532) is mapped to the `GEN` product list before
   it becomes a velocity key; topic baselines move to split properties (`EWS_ROLLUP` today keeps the 40 busiest topics
   and drops the rest, EWS:174, so a dropped topic spikes on an ordinary hour: WR-S6 worked example, ratio 3 from a
   rolling 4).
7. **Storage first:** `acc` gains a field, so it must be chunked first (S7; it fills one 100 KB item at about 2,200 posts
   in 3 hours: CF [RAN] 2,200 rows = 95,479 characters, 2,500 = 108,004, not written, EWS:1273, 1904).

---

## O2. Sooner

### How often the check runs, and what it costs

- **Decision.** Under row 51, `open_check_minutes` (5) sets `EW_EVERY_MS_` (BQ:3312, used BQ:4252) and the producer's
  floor `EWS_EVERY_MS_` (EWS:111) = interval - 60 s (the producer stamps its time after the caller, EWS:1695, so an
  equal floor would skip every other check). `DEC_PAUSE_MS_` (DEC:67, "one early-wave check interval") follows the
  interval. No per-check number is shrunk (WR-M9). With row 51 OFF: 15 minutes as today.
- **The run-time ledger paces it** (O4): checks go to 10 then 15 minutes when the day's run time runs ahead.
- **What 5 minutes costs, by the code's own numbers** (map_walls 2, re-checked):

| Item | At 15 min | At 5 min | Kind |
|---|---|---|---|
| Checks a day | 96 | 288 | choice |
| BigQuery jobs (two a check, EWS:109) | 192 | 576 | choice; counted by ApiGuard (AG:26-27) |
| Bytes (Sonar's job scans 24 h before its window, EWS:496; 0.2-0.9 GB a job, EWS:118) | 38-173 GB | 115-518 GB | price **NOT VERIFIED** (about $0.70-3.20 a day at on-demand rates, map_walls, from training) |
| Producer run time, worst case (40 s, EWS:112, + ~5 s quick looks, DEC:51-52) | 1.2 h | 3.6 h | **the daily run-time wall**; a quiet check's real time is **NOT VERIFIED** (the only figure is a test's made-up 6.1 s) |

- The fixed cost of Sonar's 24-hour look-back (WL-5) is **measured, not cut, this round**: S0 reads whether `sonar_raw`
  is partitioned on `received_at` and the bytes per job; the Engine tab shows GB a day. A seen-links record that would
  make bytes follow the window is a later change if the bill says so.
- "Every 5 minutes" is 5 minutes plus the run in progress (WL-19): the Engine tab records the real gap between checks;
  yield to Burson and the ledger keep runs shorter.

### Asking Gemini about a story at 2 accounts

- **Accounts.** Under row 51 a blank B45 reads as 2 (`FT_BAR_SEEDS_.accounts`, FT:40); a value the owner chose is kept.
  The dropdown already offers 2 (FT:43).
- **Raise rule (CF):** `ewsWatchRaise_` (EWS:1529-1534) under row 51 raises when about_google >= B44 (0.80) **and**
  brand_risk >= B44 **and** the probability of medium severity or higher (`sp[2] + sp[3] + sp[4]`) >= B43 (0.55).
  `independent_reports` (B47) is shown on the tab, no longer a bar: it kept the most serious recorded story (critical,
  0.80 sure, `i` = 0.13) out (map_judgment 1.7). On the 8 recorded answers: 3 of 3 risks raised (dc5a, 56136, e9dd), 0 of
  5 noise. Eight full-size signals are a small sample, and none was at 2 accounts (FL-F14): precision is measured, not
  assumed (O7: share of early cards later dismissed or rated wrong, by account size).
- **Hold-back widened (CF):** a signal is also held when its most probable level is none at >= `open_hold_none_at`
  (0.80), never with a P0 risk group or a raised hint (`ftProtected_`, FT:357-361). On the 8 answers: 5 of 5 noise held
  (3287 none 0.88 and abe6 none 0.86 join the three held today), 0 risks.
- **How many asks:** no count. The caps 5 a check, 60 a day, 20 looked at (`EWS_WATCH_MAX_PER_CHECK_`,
  `EWS_WATCH_MAX_PER_DAY_`, `EWS_WATCH_PICK_MAX_`, EWS:185-187) go; every picked story is asked, risk terms first, then
  most accounts (EWS:1574-1576), sent side by side (O4); each story once a size (marks, EWS:1537-1555: correctness).
  Bound: the run's time and the derived quick-look ceiling. Cost: 90-161 stories a day reach 2 accounts (EWS:80), each
  asked at up to 3 sizes, at ~3,500 input tokens (DEC:46-52): under 1.7 million input tokens a day.
- **Down:** if the quick look fails, nothing is raised early and stories wait for 5 accounts, as today (DEC:38-44).

### A single worrying post acted on without waiting

| Post | Path | What holds it back today | Under row 51 |
|---|---|---|---|
| 1,000+ followers or 100+ engagements (Sonar), Tubular, nightly table, owned posts, pile-ons | the Watch (`AI.IF` / `AI.SCORE`, PW:850-879) | `pwSolo_` (WA:1351-1363): alone only for a KOF, 2,000+ engagements, or (pre-read not "not meaningful") 100+ engagements or a P0 tag; else waits for 3 accounts in 12 h (`PW_BREW_MIN_ACCOUNTS_`, WA:121) | also alone when the pre-read said `meaningful === true` and named a P0 or P1 tag or a Sensitive Topic (Burson's "no threshold" for sensitive topics recently reported, CFG:366, 378, 396). No pre-read: today's rule. In a run where a flag has waited 10+ minutes for its pre-read, the flow's latest stop moves from 260 s to 210 s (`AC_STANDALONE_LATEST_MS_`, AC:37) so the pre-read has its 55 s (WA:98, 102). Auto-correct destination only (`dest.choice === 'autocorrect'`) |
| Under 1,000 followers and 100 engagements | nobody today: Early Detection needs 2 accounts (EWS:1100-1101, 1115); the Watch's floor (PW:71-72) | — | **`SINGLE_POST`** (S15): a fresh post whose text has a P0 or P1 risk-term group (`EWS_RISK_GROUPS_`, EWS:220) is asked to the quick look; raised when about_google >= B44, brand_risk >= B44 and the probability of high or critical >= B43; then queued, reviewed and carded like a story (one card; monitor unless the review escalates). Posts at or over the Watch's floor never go this way (one post, one path) |
| Under the floor with no risk word | no path | — | **not in this round** (section 6) |

### For each alert path: what bounds posting-to-card, and which bound goes

| Path | Bound today | Stays (wall / business) | Goes under row 51 |
|---|---|---|---|
| Early Detection story | source lag (Sprinklr comments ~22 min median, PW:51-52; others **NOT VERIFIED**); 60 s settle (EWS:115); a check every 15 min (BQ:3312); reaching 5 accounts (76-105 min from 3 to 5, EWS:79-82); the allowance and queue (BQ:4593-4605); 2 reviews a run (BQ:3321); ~40 s review (BQ:3322); the run in progress (the lock, Main.gs:287-290) | source lag; settle; review time; the one-minute trigger and the lock | 15 to 5 min; Gemini at 2 accounts; allowance to ranking; reviews side by side |
| Slow sources | Tubular every 6 h (EWS:122), nightly once after 11:00 UTC (EWS:121), and they cannot start a story (EWS:1770) | their own load lag | read on change; fresh posts start stories |
| Single small post | no path | — | `SINGLE_POST`: one check plus one review |
| The Watch | a look every 5 min (PW:65); job collected a run later (PW:54-56); pre-read wait <= 30 min (WA:103); 3-account brew <= 12 h (WA:121); 2 posted a run (WA:70); dropped after 3 h (WA:71) | the look, the job, the pre-read (the judgment); 3 h freshness (with a visible ending) | the brew for meaningful flags; 2 a run becomes "while fewer than 3 wait unreviewed" (O3 row 25) |
| Direct BigQuery | every 5 min (BQ:1597); 2 cards a check "A PLACEHOLDER" (BQ:77-80); later sources unread once 2 found (BQ:2771-2772); 3 waiting (BQ:1614) | poll; review time; 3 waiting (a wall, O3 row 27) | 2 a check; read every source |
| Burson's own alerts | first in every run (AC:124) | unchanged, never counted, never stopped | yield to Burson shortens their wait |

---

## O3. Judgment in place of caps

Every rule map_turned-away calls caution (its section 16) and the others the task names. **keep**, **ranking**,
**judgment**, **remove**, or **wall** (kept because a wall stands behind it). Today's number, then what it becomes under
row 51. With row 51 OFF every number is today's.

| # | Rule (where) | Today | Decision | Becomes |
|---|---|---|---|---|
| 1 | Slow lanes by name (EWS:387, 405, 419, 725, 1666, 1741, 1770, 1798) | `bw`, `tub` never start, pool, velocity | remove | freshness for every lane (O1); velocity after S8 |
| 2 | Embedding: slow last (EWS:1666) | slow last | ranking | fresh, risk, shared, newest |
| 3 | Nightly table once a day after 11:00 UTC, yesterday only (EWS:121, 562-563) | once | remove | read on change by `load_timestamp` (O1) |
| 4 | Tubular every 6 h (EWS:122, 571-572) | 6 h | remove | on change, overlap + key set (O1) |
| 5 | Rows a lane a check (EWS:119-120, 418-419) | 1,500 / 600, rest never read | remove the loss | 5,000 every lane; a lane that returns 5,000 moves its cursor only to its last **complete** timestamp (WR-S13), the rest read next check |
| 6 | Embeddings (EWS:136-137, 1661) | 400 a check, 20,000 a day; the rest never grouped | ranking + carry | time-bounded inside the check (`VEC_MIN_LEFT_MS_`, VEC:30); the rest carried (O4); no daily stop (WL-9); counted |
| 7 | 2-hour window; a longer gap never read (EWS:117, 553) | gap lost | remove the loss | the gap is read over the next checks, 2 h at a time, up to 24 h back (Sonar's look-back); posts read late are late (join only); a gap over 24 h is counted lost on C51 |
| 8 | 5 accounts, 4 on 2 platforms (EWS:152-153) | signal at 5 | **keep** as "signal without asking" | below it, Gemini from 2 accounts (O2). Keeping some bar is correctness for cost: 90-161 stories a day reach 2 (EWS:80); a review each would be 90-161 x 40 s of run time on top |
| 9 | Early watch: 20 looked at, 5 a check, 60 a day (EWS:185-187) | counts | ranking | all, ranked, once a size, side by side |
| 10 | Early watch raise bars (B44, B47 0.30, level >= 2; FT:40, EWS:184, 1529-1534) | four bars | judgment | O2's raise rule |
| 11 | Early-watch signals queued a day (FT:74; BQ:4595) | 8 | remove | ranked with the rest (an early-watch signal is serious, FT:374) |
| 12 | Story cooldown 6 h and growth "2x and 3 more" (EWS:155, 158-159, 1233-1234; ED:1066-1067; `edStoryVerdict_` ED:1259-1280) | a story at 5 is silent until 10 inside 6 h | judgment between the bars | full review at today's bar (WR-S10). Between: at 1.5x the last note's or card's accounts and 3 more, a quick look; when its level is at least one above the level the card's own signal had (`dec` on the queued row) on two asks in a row (FL-F8), a full review; otherwise a thread note `📈 *Growing:* ...` with the count and up to 3 new links. Notes stop when the story's newest post is older than 180 min (FL missing 10). Growth notes are not refused by the 3-a-card / 6-a-run caps (TN:47-48), like G1.3's reply, and are counted |
| 13 | Velocity numbers 3x, 12, 4/8, 3 h cooldown (EWS:165-171) | | **keep** | signals, not limits |
| 14 | Topic count under 3x noted, not reviewed (CFG:108; BQ:4579-4590) | | **keep** | a serious one already passes (BQ:4580) |
| 15 | Check every 15 min (BQ:3312; EWS:111) | 15 | remove | 5, paced by run time |
| 16 | Allowance: 5 a check, 10 an hour, 6 ordinary, 150 a day; outside it 40 a day (BQ:3314-3318, 4593-4597; CFG:106-107) | refusals | ranking | no refusal by count; the one safety stop |
| 17 | Queue 12, 3 h age (BQ:3348-3349) | 12 | ranking | 24; the lowest-ranked stays in the buffer unmarked (G3.1's mechanism, `edAgesOut_` in `2f02234`) and comes back; the 3-hour age stays as freshness, with its ending |
| 18 | 25 rows read a check, ~60-minute window, buffer 30 in one item (BQ:3324, 3384-3390; EWS:178, 1899-1902) | | remove the losses | every unended row in a 180-minute window; buffer 300 rows chunked, with a manifest property so an evicted chunk is counted lost (WL-18) |
| 19 | Quick looks 15 a check, 150 / 300 a day (DEC:68-72) | counts | remove | every candidate and early story, side by side; derived ceiling 10 x the stop |
| 20 | ApiGuard Decisions 30 / 90, Gemini 25 / 90, BigQuery 50 / 180 (AG:24-31) | rolling ceilings | wall-led | background defers for 10 min after a 429 (AG:34-35 notes them); the rolling ceilings stay as a runaway guard at Decisions 600 / 2,400, Gemini 120 / 500, BigQuery 150 / 700 (Decisions' recorded live limit ~1,000,000 input tokens a minute, ~285 calls a minute: FX `error_429_live`) |
| 21 | Watch reach floor 1,000 followers (PW:71) | | **keep** | the split of work with Early Detection; each post costs one `AI.IF` a watch (PW:74); `SINGLE_POST` covers small posts with risk words |
| 22 | Watch look caps 150 / 60 / 60 / 40 / 30 / 40 / 30 / 100; bwm 1,000 a day (PW:73, 138-139, 178-215) | | **wall** for a look; remove the day cap | a look's caps protect the 4-minute job (PW:82, 133-135; ~70 posts took ~2 min, PW:52-53); bwm's day cap goes (it carries, PW:131-135); posts over Sonar's 150 in a look counted on the Watch sources tab |
| 23 | bwm 7 configs vs EWS's 11-word rule (PW:121 vs EWS:219) | two rules | one rule | `EWS_GOOGLE_CONFIG_RX_` for both |
| 24 | Watch: small flag waits for 3 accounts in 12 h (WA:121) | wait | judgment | the pre-read (O2) |
| 25 | Watch: 2 posted a run in the owner's space; 3-h drop (WA:70-71, 2066) | 2 | **wall** | post, highest score first, while fewer than 3 bot cards wait unreviewed in B10 (a card beyond what the next run can review would sit raw and unreviewed in the space; Bot.gs:1806-1836 reviews them one at a time). 3-h drop stays (freshness), counted on C35 (already) |
| 26 | Direct: 500 engagements for Sonar / Tubular "PLACEHOLDER" (BQ:1600-1608) | 500 | **keep** | the SLRR leads were asked to set it (BQ:1600); the Watch already judges posts with 100+ engagements cheaply with `AI.IF`. Owner question 3 |
| 27 | Direct: 2 cards a check, 15 candidates a source, later sources not read once 2 found (BQ:77-80, 1596, 2771-2772) | 2 | remove the count; **wall** for waiting | every source read, 50 candidates a source ranked across sources (KOF, then engagements), cards while fewer than 3 wait unreviewed (`BQ_DIRECT_MAX_WAITING_`, BQ:1614, kept) and 120 s of the flow is left (BQ:1598) |
| 28 | New lanes: trial, lifted caps, embedding / pool shares, platforms from today's lanes, one-sided exclusions (@50aa822) | second class | remove | O1, O8 |
| 29 | AMIE 300 rows a check; Brandwatch 300 a read, 30,000 a day, pacing; Watch AMIE 300 a day (SPEC Q3, Q6, Q10) | caps | remove the counts | AMIE: 5,000 rows a check with the mark moving to the last row read; Brandwatch: a parcel of 300 every check (the route's wall, WL-7), no day ceiling, no pacing; Watch AMIE: the Watch's look caps only |
| 30 | Brandwatch: 20 calls / 10 min of the bot's own reader, pause at 450 used (SPEC Q3) | | **wall** | the shared login's 600 / 10 min (docs/discovery.md:70-71); slrr-campaigns keeps its 300 |
| 31 | Live check's "leave out" a Brandwatch source slower than 120 min (LiveVerify.gs@50aa822:279-280, 642-653) | a gate | remove as a gate | a report line; a slow source's posts are late (join only) |
| 32 | English-words proxy, 40 characters (EWS:128-130, 365-367) | | **keep this round** | S1 reports short-text similarity per lane |
| 33 | Positive posts out (EWS:444, 455, 524-525) | | **keep** | settled by the owner (O5) |
| 34 | Sonar's risk smart tag before the Watch's Gemini (PW:559, 603) | | **keep this round** | `AI.IF` volume against the 4-minute job (row 22) |
| 35 | Drain 2 reviews a run (BQ:3321; ED:1900) | 2 | remove | batches side by side while 150 s is left (O4) |
| 36 | 8 signals a check of each type (EWS:156) | 8 | raise | 50 (never seen to bind: NOT VERIFIED) |
| 37 | Producer's stories told: last 60 (EWS:1903) | 60 | correctness, resized | 24 hours, chunked |

### The fast triage looks at every candidate

Under the allowance every new candidate is already asked (`cands.forEach(...)`, BQ:4570); what stops it is
`DEC_MAX_PER_CHECK_` 15, the daily 300 and ApiGuard 30 / 90 (DEC:68-72, AG:30-31). Under row 51 these go (rows 19-20).
Calls go side by side (O4). A signal with no answer goes on unchanged and is never held back for it (FT:538-575).

### Full reviews most serious first; nothing dropped while there is room; the rest wait

In `queueByAllowance` (BQ:4506), behind row 51, on top of G3.1 (`2f02234`):
1. The causes `check`, `dayReviews`, `watchDay`, `hour`, `hourOrdinary` (BQ:4593-4597) are no longer refusals. One
   cause replaces them: `stop` (the safety stop), plus `pace` (the run-time ledger's step 4, O4).
2. Order: today's `edQueueRank_` (BQ:3951-3963): serious first (`edSerious_`, FT:371-383), then `ftRank_`
   (FT:393-400), then the producer's order.
3. The queue holds 24 (`open_queue_max`). A signal that does not fit stays in the buffer **unmarked** (G3.1's
   mechanism) and comes back at every check while its row is in the 180-minute window. It gets an ending only when it
   would leave the window (`edAgesOut_`, now with the 180-minute window): `Never reviewed: it waited 3 hours while 41
   more serious stories were reviewed first` (83 characters).
4. The drain (ED:1900) has no count a run: batches go while the flow has 150 s left, yield to Burson allows, the ledger
   allows and the stop is not reached.

### The one safety stop

- **Number:** `open_daily_stop` = **2,000 background reviews a day** (Eastern day): every full Gemini call the bot starts
  on its own: Early Detection story reviews (counted where `edQueueTried_` counts, BQ:4132), Watch pre-reads (WA:1216),
  Watch alert triages (OA:376) and Direct card reviews. Burson's own alerts are never counted and never stopped.
- **Derived from the same number** (one figure for the owner; each shown on the Engine tab):
  - quick looks: 10 x = 20,000 a day (a quick look is ~3,500 input tokens and no output, DEC:46-52);
  - Watch post checks (`AI.IF` rows: posts x watches a look): 100 x = 200,000 a day (today's recorded filter output is
    ~4,200 Sonar posts a day, PW:46-48, at most 5 watches: ~21,000);
  - background BigQuery bytes billed (each job's answer gives them): 1.5 GB x = 3,000 GB a day (the recorded Direct
    poll alone is up to ~0.95 TB a day, README.md:683).
  - Embeddings have no stop (WL-9): bounded by construction (only posts read, one call per new text, inside the check's
    slice); counted.
- **Why 2,000:**
  1. Far above a normal day: today's allowance is 150 story reviews (CFG:107); FL's busy-day model gives 290-400
     background reviews (FL section 2), CF's 500-1,000. 2,000 is about 4-5x a busy day and 13x today's allowance.
  2. It is a **bug stop**, not the protection of the daily run time (the ledger does that, O4). It catches what the
     ledger cannot: calls that fail fast and loop (a review that errors in 1 s spends little run time).
  3. Set again from the Engine tab's first week: 5x the busiest day, never below 1,000. It is a setting.
- **What it stops:** no new background review, Watch card or Direct card starts until midnight ET. Checks go on
  (stories keep forming and are listed); quick looks go on to their own ceiling. Queued signals wait; those that age
  out end `Never reviewed: today's safety stop of 2,000 reviews was reached (Burson's alerts went on)` (90). At midnight
  the waiting ones still fresh are reviewed most serious first.
- **What the owner sees:** C51, first, `⛔ safety stop at 4:12 PM: 2,000 background reviews today. Burson's alerts go
  on; stories, Watch and Direct cards wait until midnight ET. No big event? Tell the engineer` (168 characters,
  `noteSwitch_` cuts at 200, Control.gs:842). A derived ceiling reads the same with its own count, for example `⛔ safety
  stop at 4:12 PM: 20,000 quick looks today. Burson's alerts go on; stories wait for 5 accounts until midnight ET. No
  big event? Tell the engineer` (153). C19 ends ` · safety stop reached` (22, replacing the tab pointer as V2 P3c does
  at a day stop).

---

## O4. Capacity

### The walls, in words the owner can check

| Wall | Number | Evidence | How the owner can check |
|---|---|---|---|
| One run | 6 min (Apps Script); the bot stops itself at 5 (`RUN_HARD_STOP_MS_`, Main.gs:783); the one-space flow 220 s, latest 260 s (AC:35, 37) | platform; "UrlFetchApp can't be stopped once a call has started" (GEM:41) | Apps Script > Executions: no run over 6 minutes |
| Trigger and lock | once a minute; one run at a time (`tryLock(1000)`, Main.gs:75, 287-290) | platform minimum; the lock | the trigger list says "every minute" |
| Daily trigger run time | "6-hour/day ... across all scripts on the owner account" (docs/discovery.md:117) | recorded; account type and reset time **NOT VERIFIED** (Google's table from training: 6 h Workspace, 90 min consumer) | Executions, a day's durations summed; C51 shows the ledger |
| Brandwatch | 600 calls / rolling 10 min for the whole client; slrr-campaigns keeps 300 | docs/discovery.md:70-71 (`x-rate-limit: 600/10m`, read live 29 Oct) | the header on every answer (SPEC Q3) |
| Storage | 9 KB a property (EWS:193); 100 KB a cache item, ~1,000 items shared, 6 h (EWS:195-196; VEC:15-16) | platform as recorded; the store's total **NOT VERIFIED** (500 KB from training) | S0 sums `getProperties()` |
| Embedding call | 250 texts / 20,000 tokens a call | VEC:24 comment | — |
| Gemini / Vertex / Decisions rate limits | not recorded; Decisions' 429 said "1,000,000 input tokens per minute on Tier 1" | FX `error_429_live`; 429 handling GEM:436-490, AG:34-35 | the project's quota page; C51 counts 429s |
| UrlFetch calls a day | not recorded (20,000 consumer / 100,000 Workspace from training) | **NOT VERIFIED** | the Engine tab counts fetches |
| A sent call cannot be stopped; grouping cannot be interrupted | `ewsDiscover_` has no deadline (EWS:1077-1118) | code | the Engine tab's "group s" column |
| Burson's requirements for a Social Alert email | business | CFG:345-400; Escalate.gs:78-170 | — |

### The run-time ledger (step S2): the guard that keeps Burson's alerts running

- **What it records.** Property `RUN_LEDGER` (<= 8,800 characters, tested): 24 hourly buckets of run seconds, rolling.
  Each run adds its elapsed time in `poll()`'s `finally` (Main.gs:778-781 area). A run that loses the lock returns
  before the `try` (Main.gs:288-296), so each entry first adds one to a cache counter (`run_entries:<hour>`) before
  `tryLock`; each such entry is costed at `open_lock_loss_seconds` (2 s), calibrated weekly against Cloud Logging
  (WL-12). A run that died is counted by the next run from its claim's start (`claimRun_`, Main.gs:1430-1452).
- **The budget B** = `open_runtime_budget_hours` (6, the recorded quota) - `open_runtime_other_hours` (other scripts on
  the account plus margin; 1.5 until S0 measures them, then S0's figure + 0.5). Rolling 24 hours, because the quota's
  reset time is **NOT VERIFIED** (JF assumed midnight ET, CF midnight PT).
- **Graded steps** on f = used in the last 24 h / B, each shown on C51 and the Engine tab:

| f | What slows (Burson's alerts never) |
|---|---|
| < 0.60 | nothing |
| 0.60-0.70 | checks every 10 min |
| 0.70-0.80 | checks every 15 min; no early asks at 2-4 accounts (stories wait for 5) |
| 0.80-0.90 | only serious story reviews, serious Watch flags (P0/P1 tag, Sensitive Topic, KOF, 2,000+) and serious Direct cards (KOF, 2,000+) |
| 0.90-0.97 | no background reviews or cards; the check every 15 min goes on (stories keep forming in their window) |
| >= 0.97 | no background work at all; Burson's reserve |

- **Why it is not a cap:** it is the account's daily trigger time, a real wall. When that runs out Apps Script stops
  every trigger, Burson's alerts included. The ledger spends it serious-first and never spends Burson's share.
- **Yield to Burson (WL-2, FL-F13):** before each background review or batch, one list of S-F Burson's messages since its
  cursor (the call `runOnce_` makes, AC:124); a new alert ends background work for this run, and the next minute's run
  takes it first. The Engine tab keeps Burson pick-up time (alert posted to handled) p50 / p90 a day; when the day's p90
  passes `open_burson_pickup_p90_s` (120), each run's background time shrinks by 30 s (floor 60 s) until it recovers.
  C51 says `run short 14x` in its walls list.

### The ceilings, and how far each goes (under row 51)

| Ceiling | Today | Becomes | How / evidence |
|---|---|---|---|
| Story reviews | 10 / h, 150 / day, 2 a run (BQ:3317-3318, 3321) | batches of `open_parallel_reviews` (3, up to 6) | below; one-space ceiling ~35-50 an hour serial (WL-11 arithmetic: reviews need 90 s left of 220 s after Burson's pass), ~60-100 an hour in batches of 6 if Gemini's quota allows (CF; **NOT VERIFIED**) |
| Quick looks | 15 a check, one at a time (DEC:68, 337) | all, side by side | `decSignalAskAll_`: one `UrlFetchApp.fetchAll` of a batch starting at 10, growing to 50 while a batch returns in < 3 s, halving when one passes `DEC_SLOW_MS_` (10 s); a call is counted before sending (DEC:37-38); 429'd calls retried next check; the 15-minute pause (DEC:40-47, 67) only when more than half a batch fails (WL-16). Laptop 0.25-0.46 s a call (DEC:46-52); how many requests `fetchAll` runs at once **NOT VERIFIED** |
| Embedding batch | 25 texts a call (VEC:24) | 80 | 80 x 600 characters (~150-200 tokens each) <= 16,000 tokens, under 20,000 (VEC:24) |
| Embeddings a check / day | 400 / 20,000 (EWS:136-137) | time-bounded / none | embedding stops at 15 s left (VEC:30); the rest carried |
| Check time | 40 s (EWS:112) | 40 s | unchanged: a 5-minute check reads a third of today's window |
| Stage B grouping | <= 400 new vs a pool of 1,200 | a slice decided before the call | n = (time left - 5 s) / (last check's ms per new post), at least 100; the rest carried as `nd` ("not yet grouped") and treated as new next check. [RAN] clustered vectors, Node: 1,200 + 400 = 1.43 s (WL) / 1.5-2.1 s (CF); 1,200 + 1,000 = 5.4 s (CF); 1,200 + 2,000 = 11.0-11.3 s (CF). Apps Script factor **NOT VERIFIED** |
| The pool | 1,200, 6 h (EWS:144-145) | 1,200 | kept until the Engine tab records Apps Script's grouping time (WL-6) |
| Rows a lane | 1,500 / 600 | 5,000 + cursor carry | O3 row 5 |
| `acc` (velocity accounts) | one cache item, full at ~2,200 posts in 3 h (EWS:1273, 1904) | chunked like the signatures (`ewsChunks_`, EWS:919) | CF [RAN]: 2,000 rows 87,139 characters; 2,500 = 108,004 (not written); 20,000 = 839,436 (9 items). Reads the old single item too |
| `x` (exclusions) | one item, ~2,000 links (EWS:1904) | chunked | same |
| Carried posts | none | chunked cache items with a manifest property | an evicted chunk is counted lost on C51 (WL-18) |
| Buffer | 30 rows, one item (EWS:178) | 300 rows, chunked, manifest | measured 1.9-4.6 KB a signal (JF on 20 fixtures) |
| Queue | 12 (BQ:3348) | 24 | each row <= 8,000 characters (BQ:3351): 192 KB worst case |
| Seen map | 200 entries (BQ:3328) | G3.2's split + story keys over up to 8 properties | each property's worst case <= 8,800 (tested) |
| All Early Detection properties | — | <= 300 KB worst case, summed in a test | S0 reads the store's real use first; if Burson's and other features' use leaves less, `open_queue_max` goes down |
| ApiGuard | AG:24-31 | O3 row 20 | — |
| Watch cards a run | 2 (WA:70) | while < 3 wait unreviewed | O3 row 25 |
| Direct cards a check | 2 (BQ:80) | while < 3 wait unreviewed, 120 s left | O3 row 27 |

### Reviews side by side (step S12)

- **How (CF):** split `edReviewAndPost_` (ED:1754-1865) into prepare (`edPrepare_`, ED:225-284) for K signals, one
  `UrlFetchApp.fetchAll` of their K Gemini requests through a new `geminiGenerateMany_` in Gemini.gs (requests built by
  today's `geminiPayload_`, answers parsed by the part of `geminiGenerate_`, GEM:406-449, that reads a 2xx body, moved
  into one shared function), then decide and post each one after another (`edConclude_`, `edDecide_` ED:522).
- **K:** `open_parallel_reviews` starts at 3; +1 (up to 6) after a clean hour (no 429, batch p90 < 90 s); halved for an
  hour on any 429, with a 10-minute back-off for all background Gemini calls (FL-F16, WL-15).
- **Never two cards on one story (WR-M7):** two signals sharing a cluster id or 2+ post keys never go in one batch; right
  before each card is posted, `edStoryVerdict_` runs again with a fresh `edLedger_` and the post is claimed in the
  alert memory.
- **No answer lost (FL-F16):** each answer is stored on its queued row before posting; a later run posts a stored answer
  without a new review.
- **Time (WL-15):** a batch starts only with 150 s of the flow left **after** preparation; when preparation used more,
  the batch shrinks to what the time allows or waits a run. Every signal's try is counted before the batch (as
  ED:1853-1855); after a run dies during a batch, that batch's signals are reviewed one at a time so the long one is
  found, and only it reaches 2 tries.
- **Grounding (WL-17):** a background review refused for web search drops the search for background calls only; it
  never sets the shared `grounding_off` switch Burson's reviews read (GEM:276-284, 6 h).
- **The honest risk:** a batch is as slow as its slowest call; the median batch is near one call's p90 (60-90 s), not
  40 s. Text-only reviews' p95 is 133 s (GEM:118-121). The output cap (GEM:53-55) keeps a call under the 6-minute wall.

### Background cards must not make Burson look busy (step S4, WL-1)

Under row 51, in the one-space flow:
1. In the B10 loop (Bot.gs:1794-1877), a time-out or hold on a card the bot posted itself (a Watch alert, `pwAlertOf_`;
   a Direct card, `bqIngestedSource_`) sets `report.bg_backlog`, not `analyst_backlog`. `slaBusy` (AC:124-128) is
   unchanged for Burson's alerts and sheet tests.
2. Before reviewing a bot card that is not serious (Watch: no P0/P1 tag, Sensitive Topic, KOF or 2,000+; Direct: no KOF
   or 2,000+), the loop holds it for the next run when the story queue's top entry is serious (`ser`). One rank across
   the paths without moving the reviews.
3. Watch posting (WA:2066) and the Direct poll post a new card only while fewer than 3 bot cards wait unreviewed in B10
   (`BQ_DIRECT_MAX_WAITING_` = 3, BQ:1614, extended to Watch cards). Flags wait on the Watch detections tab (3-hour
   freshness); Direct candidates come back at the next poll while inside its lookback (test: a candidate not posted for
   lack of room is not marked as posted; **NOT VERIFIED** today, S14 checks).
4. Test: 30 background cards and one serious story in one hour: the story is reviewed within one run of its signal, and
   `slaBusy` stays false while only bot cards wait.

---

## O5. Positive posts and other context

**Not in this round, settled by the owner** (owner_direction.md:45-51: "the slrr alerts table is only negatives ... More
of just a heads up about the data"). No setting is designed; positive posts stay out of stories as today (EWS:444, 455,
524-525). Two rules follow, written into code comments and docs: the absence of positive rows in the SLRR alerts table
is never read as a signal, and that table is never used to judge sentiment balance. Test (S3): no SQL built from the
SLRR alerts table selects or counts a sentiment column (today the table is only a leave-out list, BQ:1815-1818, 1833,
1904, 1934, 2053, per map_turned-away 11).

---

## O6. A busy day without caps

**The model day** (FL section 2; every row marked (A) is an assumption, **NOT VERIFIED**: no event day, dismissal
rate, Watch-alert or Direct-card day count is recorded anywhere): a Google product outage, 6 hours at 5x the normal
rate, 18 normal hours.

| Quantity | Value |
|---|---|
| Story signals (136 a day normal, DEC:71; +4 x 136 x 6/24) | ~270 |
| Stories reaching 2 accounts (90-161 a day, EWS:80, same multiplier) | ~180-320, each asked at up to 3 sizes |
| Held back by the quick look (A: 35% with the widened hold) | ~175 left |
| Early raises at 2-4 accounts (A: 5-15% of asks) | ~10-50 |
| Full-review updates at the 2x bar | ~60 (A) |
| Growth notes (1.5x steps, no review) | ~150 (A) |
| Watch alerts (A) | 20-60 |
| Direct cards (A) | 10-30 |

**Reviews:** ~175 + 10-50 + 60 + 20-60 + 10-30 = **~275-375 background reviews**, against the stop of 2,000.

**Run time** (the wall that binds):
- story reviews in batches of 3-6: ~245 x ~17-25 s = 1.2-1.7 h (CF's arithmetic: 6 reviews in ~100 s);
- Watch and Direct reviews, one at a time in the B10 loop: 30-90 x ~40 s = 0.3-1.0 h;
- checks: 288 x a quiet check's time (**NOT VERIFIED**; 10-15 s assumed) = 0.8-1.2 h;
- quick looks: ~900-1,500 at ~0.4 s, side by side: under 0.2 h;
- Burson's own alerts, the Watch's looks and the account's other scripts: **NOT VERIFIED** (S0).
- Total ~2.5-4.1 h before Burson's base. If the base is over ~1 h the ledger's first steps act on that day (checks
  every 10, then 15 minutes), and C51 says so. Serial reviews (JF) would add 1.5-2.5 h and cross the 6-hour wall.

**What reaches the one space** (top-level cards are what the owner scrolls):

| | Count | How it stays readable |
|---|---|---|
| Story cards reviewed, not dismissed (A: 40-60% dismissed) | ~100-160 | quiet ones (monitor, severity none/low, A: half) go as replies under one `🗂 *Other stories this hour*` card; stories the review names as the same event as an earlier card go as `🔗 *Related story:*` replies in its thread; escalations are always top level |
| Story cards at top level | ~40-70 | serious first |
| Growth | ~150 notes, ~60 updates | all in the card's own thread |
| Velocity spikes on topics or risk words whose posts mostly sit in stories carded in the last 6 h | — | a note in the largest such story's thread (FL-F19), not a card |
| Watch alerts | 20-60 top level | one alert a story with "Same story" replies (WA:31-38, no cap per G1.3); "Part of a story" note to the story card (G2.1) |
| Direct cards | 10-30 top level | same notes (V2 P4c) |
| **Top-level cards in the day** | **~70-160**, about 8-15 an hour in the event hours | |
| Social Alert emails (to `Control!B30` while Testing) | a handful per distinct issue | Alert memory folds another post on a story emailed in the last 24 h into that alert's thread (AlertMemory.gs:27, 78, 90-91); G2.2 one issue one email by post key; leadership pings deduped 14 days (Drafts.gs:2516-2522) |

The honest answer: on an event day the space will carry 8-15 new top-level cards an hour. Grouping, threads and the
hourly card keep it to that, not to the 30-40 an hour of everything at top level, and nothing is turned away to get
there. If it is still too noisy the judging is tuned (the hold-back bar, the hourly card's level), not a cap.

**Gemini that day, by the code's records** (no price per token is recorded anywhere: **NOT VERIFIED**):
- Reviews: the only token figure, "31,204 in, 2,950 thinking, 13,434 out" (GEM:514-515), is a docstring example of a
  call that **hit its output cap** (FL): an upper bound. 375 reviews <= ~11.7 M input, <= ~6.1 M output-and-thinking
  tokens, **plus one enterprise web search per review** (CFG:87 `web_grounding: enterprise`), price **NOT VERIFIED**.
- Quick looks: ~900-1,500 x ~3,500 input tokens = 3.2-5.3 M input, no output (DEC:46-52).
- Embeddings: ~60,000 texts x 600 characters = 36 M characters, ~$0.90 at the old pipeline's recorded $0.000025 per
  1,000 characters (`14a7b75:analytics/early_detection/README.md:74`; today's price **NOT VERIFIED**).
- Watch `AI.IF` rows: ~20,000-60,000 (A).
- BigQuery: 115-518 GB for Early Detection at 5 minutes, ~0.4 GB a Watch look (PW:87), up to ~0.95 TB the Direct poll
  (README.md:683).
- **Money:** S0 reads one week of the project's bill against the run log's counts and writes per-unit prices into the
  setting `open_unit_costs`; from then C51 can show `≈ $N today` next to the stop (FL-F12).

---

## O7. Every "no" is visible

**1. C51, the walls line**, rewritten each run, at most 200 characters, warning first:
- normal: `today: checks every 5 min · 132 of 2,000 reviews · run time 2 h 05 of 4 h 30 (24 h) · walls hit: Gemini busy
  2×, run short 14×, Burson first 3× · Engine tab` (156);
- row 51 OFF: `run time today: 1 h 20 of 4 h 30 (last 24 h) · Burson pick-up 40 s (p90)` (72), after the OFF text;
- pace: `⏸ run time ahead of pace (3 h 40 of 4 h 30 in 24 h): checks every 15 min, only serious stories reviewed.
  Burson's alerts go on · Engine tab` (139); `⏸ run time nearly used (4 h 05 of 4 h 30 in 24 h): no background
  reviews; checks every 15 min. Burson's alerts go on · Engine tab` (129);
- stop: section O3 (168 / 153);
- carry lost: `⚠️ 214 posts carried to the next check were lost (the cache dropped them) · today: 132 of 2,000 reviews ·
  run time 2 h 05 of 4 h 30 · Engine tab` (144);
- 429s: `⚠️ Gemini said "too busy" 6× in the last hour: reviews go 1 at a time for an hour · today: 132 of 2,000 reviews ·
  run time 2 h 05 of 4 h 30` (139).
- "walls hit" names every kind that deferred work today: Gemini busy (429), run short (time), Burson first (yield),
  ApiGuard, pace, BigQuery slow, Brandwatch login busy, storage full, grouping carried.

**2. The Early Detection tab** (V2 P3b) gains, under row 51 (all through `edNote_`, EDN:168, counted once in C19's sum):
- `Never reviewed: it waited 3 hours while N more serious stories were reviewed first` (83);
- `Never reviewed: today's safety stop of 2,000 reviews was reached (Burson's alerts went on)` (90);
- `Never reviewed: the day's run time was nearly used, so only serious stories were reviewed` (89);
- `Update noted in its card's thread: 12 accounts now (8 at the card); the quick check says it is no worse` (103);
- a **summary row per check** for the early asks (FL-F17: per-story rows would be 500-900 on an event day against the
  tab's 200 waiting rows, EDT:27-31): `Asked early (2-4 accounts): 14 stories, 2 raised. Nearest misses: "Pixel 10
  battery drain" (severity medium 48% sure, about Google 92%)` (135); a per-story row only for a story that later became
  a signal or a card;
- `Check skipped: Burson's alerts were waiting (the check runs again next minute)` (78) and the same for ApiGuard and
  pace (today a silent skip, AC:148-149, ED:1903);
- Kind `Single post`; column **Sources**.
- The tab write is reserved in the run's budget before the drain, the waiting rows move from one cache value to chunked
  items with a manifest, and C51 shows rows waiting (FL-F17).

**3. A new bot-made tab `Engine`** (A1 `Engine: one row per Early Detection check, what it read, judged and could not do
(written by the Burson QA bot)`, 111 characters; never a tab a person made, AGENTS.md 2.5), one row a check, 7 days kept
(~2,000 rows), every cell short: time; real gap since the last check; posts read per lane; fresh / late; embedded;
carried (embedding, grouping, rows); lost (cache); grouping seconds and posts; stories formed; signals; quick looks
asked / held / raised; reviews started, batch size, batch seconds; Watch and Direct cards posted / waiting; run seconds;
ledger used / budget and step; yields to Burson; Burson pick-up p50 / p90; ApiGuard deferrals; 429s; fetches; BigQuery GB
billed; `AI.IF` rows; grounded calls; seen-map and stories-told evictions; safety-stop counts. A daily row adds the
measures below.

**4. "Why not this post?" (FL-F18, step S18):** the owner posts `why not <link>` in the Auto-correct space; the bot
answers in that thread from what it holds (alert memory `seenPost`, the producer's members, pool and exclusion lists,
the Watch detections tab, the Early Detection tab) and, when it holds nothing, which gate the post fails, read-only.
Example: `Why not: read 10:42 AM from Sonar; it joined the story "Pixel 10 battery drain" (3 accounts; 5 are needed to
post without asking). Asked at 3 accounts: severity low, 81% sure.` (175). Auto-correct space only, through the leak
guard; `Why not:` is added to the bot's own heads.

**5. What is counted, not listed** (a row a post would be thousands a day): posts carried, read late, dropped by a gate
(English, length, spam, size), over a Watch look's cap, and the Watch's `AI.IF` "no"s (not kept anywhere today,
PW:879): counts per source on the Engine tab and the Watch sources tab.

**6. Measures that show faster and wider** (Engine tab daily row, 7 days, compared with the same days before row 51):
- **Faster:** minutes from a story's first post (`window_start_utc`) to its card, median and p90, per path; the Results
  tab's comparison with the IMs' Social Alerts (Speed.gs, `speed_tab`, CFG:96).
- **Wider:** posts read and stories started by each source; share of stories with members from 2+ sources; "seen first"
  only between sources whose seen time is a BigQuery arrival (WR-N4).
- **Accurate:** share of early cards (2-4 accounts) and single-post cards later dismissed by a review or rated wrong on
  the tabs, by account size (FL-F14); posts whose time was corrected (WR-S2); account keys that are link fallbacks
  (WR-S3); spikes on topic keys outside the kept topics (WR-S6).
- **Turned away:** endings by reason a day.

---

## O8. What changes in what is built

### Settings and defaults of the merged fix plan (V2) that change

Read only while row 51 is ON; with row 51 OFF their values and meaning are unchanged, and G3.1-G3.7 apply.

| Setting / constant | Today | Under row 51 |
|---|---|---|
| `early_wave_reviews_per_hour` 6, `early_wave_reviews_per_day` 150 (CFG:106-107) | allowance | not used (ranking; the stop) |
| `EW_MAX_PER_CHECK_` 5, `EW_MAX_PER_HOUR_` 10 (BQ:3314, 3317), `EW_WATCH_QUEUE_PER_DAY_` 8 (FT:74) | | not used |
| `DEC_MAX_PER_CHECK_` 15, `DEC_MAX_PER_DAY_ALLOWANCE_` 300 (DEC:68-72) | | not used; derived 20,000 |
| `ED_QUEUE_MAX_` 12, `EW_QUERY_MAX_ROWS_` 25, `EWS_BUFFER_MAX_` 30, look-back ~60 min | | 24, all unended, 300 chunked, 180 min |
| `EW_DRAIN_MAX_PER_RUN_` 2 (BQ:3321) | | batches of `open_parallel_reviews` |
| `EW_EVERY_MS_` 15 min, `EWS_EVERY_MS_` 10 min | | `open_check_minutes`, interval - 60 s |
| `early_wave_topic_min_ratio`, `early_detection_first`, `early_detection_tab`, `cross_alert_notes`, `requirement_line` | | unchanged and assumed on |
| P2b step 7 ("a refused signal is finished") | reversed by G3.1 for the check and the hour | no count refusal at all |
| G3.2 seen map | being built | kept; story keys spread over up to 8 properties |
| V2 P0b helper caps (3 a card, 6 a run, TN:47-48) | | unchanged, except growth notes (O3 row 12) are not refused by them, as G1.2/G1.3 already exempt their notes |

**New settings** (`burson_qa:` in CFG, `BursonQAConfig` in `triage_agent/config.py`, `Generated.gs` rebuilt with
`.venv/bin/python -m scripts.build_apps_script`), read only while row 51 is ON:

| Setting | Default | What it is |
|---|---|---|
| `open_check_minutes` | 5 | the check interval |
| `open_daily_stop` | 2000 | the one safety stop (background reviews a day) |
| `open_fresh_minutes` | 180 | fresh = first read within this of posting |
| `open_lane_bars` | `{}` | per-lane start / join bars from S1 |
| `open_velocity_fix` | true | late-post rule, lag rule, warm-up by lane, lanes on rows, coverage per lane, one topic vocabulary |
| `open_velocity_warmup_days` | 7 | |
| `open_velocity_lag_minutes` | 60 | |
| `open_runtime_budget_hours` | 6 | the recorded daily trigger quota |
| `open_runtime_other_hours` | 1.5 | other scripts plus margin, until S0 |
| `open_lock_loss_seconds` | 2 | cost of a run that lost the lock |
| `open_burson_pickup_p90_s` | 120 | |
| `open_parallel_reviews` | 3 | first batch size (grows to 6) |
| `open_queue_max` | 24 | |
| `open_hold_none_at` | 0.80 | |
| `open_single_post` | true | |
| `open_growth_notes` | true | |
| `open_quiet_hourly_card` | true | |
| `open_related_threads` | true | |
| `open_unit_costs` | `{}` | per-unit prices from S0 |

A setting at false / 0 / `{}` gives back the bot as before that step, with row 51 ON (rollback without a revert, V2 2).

**Control:** row 51 `openEngine` appended to `CONTROL_SWITCHES_` (after Control.gs:564), written OFF by
`ensureSwitchRows_` (Control.gs:643), never set ON by code:
- Label `Open engine: judgment in place of caps` (38);
- OFF `OFF (Early Detection, the Watch and Direct BigQuery keep today's limits)` (72);
- waiting `✓ ON, but waiting: it needs Early wave & velocity check (row 19) ON` (67);
- ON `✓ ON: checks every 5 min, every source can start a story, the most serious go first; one safety stop a day` (106).
- "How it works" moves **once**, from row 49 (`CONTROL_HELP_ROW_`, Control.gs:297) to row **53**, row 52 blank (the
  precedent of a blank row before the help, SPEC Q11, commit `51a5880`): done by whichever of SPEC 1a or S2 lands first;
  `CONTROL_HELP_ROWS_` (Control.gs:298) +4. No existing row moves. `mcp/slrr_live_ops_server.js` switch list gains 46,
  48-51.
- New Chat heads (`📈 *Growing:*`, `🗂 *Other stories this hour*`, `🔗 *Related story:*`, `Why not:`) are added to
  `Voice.gs isBotFormattedText_`, `Outbox.gs OUTBOX_GUARD_PATTERNS_` and the leak audit's deny list, as V2 P0b requires.

### Rules of the new sources built at 50aa822 that change

| Built rule (@50aa822) | Change |
|---|---|
| Trial 7 days; lifted 2 / h, 20 / day (`ewsLiftGate_` EWS:2319, `ewsInTrial_` 2364, applied 2683; early watch 2374, 2691; settings EWS:303-320, CFG@50aa822:120-122) | removed with their settings `early_wave_new_trial_days`, `early_wave_new_lifted_per_hour` / `_per_day` |
| Embedding share 100 / 400, 5,000 a day, day bar 15,000 (`ewsEmbedSplit_` EWS:2006-2028; `EWS_NEW_DAY_CAP_` 133) | removed: one order for all lanes; settings `early_wave_new_embed_per_check` / `_per_day` removed |
| Pool share 300 of 1,200 for 120 min (`ewsNewPoolShare_` EWS:2089-2094, 2525-2529, 2665-2666) | removed: one pool; settings removed |
| Carry of new-lane posts only, 100, 2 h (EWS:134, 2075, 2591) | widened to every lane (O4 carry with manifest); `early_wave_new_carry_max` removed |
| Late split for new lanes only, 180 min (EWS:877-879; `early_wave_new_late_minutes`) | every lane, as `late` (`open_fresh_minutes`) |
| Velocity excludes new lanes (EWS:2597) | replaced by S8's warm-up by lane |
| Own signatures for new lanes (EWS:952-953) | kept (correctness: today's lanes' signatures unchanged) |
| Platforms count only from today's lanes (EWS:1423-1435) | replaced by the `Web` rule for every lane |
| Bar leaves out new-lane members whose author is excluded or post big (`ewsNewLeftOut_` EWS:1411-1414) | every lane, with big authors (WR-S5) |
| Today's copy wins; exclusions and alert memory for new lanes only (`ewsStitch_` EWS:2213-2300) | key + who identity, first copy keeps the slot, later copies fill gaps and correct an inexact time, alert memory marks |
| `ewsNewAuthor_` for new lanes only (@50aa822:425-437) | one author function for every lane, link fallback = unknown |
| Live check's 120-min "leave out" (LiveVerify.gs@50aa822:279-280, 642-653) | a report line only |

### Sections of the new-sources plan (1_new_sources_plan.md) to amend

- **§0 rule 2** ("A new source only adds ... today's lanes always win"): becomes "every source has the same standing;
  one post (link key + who) counts once; the first copy keeps its place and later copies fill gaps".
- **§0 "Not in this round" and "What this plan gives up"**: velocity from new sources moves in (S8); the trial, the
  lifted caps, the Brandwatch volume ceiling and "today's lanes are not improved" go.
- **§1 table**: rows "Late posts", "Velocity", "The pool", "Same post".
- **Q1**: `Suggested` decides "must name Google" for a ticked query; `bw_live_queries_max` 20 stays (one call reads 20;
  more ticked queries are read in a second call in the same read, still under 20 calls in 10 minutes).
- **Q2**: one read at every check (5 min under row 51) as soon as the last parcel was taken; parcel stays 300.
- **Q3**: drop `bw_live_mentions_per_day` 30,000 and pacing; keep 20 calls / 10 min, the pause at 450 used, the 429 and
  401 rules; show the day's mentions against 600,000 on the tab.
- **Q5**: the three limits and the embedding / pool rows go; the late split applies to every lane; velocity per S8.
- **Q6**: `amie_rows_per_check` 300 becomes 5,000 with the mark moving to the last row read (oldest landing first,
  already the SQL's order); exclusions for every lane.
- **Q8**: rules 1-3 replaced by O1 points 3-5; worked examples gain WR's (40 comments under one Google post; a date-only
  time corrected; one person under two keys).
- **Q10**: `watch_amie_per_day` removed.
- **Q11**: the settings table loses trial, lifted, embed share, pool share, carry max, AMIE rows, Brandwatch day and
  pacing; help moves to row 53 (not 52); row 51 added.
- **Q13 step 4** (read the trial list) removed; **Q14** E4, E5, E8, E9, E22 kept for row 51 OFF and inverted for row 51 ON.
- **Q15**: stage 2's gate "a source over 2 hours is taken out" becomes a report.

### The steps, in order

Every step is behind row 51 (plus its own setting where named), keeps row 51 OFF byte for byte (the golden-flow test,
`switch_golden_flows.test.js`, passes with no update), and is small enough for one engineer. Each runs its own test
files with one filter at a time (`node apps-script-chat-bot/test/run_tests.js "<name>"`), then the full suite, pytest,
`scripts.build_apps_script --check` and `node scripts/repo_safety_scan.js` (must print `clean`) before its commit (V2 2).
Nothing new reaches B25 or B26: every new note goes through V2's one helper (P0b) and the leak guard.

| Step | What it does | What it alone gives the owner | Files | Tests (new names) | Must not change | Amends |
|---|---|---|---|---|---|---|
| **S0** Measure (no code) | Reads: every trigger on the account and the day's run time (Executions, `slrr_read_logs`); account type and quota page; the properties store's use (`getProperties()` summed); a quiet check's seconds; review time mean, p50, p90; Burson pick-up delay today; a week of C19 / C35 counts and the Early Detection tab's dismissal rate; one week of billing per unit; Vertex, Gemini and Decisions quotas; each lane's lag (posting to read) and Sonar's blank-username share; Sonar batching on one `received_at`; dry-run bytes of the nightly and Tubular reads; whether `sonar_raw` is partitioned on `received_at`. Results to `notes/` (AGENTS.md 2.7) | the numbers the rest depends on; gates: `open_runtime_other_hours`, `open_velocity_lag_minutes`, `open_queue_max` if the store is fuller than thought | none | — | the repository | — |
| **S1** Same-story check | `verifySameStoryLive()`, hand-run, read-only; the bot-made `Same-story check` tab; a report per lane | the similarity bars measured on Tubular, the nightly table, AMIE and Brandwatch live before they are opened | `LiveVerify.gs`, `live_verify_runner.js` | `switch_same_story_check.test.js`: only GETs, dry runs and embedding calls; the tab is the bot's (a foreign tab untouched); no snippet holds a link or handle; never X | any tab a person made | SPEC stage 0 gains it |
| **S2** Row 51, ledger, stop, yield, guards, C51 | Row 51; `RUN_LEDGER` (always records); graded steps; yield to Burson and the pick-up gauge; the stop and its derived ceilings; ApiGuard under row 51 (O3 row 20); grounding protection; C51 texts | the owner sees the day's run time and the walls before anything opens, and the protections exist first | `Control.gs` (row 51; help 49 to 53; `CONTROL_HELP_ROWS_`), `Main.gs` (ledger in `poll()`'s `finally` and before `tryLock`), new `OpenEngine.gs`, `ApiGuard.gs` (AG:24-35, 112-123), `AutoCorrect.gs` (yield; AC:124-149), `Gemini.gs` (GEM:276-284 background-only), config trio + `Generated.gs`, `mcp/slrr_live_ops_server.js` | `switch_open_engine.test.js` (stop at 2,000 holds the 2,001st background review, a Burson alert in the same run is triaged, C51 texts <= 200 in every state, next ET day resumes); `switch_run_ledger.test.js` (ledger <= 8,800; lock-losing entries counted; graded steps; rolling 24 h); `switch_yield_burson.test.js`; `switch_control.test.js` row 51 OFF by default, help at 53 | rows 11-50 and their texts; Burson's pass | V2: none; SPEC Q11 help row |
| **S3** Engine tab and visible endings | The `Engine` tab; the new endings; the early-ask summary row; "Check skipped" rows; tab write reserved, waiting rows chunked; the SLRR-sentiment wording test (O5) | every "no" and every wall on a tab, before the engine opens, so each later step's effect shows | new `EngineTab.gs`, `EarlyDetectionNotes.gs` (EDN:49-63, 124-153), `EarlyDetectionTab.gs` (EDT:24-54), `AutoCorrect.gs:148-149`, `EarlyDetection.gs:1903` | `switch_engine_tab.test.js` (one row a check, every column; never a person's tab; cells short); `switch_ed_tab.test.js` additions; `switch_ed_counted_once.test.js` unchanged; `switch_open_sentiment_rule.test.js` | C19's sum | V2 P3b columns (Sources) |
| **S4** Background cards don't make Burson look busy | O4 "Background cards" points 1-4 | a backlog of the bot's own Watch and Direct cards no longer switches Early Detection off, and a serious story goes before an ordinary card | `Bot.gs` (1794-1877), `AutoCorrect.gs` (124-149), `WatchAlerts.gs` (2060-2075), `BigQuery.gs` (1596-1614, 2771-2772) | `switch_bg_backlog.test.js` (30 bot cards and one serious story in an hour) | Burson's alerts' handling; the Mirror flow | — |
| **S5** Ranking in place of the allowance (needs G3.1-G3.3 merged) | O3 "Full reviews most serious first"; queue 24; buffer 300 chunked + manifest; rows read = all unended in 180 min; seen map over 8 properties; producer's stories told 24 h chunked; drain by time | no story turned away by a count; serious first; the rest waits | `BigQuery.gs` (3314-3329, 3348, 3384-3390, 3620-3694, 4102-4130, 4506-4613), `EarlyDetection.gs` (1867-1903), `EarlyDetectionNotes.gs`, `EarlyWaveSource.gs` (178, 1899-1903), `FastTriage.gs:74` | `switch_open_allowance.test.js` (25 stories, 10 serious: all reviewed over the next checks, serious first, none "Never reviewed" while fresh, C19's sum holds; 60 in an hour; a full queue keeps the lowest waiting); `switch_open_storage.test.js` (every Early Detection property's worst case summed <= 300 KB; seen map per property <= 8,800); `switch_ed_allowance.test.js` and `switch_ed_burst.test.js` unchanged with row 51 OFF | the allowance with row 51 OFF | V2 P2b step 7 under row 51 |
| **S6** Checks every 5 minutes (needs S2) | `open_check_minutes`; `EWS_EVERY_MS_` = interval - 60 s; `DEC_PAUSE_MS_` follows; paced by the ledger | stories seen up to 10 minutes sooner | `BigQuery.gs` (3312, 4252), `EarlyWaveSource.gs` (111, 255), `Decisions.gs:67` | `switch_open_interval.test.js` (checks at 0, 5, 10 min with row 51 ON; 15 with it OFF; the floor never skips a check; a ledger at f = 0.65 gives 10 min) | per-check numbers | — |
| **S7** Ingest capacity | `VEC_BATCH_` 80; embedding by time, carry for every lane (chunked + manifest); daily 20,000 removed; `acc` and `x` chunked; Stage B slice with `nd` carry; rows 5,000 + cursor carry at the last complete timestamp; gap read up to 24 h, 2 h a check; 8 signals a check to 50 | no post lost to a count; velocity counts stay right past 2,200 posts in 3 h | `Vectors.gs:24`, `EarlyWaveSource.gs` (117-120, 136-137, 156, 549-579, 1077-1118, 1273, 1658-1690, 1897-1954) | `switch_open_capacity.test.js` (2,000 posts in one check: none lost over 3 checks; a slow Stage B stops at its slice and the rest is grouped next check; `acc` of 20,000 rows chunked and read back equal; an old single `acc` read; an evicted carry chunk counted lost; a lane returning 5,000 rows with 30 sharing the last timestamp loses none); `switch_early_wave_source.test.js` unchanged with row 51 OFF | the US and us-central1 request bodies with row 51 OFF (snapshot) | SPEC Q5 carry |
| **S8** Velocity made correct (needs S7) | O1 velocity points 1-6, setting `open_velocity_fix` | velocity can take every source with no false spikes, and today's late posts stop pulling the baseline down | `EarlyWaveSource.gs` (164-174, 1286-1396, 1741-1745), `EWS_STATE`, new `EWS_ROLL_<lane>` properties | `switch_open_velocity.test.js`: WR's [RAN] scenarios on the fake clock (100 and 300 accounts an hour from a new lane: 0 false spikes over 22 days; a burst of 60 on day 10 fires; with the fix off today's 8 a day come back); a late post leaves a closed hour unchanged; a lane absent 6 h warms again; a dropped topic does not spike; row 51 ON with the fix off gives no `acc` row to a lane that has none today | today's velocity with row 51 OFF | SPEC Q5 "Not in this round" |
| **S9** Equal standing (needs S7, S8; a lane only after its S1 labels) | O1 points 1-6: `late` by the bot's read time; name rules out; Google rule by table; `Web`; embedding order; key + who identity; first copy keeps the slot, gaps filled, exact time wins, lanes listed; one author function; exclusions and big authors for every lane; alert memory marks; Tubular and nightly read on change with overlap; `open_lane_bars`; the reviewer's line; Sources column | Tubular, the nightly table, AMIE and Brandwatch live start stories when fresh, and one post or person is counted once | `EarlyWaveSource.gs` (330-341, 380-425, 430-540, 549-579, 715-770, 1054-1118, 1211-1249, 1658-1798), `EarlyDetection.gs` (897-929, one payload line), `EarlyDetectionTab.gs` | `switch_open_equal_lanes.test.js`: a fresh Tubular video and a fresh nightly row each start a story with 4 other fresh accounts; the same seen 4 h after posting only join; 40 commenters under one Google post = 40 accounts; one Reddit post through `bwl` and Sonar = one member, words from the copy that had them; a date-only Sonar time corrected by Tubular's exact one; `u/alice` and `alice` = one account; two blank-author Sonar posts are not a 2-account story; `News` + `Forum` from unknown domains do not lower the bar; a Watch-carded post stays a member; row 51 OFF snapshot | today's lanes with row 51 OFF | SPEC Q1, Q4, Q5, Q8 |
| **S10** New-source rules amended (on build/src-base, after S9) | the 50aa822 table above; Brandwatch reader every check, no day ceiling; AMIE 5,000 rows with the mark | AMIE and Brandwatch live with full standing | `EarlyWaveSource.gs@50aa822`, `LiveVerify.gs@50aa822`, config trio, `1_new_sources_plan.md` | `switch_ed_new_lanes.test.js` changed on purpose (named in the commit): trial / caps / shares inverted for row 51 ON, kept for OFF | rows 48-50 OFF behaviour | SPEC as listed |
| **S11** Quick looks for every candidate; 2 accounts; raise and hold rules | `decSignalAskAll_` side by side; caps removed; blank B45 reads 2; CF raise rule; `open_hold_none_at`; precision measure | Gemini looks at every candidate and at stories from 2 accounts; the critical lawsuit story would have been raised | `Decisions.gs` (37-72, 330-360), `FastTriage.gs` (39-74, 357-441), `EarlyWaveSource.gs` (185-187, 1529-1534, 1557-1648), `ApiGuard.gs:30-31` | `switch_fast_triage.test.js` additions on FX: 3 / 3 risks raised, 0 / 5 noise; 5 / 5 noise held, 0 risks; one `fetchAll` of N; a 429 on 1 of 20 retried next check without a pause; more than half failing pauses; the old pins (902-915) with row 51 OFF | the old bars with row 51 OFF | — |
| **S12** Story reviews side by side (needs S5) | O4 "Reviews side by side" | 60-100 story reviews an hour if Gemini allows, at less run time each | `Gemini.gs` (309, 406-516, new `geminiGenerateMany_`), `EarlyDetection.gs` (1754-1865, 1867-2003), `BigQuery.gs:3321-3322` | `switch_parallel_reviews.test.js`: one `fetchAll` of 3; a promotion and a spike on one story in one batch give one card and one update; a 429 halves K; a stored answer posted next run with no new review; a run dying mid-batch reviews them one at a time next; G2's four timelines (one Social Alert email per issue) pass with K = 6; K = 1 gives today's requests | Burson's reviews | — |
| **S13** The Watch: the single worrying post | `pwSolo_` rule; pre-read time reserve; bwm day cap removed; one config rule; posting while < 3 bot cards wait (S4) | a meaningful small post with a serious tag goes out alone | `WatchAlerts.gs` (69-71, 97-124, 1351-1363, 2060-2075), `ProactiveWatch.gs` (121, 131-139), `AutoCorrect.gs:37` | `switch_watch_single.test.js`: a pre-read-meaningful P1 flag from a 300-follower account with 5 engagements goes alone in the Auto-correct space, waits in the Mirror and Other spaces, waits with no pre-read; a sensitive-topic flag goes alone; a flag waiting 10 min gets its pre-read in a busy run | the Watch's SQL and look caps | — |
| **S14** Direct BigQuery by time | every source read; 50 candidates; ranked across sources; posting while < 3 wait; a candidate not posted is not marked | no placeholder cap of 2 | `BigQuery.gs` (77-80, 1596, 2568-2871) | `switch_direct_bq_open.test.js` | the 500 floor; Burson first at 120 s | — |
| **S15** Single small post (needs S11, S5) | `SINGLE_POST` for P0 / P1 risk-term posts; `edStoryPrior_` need = `Math.min(2, keys.size, L.keys.size)` (ED:1172); alert-memory claim; card wording | a small post with a serious risk word is reviewed without waiting for a second account | `EarlyWaveSource.gs` (a pick beside `ewsWatchPick_`, EWS:1557), `BigQuery.gs` (signal kind), `EarlyDetection.gs` (1169-1179, card words) | `switch_ed_single_post.test.js`: a 300-follower Sonar post with `privacy_data_leak` and a high-severity answer gives one card; the same at 2,000 followers gives none (the Watch's floor); a single-post card then a 5-account story with that post gives one card and one update | the Watch's floor | — |
| **S16** Growth notes (needs S11, S5) | O3 row 12 | a growing story shows its growth in its own thread within one check | `EarlyWaveSource.gs` (155-159, 1211-1249), `EarlyDetection.gs` (1066-1067, 1259-1280), `ThreadNotes.gs` (cap exemption) | `switch_open_growth.test.js`: 5 to 200 accounts gives about 8 notes and 5 reviews; the quick look one level up twice gives a review; once gives a note; no notes after the newest post is 180 min old | V2 helper's other caps | V2 P0b caps (exemption) |
| **S17** Readability (needs S5) | the hourly card for quiet stories; `same_event_as` in the review schema (up to 10 card headlines of the last 6 h with centroid >= 0.70 offered); spike notes in a story's thread | a busy day stays readable without turning anything away | `EarlyDetection.gs` (635-708 schema, 822-935 prompt, posting), `ThreadNotes.gs` | `switch_open_readable.test.js`: the O6 scenario with fakes (600 posts in 36 checks): escalations top level; quiet ones under the hourly card; a related story as a reply only when the review names the card; no post to B25 / B26; the leak guard on every text | the card's own text | — |
| **S18** "Why not?" (needs S3) | the reply | the owner can ask about a post they saw | `Bot.gs` (the Auto-correct answer path), new `WhyNot.gs` | `switch_why_not.test.js`: answers from each store; read-only; only in B10; leak guard; never in B25 / B26 | other answers | — |

**Dependencies, in one line:** S0 -> S2 -> {S3, S4, S6, S7}; S7 -> S8 -> S9 (with S1's labels) -> S10; S2 + G3 -> S5
-> {S11, S12, S16, S17}; S11 -> S15; S4 -> S13, S14; S3 -> S18.

---

## Every limit that remains

| Limit | Kind | Evidence the owner can check |
|---|---|---|
| A run lasts at most 6 minutes; the bot stops at 5 | wall (platform) | Apps Script > Executions; Main.gs:783 |
| One run a minute, one at a time | wall (platform; the lock protects against double alerts) | trigger list; Main.gs:75, 287-290 |
| Daily trigger run time (6 h recorded, shared by all scripts on the account) | wall (platform) | docs/discovery.md:117; Executions summed; C51 |
| A sent call cannot be stopped; grouping cannot be interrupted | wall (platform) | GEM:41; EWS:1077-1118 |
| Storage: 9 KB a property, 100 KB a cache item, ~1,000 items shared, store total | wall (platform) | EWS:193-196; VEC:15-16 |
| UrlFetch calls a day | wall (platform), number NOT VERIFIED | quota page; Engine tab |
| Brandwatch 600 calls / 10 min, shared; the bot's 20 and the 450 pause | wall (outside service) | docs/discovery.md:70-71 |
| A Brandwatch read of 300 mentions (the parcel through the cache into BigQuery) | wall (the route: 6 cache items, SPEC Q2) | SPEC Q2-Q3 |
| Embedding call 250 texts / 20,000 tokens | wall (outside service) | VEC:24 |
| Gemini, Vertex, Decisions rate limits | wall (outside service), numbers NOT VERIFIED | 429s on C51; quota page |
| Watch look caps and the 4-minute job | wall (BigQuery AI job time) | PW:52-53, 82 |
| 3 bot cards waiting unreviewed in the space | wall (review time in the flow) | Bot.gs:1806-1877; BQ:1614 |
| Burson's requirements for a Social Alert email (KOF, 2K+, P0 / sensitive, owned posts) | business | CFG:345-400; Escalate.gs:78-170 |
| English only; Google's own accounts out; strict evergreen topics; 14-day novelty | business | ED:567-570, 847; EWS:474-480; Vectors.gs:299-317; CFG:270 |
| Positive posts out of stories | business (owner's answer) | owner_direction.md:45-51 |
| Never X from Brandwatch | business (shared X allowance) | PW:1218-1219; TempCheck.gs:27 |
| Direct's 500 engagements | business (SLRR leads to set) | BQ:1600 |
| Low tier = 5,000 followers / 500 engagements in stories | correctness (one post, one path) | EWS:126-127, 381 |
| 5 accounts to signal without asking (Gemini below it) | correctness (some bar; cost) | EWS:79-82, 152-153 |
| 2 links; copy-paste ring; same-author copies | correctness (one thread is one link; spam rings; one person ten times) | EWS:435, 1233-1236, 768-782; Alert.gs:676-680 |
| Grok / bots / deleted / spam / homonyms out | correctness (not people; false stories) | EWS:382-384, 442-443 |
| Must name Google for the nightly table | correctness (competitors' queries) | EWS:218, 405 |
| One story one card; growth thresholds for a full review | correctness (alert twice) | EWS:1211-1220; ED:1259-1280 |
| Seen map, buffer ids, stories told | correctness (queue twice) | BQ:3620-3694; EWS:1899-1903 |
| Queue tries = 2 | correctness (no retry loop) | BQ:3350 |
| Freshness 180 min to start a story; 3-hour age in the queue; 3-hour Watch flag freshness | correctness (old posts are not news) | EWS:1180-1181; BQ:3349; WA:71 |
| Velocity warm-up per lane, lag rule, late-post rule | correctness (false spikes) | WR [RAN]; EWS:1286-1319 |
| One stop a day (2,000) | safety (owner's request) | C51 |
| The run-time ledger's steps | wall-derived (protects Burson's alerts) | C51; Engine tab |
| 40 characters / English-words proxy | kept this round (measured by S1) | EWS:128-130, 365-367 |
| Watch reach floor; Sonar's smart tag before the Watch's Gemini | kept this round (`AI.IF` volume vs the job wall) | PW:71-74, 559, 603 |

---

## 6. Not in this round, and why

1. **Review before posting, one queue for Story, Watch and Direct** (WL-1's full fix). It moves Watch and Direct reviews
   out of the B10 loop (Bot.gs:1806-1877), where V2's write-ups, notes and requirement line live; V2 section 4 already
   defers "Direct BigQuery cards reviewed before they are posted". S4 is the interim: no false busy, serious first,
   backpressure. Watch and Direct reviews stay one at a time (~3-4 a run when nothing else waits).
2. **Grouping in BigQuery (`VECTOR_SEARCH`) or a Cloud Run producer** (WL missing 1). The way past the Stage B,
   cache and parcel walls in one move, and it would take the heaviest work off the run-time quota Burson needs. It
   needs the bot to write vectors or signals to a table (today this path never writes, EWS:96) and a deploy surface
   beyond `clasp` (AGENTS.md 2.6): an owner decision with its own cost. The Engine tab's grouping time and carry
   counts say when it is needed.
3. **A Brandwatch-live feed through Cloud Run into a table** (WL-7): same reason.
4. **A single small post with no risk word judged alone.** Asking the quick look about every post would be ~22,000
   Sonar posts a day (PW:47) plus the new sources: ~77 M input tokens a day (22,000 x ~3,500), about 5-15x the
   Gemini input of the rest of the engine on a normal day (reviews up to ~31,000 tokens each, GEM:514-515), on a
   judgment checked only on 8 multi-account signals. `SINGLE_POST` for risk words first; its measured precision decides
   whether to widen.
5. **Short texts (under 40 characters) and the English-words proxy:** S1 reports their similarity; a change after.
6. **Brandwatch live for the Watch, news, blogs, reviews, LinkedIn** (SPEC Q9-Q10): the Watch's reader is a separate
   rewrite; LinkedIn has no text through the API.
7. **Cutting Sonar's 24-hour look-back cost** (WL-5): measured first (S0, Engine tab GB).
8. **Watch look caps above today's**: until the Engine tab records job time against posts; then a look is split into
   jobs per watch.
9. **Editing a posted card so it grows in place**: the bot never edits a posted Chat message today (no patch call).
10. **Positive posts as a trigger or context** (O5): settled by the owner.

---

## 7. What only a live deployment can prove

1. The account's daily run time, its type and reset time; the other scripts' share (S0, then C51).
2. Gemini, Vertex and Decisions quotas: whether 3-6 reviews side by side and 50 quick looks side by side draw 429s.
3. How many requests `UrlFetchApp.fetchAll` runs at once; UrlFetch calls a day against the quota.
4. Grouping time in Apps Script (the Engine tab's "group s"); a quiet check's seconds.
5. Real posts per source per check; each lane's lag; Sonar's blank usernames; Sonar's batching on one `received_at`.
6. The same-story labels per lane (a person, S1).
7. That Burson's pick-up time does not rise (p90 before and after each step).
8. That nothing new reaches S-F Burson: watch B25 and B26 for a day after each step.
9. The properties store's total and its free room.
10. BigQuery bytes a day at 5 minutes; the nightly and Tubular reads by change.
11. Real cards, dismissals, Watch alerts and Direct cards a day; whether the space stays readable on a real event.
12. Precision of early (2-4 account) and single-post cards, from the reviews and people's ratings.
13. What the 600,000 Brandwatch mentions a day count and who shares them.
14. The bill per unit (reviews with web search, quick looks, embeddings, `AI.IF`, bytes).

---

## 8. For the owner (one paragraph)

When you switch on the new Control row 51, the bot stops treating any source as second class: Tubular videos, the
nightly Brandwatch table, Sprinklr, Sonar, the AMIE table and Brandwatch's live feed can all start a story when their
posts are fresh, and one post or one person seen through two sources counts once. Before each new source is opened,
someone on your team spends about three hours marking pairs of its posts "same story or not", so the grouping is proven
on that source and not assumed. The bot looks every 5 minutes instead of 15, asks Gemini about a story from 2 accounts,
and acts on a single worrying post alone: through the Watch when it has reach, and as a single-post story when it is
small but carries words about a serious risk such as a data leak or self-harm. The review limits (10 an hour, 150 a day,
5 a check) are gone: Gemini looks at everything, the most serious go first, several reviews go out at once, and what
does not fit waits for the next check instead of being dropped. You will see more cards; on a big event day about 8 to
15 new cards an hour, with growth, related stories and quiet ones grouped in threads, and anything not posted is on the
new Engine tab or the Early Detection tab with its reason. Gemini, BigQuery and embedding use will rise several times
over; the price per call is not in the bot's records, so the first week's bill is read and the Control tab then shows
the day's cost. What stays limited, and why: Apps Script runs the bot at most one minute-long slot at a time and for a
limited number of hours a day across your account, so when the day's time runs short the bot slows its background work
step by step, serious stories last, and never Burson's alerts; Brandwatch's shared login allows 600 calls in 10 minutes
for everyone; Gemini has rate limits Google sets; the bot's cards that it has not yet reviewed are held at 3 so you
never see a raw, unreviewed card pile up; and Burson's rules for sending a Social Alert email do not change. One safety
stop remains: 2,000 background reviews in a day, about four times a busy day, so a fault cannot spend without end; if
it is ever hit, the Control tab says so in red and Burson's alerts carry on.

## 9. Questions for the owner

None. See A3 (the three questions the writer drafted are answered by the plan's owner or by the code).
