# Step notes: one brief for each remaining step, in build order

Each brief below is what an engineer was to be handed for that step. It names the parts of the plan files to read
and the changes that win over the plan. Where a brief mentions "a report that is not in the repository" or a
"handover", read the code that the earlier step left instead: the code and its tests are the record.

The plan files: `1_new_sources_plan.md` (steps 2a to 3b), `2_open_engine_plan.md` (steps S1 to S18),
`3_requirements_first_plan.md` (steps S19a to S19g, and changes to S1, S2, S3, S8, S11, S18),
`4_first_screen_plan.md` (step S19h).


## 1. src-2a

You build step 2a of the plan (Stage 2): the reader that asks Brandwatch for new mentions, never X, and hands them over as a parcel, in a new file apps-script-chat-bot/BrandwatchLive.gs (prefix bwl), with the query rows on the New sources tab. Read the plan's Q1, Q2, Q3 and Q12 in full, Q11's notes for row 49 and its log lines, Q13, the cases E17 to E23 of Q14 and its paragraph "The fake", the API map (map_bw-api.md) and the map of today's Brandwatch code (map_bw-code.md).

Changes to the plan's text, decided by the plan's owner on 17 Nov after the bot's owner rejected caps and a trial. They win over the plan wherever they differ (the reasons are in docs/build-plan/2_open_engine_plan.md, section A point A4 and the part of section O8 headed "Sections of the new-sources plan (1_new_sources_plan.md) to amend"):
 (1) No ceiling of mentions a day and no pacing for Brandwatch live: the setting bw_live_mentions_per_day, the pacing rule of Q3, the note "49 day's ceiling", the words "of 30,000" in notes and on the tab, and the pacing and day-ceiling parts of case E22 are NOT built. The day's mentions are still counted (BWL_DAY) and shown: "today: 2,310 mentions" in C49, and "2,310 of 600,000" on the tab (600,000 a day is what the owner's Brandwatch account allows). Kept as the plan has them: the bot's own 20 calls in 10 minutes, the pause when the shared login has used 450 of its 600, the rules for 429, 401 and other refusals, the parcel of 300 mentions a read.
 (2) How often it reads: the least time between two reads comes from one function, bwLiveEveryMs_(), which returns the setting bw_live_every_minutes (10) in milliseconds, so that a later change can make it follow a faster check without touching the reader.
 (3) No trial: the setting early_wave_new_trial_days has the default 0 (already so in your base). The trial's code stays and a value above 0 still works. Notes and tab texts about a trial appear only while a trial runs.
 (4) The Watch's AMIE source (stage 3) has no cap a day: watch_amie_per_day is NOT built. The source has a cap a look like every other source of the Watch (100, the old figure).
 (5) Stage 0's gate "a source slower than 2 hours is taken out of bw_live_sources" is no gate: nothing is taken out because of it; the live check's line stays a report.

After your step nothing calls the reader in a run: no Control row, no call in Main.gs, no job in Early Detection (those are step 2b's). What you build is complete and tested on its own through its entry point bwLiveRun_(runStart, switches), which never throws, which step 2b will call, and which does nothing at all (no Secret Manager read, no Brandwatch call, no property, no cache item, no tab) unless the switch edBwLive is ON in the switches it is given and Early Detection's own row is ON.

Build, each as its own commit where it can stand alone:
1. The shared fake the plan's Q14 describes, apps-script-chat-bot/test/fake_brandwatch.js (not test/fakes.js; not a switch_ file, so the runner does not run it by itself): Secret Manager, /metrics, /queries/summary (with lastModifiedUsername set to a .test address, to prove it is never kept), /data/mentions that really applies sinceAdded, orderBy, orderDirection, page, pageSize, pageType and queryId to a list of mentions, that can be told to ignore any one of them, to answer 400, 401, 403, 429 or 500, to send the call-count headers in any letter case and either form or not at all, and to be slow on the fake clock; every call recorded.
2. The queries: bwlQueries_() reads /queries/summary once a UTC day and keeps only id, name, contentSources and languages; the query rows on the New sources tab (Read, written OFF by the bot and never set ON by it, an ON/OFF dropdown; Query; Collects; Languages; Suggested; Mentions today; Posts used today), in NewSources.gs (step 1d made that tab: read its handover and keep its ownership rules); at most bw_live_queries_max ticked queries are read, the first by row, and the note says how many were left out; nothing is read until one is ticked; ticked queries stay ticked across OFF and ON.
3. The sources: bwlSources_(): the setting's names that today's /metrics answer also lists (read once a UTC day); twitter and anything that starts linkedin are refused by code even when a setting lists them; a source that gave no mention for a whole day is named on the tab.
4. The request: bwlRequestUrl_(o), pure, with every parameter of Q2; one fetch helper with no method and no payload (GET only); the token read at use with pwBwToken_ and never stored, logged or written; the Watch's own reader is not copied or edited, only its pure helpers are called.
5. A read, with every rule of Q2: when it may read (all but its place in the run, which is step 2b's), the two marks (taken and read), no gaps, no repeats within a read and across reads (the 24-hour post-key index of the new lanes: read step 1b's handover), the stall rule, the checks on every page, the first read after the switch goes ON, after a pause (never older than 2 hours, and the note says what was not read), several queries in one call and the split after a 400 that names the query list.
6. The parcel: its cache items and BWL_STATE as Q2 gives them; each row in the struct of Q4 with its text cut to 1,500 characters; and the three functions step 2b needs: take the waiting parcel for a job, say the job was collected (taken moves only then and the parcel is deleted), say the job failed (a parcel whose job failed twice is dropped, the mark moves past it, and the mentions lost are counted and said). Built and tested here, called by your tests.
7. Budgets (Q3 as amended): the ledger of the bot's own calls (20 in 10 minutes), the pause on the shared login's header (names in any letter case; "600/10m" and bare digits; a missing header shows "unknown"), 429, 401 (three in a row: hourly), any other refusal (an hour), BWL_DAY (the day's calls and mentions by the Eastern day; never cleared by OFF), and bwLiveOff_() (clears the marks, the parcel and this source's indexes; never the day's counts or the ticks).
8. Stops (Q2, Q11): X in an answer although none was asked for; "added since" ignored; the order ignored: the source stops, in the plan's words, until its row is turned OFF and ON; the marks move as the plan says.
9. Scrubbing: every text that came from outside passes the scrubbing function before it is stored, logged or noted (the token out, anything shaped like an address replaced): use the one steps 1c and 1d built if there is one , else build it as Q12 says.
10. The settings of Q11 marked stage 2 that the reader uses (bw_live_project_id, bw_live_sources, bw_live_queries_max, bw_live_page_size, bw_live_parcel_max, bw_live_every_minutes, bw_live_first_minutes, bw_live_calls_per_10min, bw_live_pause_at_used, bw_live_source_type_new), added the way commit c8970d1 added settings. Not bw_live_mentions_per_day.
11. The words for row 49: one function a state that returns the note of the plan's table (without the day's ceiling; "today: 2,310 mentions" where the plan says "2,310 of 30,000"), each whole within 200 characters with the warning first; and the log lines of Q11 in the same amended form. Step 2b writes them to the cell.

Tests in the new file apps-script-chat-bot/test/switch_bw_live.test.js, with the fake: E17; the parts of E18 that need no BigQuery job (the three functions of item 6, a cache item deleted between read and hand-over, a second read while a parcel waits); E19; E20; E21; E22's 20 calls in 10 minutes only; E23; and: nothing is read with no query ticked; the 21st ticked query is left out and said; with the switch OFF a call of bwLiveRun_ reads and writes nothing; the day's counts survive bwLiveOff_(); no pacing and no day's ceiling exist (after 40,000 mentions in a day it still reads).
Keep every stored value inside its limit in its worst case (cache items under 95,000 characters, properties under 8,800) and give the worst cases in your handover. Give the time one read costs in the harness, and say where a read may start late in a run (60 seconds before the hard stop; a second page only with 45).


## 2. src-2b

You build step 2b of the plan (Stage 2): Control row 49 with its notes, the call of the reader in a run, and the job that takes a parcel into Early Detection. Read the plan's Q2 ("When", the two marks), Q4, Q5, Q6 and Q7 (what AMIE skips while Brandwatch live delivers a network), Q11 (row 49, the notes table, "How the producer learns the switches", "Other lists"), Q12, Q13, and the cases E1, E3, E18 and E24 to E27 of Q14; and the handovers of steps 1a, 1c, 1d and 2a.

Changes to the plan's text, decided by the plan's owner on 17 Nov after the bot's owner rejected caps and a trial. They win over the plan wherever they differ (the reasons are in docs/build-plan/2_open_engine_plan.md, section A point A4 and the part of section O8 headed "Sections of the new-sources plan (1_new_sources_plan.md) to amend"):
 (1) No ceiling of mentions a day and no pacing for Brandwatch live: the setting bw_live_mentions_per_day, the pacing rule of Q3, the note "49 day's ceiling", the words "of 30,000" in notes and on the tab, and the pacing and day-ceiling parts of case E22 are NOT built. The day's mentions are still counted (BWL_DAY) and shown: "today: 2,310 mentions" in C49, and "2,310 of 600,000" on the tab (600,000 a day is what the owner's Brandwatch account allows). Kept as the plan has them: the bot's own 20 calls in 10 minutes, the pause when the shared login has used 450 of its 600, the rules for 429, 401 and other refusals, the parcel of 300 mentions a read.
 (2) How often it reads: the least time between two reads comes from one function, bwLiveEveryMs_(), which returns the setting bw_live_every_minutes (10) in milliseconds, so that a later change can make it follow a faster check without touching the reader.
 (3) No trial: the setting early_wave_new_trial_days has the default 0 (already so in your base). The trial's code stays and a value above 0 still works. Notes and tab texts about a trial appear only while a trial runs.
 (4) The Watch's AMIE source (stage 3) has no cap a day: watch_amie_per_day is NOT built. The source has a cap a look like every other source of the Watch (100, the old figure).
 (5) Stage 0's gate "a source slower than 2 hours is taken out of bw_live_sources" is no gate: nothing is taken out because of it; the live check's line stays a report.

Build:
1. Row 49: key edBwLive, the label and the OFF, waiting and ON texts of the plan's table (the waiting text also when no query is ticked), written OFF and never set ON by code; its help line; the addition to the row-19 help line; the live-ops tool's switch rows. No row moves and no existing row's text changes: in your base the help block ("How it works") is already at row 53, rows 49 to 52 are blank, row 49 is yours, row 50 is for the Watch's switch (stage 3) and row 51 for a switch of a later plan (leave both blank).
2. In Main.gs: bwLiveRun_(runStart, wanted.switches) in poll()'s finally right after the Watch's block, never in front of it, and bwLiveOff_() where a row that is OFF is cleared, beside the Watch's own OFF call and step 1a's.
3. The bwl job: the lane bwl (late form bwls) is in ewsLanes_ when row 49 is ON and a parcel waits. The parcel's rows go to BigQuery as the query parameter @bwl (an array of structs: the SQL text never holds a mention), through the shared gates of Q4 with Q1's rules (English by the tag and by the words when the tag is empty, not positive, names Google or comes from a Google query, small accounts, reposts out, the length), in the same fetchAll as the other jobs. The mark taken moves when the job is collected; a job that failed twice drops its parcel with a note of how many mentions were lost; a pending job blocks the next read. ewsLaneQuery_ stays pure (callable with no services).
4. What AMIE skips: while row 49 is ON and its reader is healthy, the networks it delivers are handed to the AMIE job as networks to skip, as the plan's Q6 and Q7 say; read what step 1c built for it and use it.
5. Each check: C49's note (the functions of step 2a), the log lines, and the tab's Brandwatch row and the query rows' counts.
6. The settings of stage 2 that the wiring uses. (The default of early_wave_new_trial_days is already 0 in your base, amendment 3: check it, change nothing.)
7. The live check: the bwl job's SQL as a dry run with three made-up @bwl rows, at the place step 0a left for it (read-only, as there).

Tests in switch_bw_live.test.js and switch_new_sources_control.test.js: E1 for rows 48 to 50 OFF as it stands after this step (the snapshot of the two request bodies; no Secret Manager read, no Brandwatch call); E3; E18 as a whole (read, parcel, job, collected, the mark moves; a cache item deleted between the read and the check is read again from Brandwatch; a pending job blocks the next read; two failures drop the parcel with its note); E24; E25 for row 49's notes; E26 with rows 48 and 49 ON in the one-space setup, beside a Mirror space and in the main flow; E27; and: with row 49 ON, a full run makes its Brandwatch read only after the Watch's block, and the Watch's own requests, results and timing are exactly what they are with the row OFF; with row 19 OFF nothing of it runs.


## 3. src-2c

You build two small steps of the plan (Stage 2). Read the plan's Q3 (the row "Every Brandwatch mention the bot reads, all features"), Q11 (the last sentence about C19 before the log lines) and the handovers of steps 2a and 2b.

Changes to the plan's text, decided by the plan's owner on 17 Nov after the bot's owner rejected caps and a trial. They win over the plan wherever they differ (the reasons are in docs/build-plan/2_open_engine_plan.md, section A point A4 and the part of section O8 headed "Sections of the new-sources plan (1_new_sources_plan.md) to amend"):
 (1) No ceiling of mentions a day and no pacing for Brandwatch live: the setting bw_live_mentions_per_day, the pacing rule of Q3, the note "49 day's ceiling", the words "of 30,000" in notes and on the tab, and the pacing and day-ceiling parts of case E22 are NOT built. The day's mentions are still counted (BWL_DAY) and shown: "today: 2,310 mentions" in C49, and "2,310 of 600,000" on the tab (600,000 a day is what the owner's Brandwatch account allows). Kept as the plan has them: the bot's own 20 calls in 10 minutes, the pause when the shared login has used 450 of its 600, the rules for 429, 401 and other refusals, the parcel of 300 mentions a read.
 (2) How often it reads: the least time between two reads comes from one function, bwLiveEveryMs_(), which returns the setting bw_live_every_minutes (10) in milliseconds, so that a later change can make it follow a faster check without touching the reader.
 (3) No trial: the setting early_wave_new_trial_days has the default 0 (already so in your base). The trial's code stays and a value above 0 still works. Notes and tab texts about a trial appear only while a trial runs.
 (4) The Watch's AMIE source (stage 3) has no cap a day: watch_amie_per_day is NOT built. The source has a cap a look like every other source of the Watch (100, the old figure).
 (5) Stage 0's gate "a source slower than 2 hours is taken out of bw_live_sources" is no gate: nothing is taken out because of it; the live check's line stays a report.

Step 2c: one count of every Brandwatch mention the bot reads, whatever feature reads it. bwCountMentions_(n, feature) in BrandwatchLive.gs adds to the day's count by feature (this reader, the Watch, Temp checks) in BWL_DAY, and is called with one line from the Watch's reader (ProactiveWatch.gs pwBwMentions_) and one line where Temp checks call /data/mentions (TempCheck.gs). C49 and the tab then say how many Brandwatch mentions the bot read today in all features (until this step they say "this reader"). The count never throws, and never changes what those two readers ask, read or return: their requests and results are byte for byte what they are at your base, and a property write that fails does not break them. Decide, and say in your handover, how the count lives with the rule that nothing new is stored while rows 48 to 50 are OFF: if that rule would be broken by counting while row 49 is OFF, count only while row 49 is ON and make the note say so ("since this row went ON").
Step 2d: Control C19's note ends " · ⚠️ a new source is failing (row N)" while a new source (row 48 or 49) is ON and failing, and only then. One call in BigQuery.gs where C19's note is put together (find it: the merged fix plan built that line, and its review fixes changed it; its tests pin its text and its sum). The ending comes after everything else, fits the note's length without cutting a number, names the lowest failing row, and never appears while no row of 48 to 50 is ON: then C19 is byte for byte what it is at your base.

Tests (in switch_bw_live.test.js and a new file for C19's ending): the count by feature across a day and at midnight Eastern; the Watch's and Temp checks' requests and results unchanged; a failing write; C19's ending appears when the AMIE read fails and when the Brandwatch read is refused, disappears when the source reads again, and is absent with the rows OFF; C19's other words, its numbers and its sum untouched (run the fix plan's own C19 tests).


## 4. src-3a

You build step 3a of the plan (Stage 3): every member of a carded Early Detection story is claimed in the alert memory. Read the plan's Q8 (the rule, and why: a post that is part of a story's card must not get a card of its own for the same thing) and Q10 ("Precondition").

Today a story's card claims its main post (find where: AlertMemory.gs and EarlyDetection.gs). After your step every post the card links is claimed too (its members as the card knows them: the post keys it stores), when the card is posted and when an update adds posts, so that the checks that ask the alert memory about a post (alertMemory_().seenPost: the Watch, the Direct BigQuery poll) find them. The card's text does not change, and nothing is claimed for a story that got no card.
Mind what the merged fix plan and its review fixes built on those same checks, and keep every bit of it: where stories go first, a story's card that sent no Social Alert is no post's own alert, for the Direct BigQuery poll and for the Watch (BigQuery.gs bqStoryCardRow_, bqOnlyStoryCards_ and bqStoryOnOwnPost_; WatchAlerts.gs pwStoryCardOnly_ and pwStoryNotes_); a story's card that went out as a Social Alert is an earlier alert on the posts it links (EarlyDetectionCross.gs edSharedPostAlert_, edWithSharedPost_). A linked post claimed by your step must be treated in each of those places exactly as the story's main post is treated today. Read those functions and their tests first, and say in your handover what you found.

Tests (a new file): a linked post of a story card that went out as a Social Alert gets no Watch alert and no Direct BigQuery card of its own, and gets the notes the fix plan built; a linked post of a story card that sent no Social Alert goes on as its own alert, as the main post does; an update that adds two posts claims them; the alert memory's stored size in its worst case; the golden records unchanged (if a golden scenario has such a post and its record would change, stop and say so in not_done: do not record it again).


## 5. src-3b

You build step 3b of the plan (Stage 3): the AMIE table back as a source of the Watch, behind Control row 50. Read the plan's Q10 in full, Q6 (the table, its columns, its rules), Q8 (the X status-id key), Q11 (row 50 and its texts), the cases E26 to E29 of Q14, the handover of step 1c (the AMIE job in Early Detection, its column check, its scrubbing) and of step 3a; and the code as it was before the table was dropped: git show ace865c^:apps-script-chat-bot/ProactiveWatch.gs (the source's entry and lines 597 to 649) and the Watch's tests at that commit.

Changes to the plan's text, decided by the plan's owner on 17 Nov after the bot's owner rejected caps and a trial. They win over the plan wherever they differ (the reasons are in docs/build-plan/2_open_engine_plan.md, section A point A4 and the part of section O8 headed "Sections of the new-sources plan (1_new_sources_plan.md) to amend"):
 (1) No ceiling of mentions a day and no pacing for Brandwatch live: the setting bw_live_mentions_per_day, the pacing rule of Q3, the note "49 day's ceiling", the words "of 30,000" in notes and on the tab, and the pacing and day-ceiling parts of case E22 are NOT built. The day's mentions are still counted (BWL_DAY) and shown: "today: 2,310 mentions" in C49, and "2,310 of 600,000" on the tab (600,000 a day is what the owner's Brandwatch account allows). Kept as the plan has them: the bot's own 20 calls in 10 minutes, the pause when the shared login has used 450 of its 600, the rules for 429, 401 and other refusals, the parcel of 300 mentions a read.
 (2) How often it reads: the least time between two reads comes from one function, bwLiveEveryMs_(), which returns the setting bw_live_every_minutes (10) in milliseconds, so that a later change can make it follow a faster check without touching the reader.
 (3) No trial: the setting early_wave_new_trial_days has the default 0 (already so in your base). The trial's code stays and a value above 0 still works. Notes and tab texts about a trial appear only while a trial runs.
 (4) The Watch's AMIE source (stage 3) has no cap a day: watch_amie_per_day is NOT built. The source has a cap a look like every other source of the Watch (100, the old figure).
 (5) Stage 0's gate "a source slower than 2 hours is taken out of bw_live_sources" is no gate: nothing is taken out because of it; the live check's line stays a report.

Build:
1. The source amie (name "Brandwatch alert feeds (AMIE)") in the Watch's US look, its SQL taken from ace865c^ with the plan's changes: the key and parameter names amie and @amie_from; read from 40 minutes before its mark, with the keys of the rows handed over in the last 24 hours kept as hashes in one cache item (pw:amie:k), so that a row that lands late is caught and none is sent twice; links kept as they come, and the X status-id key; stale after 2 hours; at most 100 a look to Gemini; no cap a day (amendment 4). The table's columns are checked before the source is read, the way step 1c checks them (use its functions), so that a changed table stops this source alone, with a plain reason on the Watch sources tab.
2. Row 50: key watchAmie, the label and texts of the plan's table, written OFF and never set ON by code, its help line; it needs row 34 ON. With row 50 OFF the Watch's SQL for every other source is byte for byte what it is at your base, and nothing names the AMIE table.
3. Watch alerts: the 7-day seen check for amie and bwm rows that the plan's Q10 asks for (read what it says and why), and one row for the source on the Watch sources tab, with the tab's existing words for an error and for a stale source.
4. The header of ProactiveWatch.gs and the tests of the approved tables, changed openly as step 1c changed them: the commit message says that the bot's owner asked on 16 Nov for this table to be read again.

Tests in switch_proactive_watch.test.js (the restored tests of ace865c^ under the key amie, changed where the plan changes the source) and switch_new_sources_control.test.js: E28; E29 without the day's cap; E26 with rows 48 to 50 ON; E27; and: a row that lands 30 minutes late is sent once; the X status-id key gives one Gemini row for AMIE's copy and the Brandwatch query's copy of one post; a post that step 3a claimed for a story card gets no Watch card from this source.


## 6. S2

You build step S2 of the plan: Control row 51, the run-time and outside-call record, the yield to Burson, the one safety stop and its derived ceilings, the guards, and C51. Its row in the plan's table of steps is your list: what it does, its files, its tests by name, what it must not change, what it amends; the sections that row cites say how. This step comes first and alone: every later step reads row 51 and the record through what you build, so your handover must give every function a later step calls (is the open engine on in this run; how much of the day's run time and outside calls are used and which step of the graded table applies; may a background review, a quick look, a card start now; count a background review; yield to Burson; the C51 text and how a later step adds its part to it), each with its signature and what it returns. Changes to the plan's row that win: (a) section A2 and A6 of the open-engine plan; (b) the row of S2 in section B4.1 of the requirements-first file: the record also counts every outside call (each request of a fetchAll), with the budget, Burson's reserve and the steps at 0.70 and 0.90; (c) section C2 of the requirements-first file: the account type is read by the bot once a day (only "workspace: true / false" is kept; no part of the address is stored, logged or written) and sets the budgets while the settings open_fetch_day and open_runtime_budget_hours are blank; (d) row 51 goes in row 51 of the Control tab: the help block is already at row 53 and rows 49 and 50 are other engineers', so no row moves; (e) row 51's ON text names only what is built at your commit (after your step: the day's safety stop and the run-time and outside-call guards); each later step that adds a capability extends the text and its test, and the final text is the one in the requirements-first file's B1 (136 characters). The record of run time and outside calls is the one thing that also runs with row 51 OFF: it only records, in poll()'s finally and before the lock is tried, and must never throw or cost a run more than a property read and a property write.


## 7. S3

You build step S3 of the plan: the Engine tab, the new endings on the Early Detection tab, and the skipped-check rows. Its row in the plan's table of steps is your list: what it does, its files, its tests by name, what it must not change, what it amends; the sections that row cites say how. Also the row of S3 in section B4.1 of the requirements-first file (the columns and the daily row its RQ8 lists: build the columns now, even where the step that fills them comes later; say in your handover how a later step writes its column). Mind what the fix plan's last fixes built: endings are counted once through edNote_, C19's sum is exact, and a signal the check put off is remembered and ended by a sweep (read fix_last.json and fix_last2.json).


## 8. S4

You build step S4 of the plan: the bot's own Watch and Direct cards never make Burson look busy; a serious story goes first; a new own card only while fewer than 3 wait unreviewed. Its row in the plan's table of steps is your list: what it does, its files, its tests by name, what it must not change, what it amends; the sections that row cites say how. Read the plan's WL-1 answer in section 1 and O4 "Background cards must not make Burson look busy". The loop that reviews the bot's own cards in the Auto-correct space is in Bot.gs; the fix plan changed code near it (the notes under cards, one post one email): read a report that is not in the repository: fix_G2.json's handover before you touch it.


## 9. S5

You build step S5 of the plan: ranking in place of the allowance: no refusal by a count, a queue of 24, a buffer of 300 in chunks, every unended row in 180 minutes, the seen map over up to 8 properties, 24 hours of stories told, the drain bounded by time. Its row in the plan's table of steps is your list: what it does, its files, its tests by name, what it must not change, what it amends; the sections that row cites say how. The fix plan's review fixes are the ground you build on, under row 51: a story turned away comes back (commit 2f02234), the seen map lives in three properties (6933d88), and the put-off signals are remembered in EARLY_DETECTION_DEFERRED and ended by a sweep with the exact endings the last fixes built (fix_last.json, fix_last2.json: read both handovers). Under row 51 the causes 'check', 'hour', 'hourOrdinary', 'dayReviews' and 'watchDay' stop being refusals and two causes take their place ('stop' and 'pace'); say exactly how the put-off list and its sweep behave under row 51 (the window is 180 minutes; the list's size) and keep "every signal read gets exactly one ending, counted once" true after every run. With row 51 OFF the allowance, its settings and its tests are untouched.


## 10. S6

You build step S6 of the plan: checks every 5 minutes under row 51, paced by the run-time record, with no per-check number shrunk. Its row in the plan's table of steps is your list: what it does, its files, its tests by name, what it must not change, what it amends; the sections that row cites say how. Use step S2's functions for the pace (10, then 15 minutes as the day's run time fills). The Engine tab (step S3) records the real gap between checks.


## 11. S7

You build step S7 of the plan: ingest capacity: embedding batches of 80 bounded by time with a carry for every lane, no daily embedding stop, the velocity accounts and the exclusions in chunks, a slice for grouping, 5,000 rows a lane with a cursor carry, the gap read. Its row in the plan's table of steps is your list: what it does, its files, its tests by name, what it must not change, what it amends; the sections that row cites say how. The new-lane rules already in your base built a carry for new-lane posts only and shares for embedding and the pool: read a report that is not in the repository: fix_src-lanes_round_2.json's handover and say in yours how your carry and order live with them under row 51 (step S10 removes the shares later; until then both must hold: with row 51 OFF and a new source ON, the new-lane rules are exactly what they are at your base).


## 12. S8

You build step S8 of the plan: velocity made correct: the late-post rule, the 60-minute lag rule, a warm-up per lane on its own baseline, lanes on rows, coverage per lane, one topic vocabulary. Its row in the plan's table of steps is your list: what it does, its files, its tests by name, what it must not change, what it amends; the sections that row cites say how. Also the row of S8 in section B4.1 of the requirements-first file ("big" posts warm as a lane family of their own; build the family so that step S19f only has to mark posts as big). The warm-up arithmetic was reviewed twice (WR-M1, WR-M2 in section 1): build the reviewers' scenarios as tests on the fake clock.


## 13. S9

You build step S9 of the plan: equal standing: freshness by the bot's own read time in place of the source's name, one platform rule, one post once (link key plus who), one person once, exclusions for every lane, per-lane bars, the reviewer's line, the Sources column. Its row in the plan's table of steps is your list: what it does, its files, its tests by name, what it must not change, what it amends; the sections that row cites say how. Section A1 of the open-engine plan wins over the row's "a lane only after its S1 labels": every lane has equal standing as soon as your setting is on; a lane not yet measured uses today's bars, with the one line for the reviewer and the Sources column. Read the bars from the script property OPEN_LANE_BARS when the setting open_lane_bars is empty (step S1 writes that property; a missing or malformed value means today's bars).


## 14. S10

You build step S10 of the plan: the new sources' rules amended: the trial, the lifted-story caps, the shares and the one-sided rules removed under row 51; Brandwatch read at every check; the AMIE table 5,000 rows with the mark. Its row in the plan's table of steps is your list: what it does, its files, its tests by name, what it must not change, what it amends; the sections that row cites say how. Read the open-engine plan's O8 ("Rules of the new sources built at 50aa822 that change" and "Sections of the new-sources plan to amend") and its section A4. Whatever of the new sources is in your base is what you amend (stage 1, the AMIE table, is there; the Brandwatch reader and the Watch's AMIE source are there only if their rows 49 and 50 exist in your base: look, and say in your handover what you found and what is left for whoever merges them later). With row 51 OFF the new-lane rules stay exactly as they are at your base.


## 15. S11

You build step S11 of the plan: quick looks for every candidate, side by side; Gemini asked about a story from 2 accounts; the raise rule that keeps brand risk; the wider hold-back; the precision measure. Its row in the plan's table of steps is your list: what it does, its files, its tests by name, what it must not change, what it amends; the sections that row cites say how. Also the row of S11 in section B4.1 of the requirements-first file: the function that sends many quick looks at once takes any question set and any input shape (step S19d will send single posts through it), and the story's early ask gains the Sensitive Topic question and one more reason to raise. The fast triage's pinned tests (the old bars) hold with row 51 OFF.


## 16. S12

You build step S12 of the plan: story reviews side by side (3, growing to 6) with the same-story check again before each card, answers stored before posting, a back-off on "too busy", and one at a time after a run died. Its row in the plan's table of steps is your list: what it does, its files, its tests by name, what it must not change, what it amends; the sections that row cites say how. Read section 1's WR-M7 and FL-F16 answers and O4 "Reviews side by side". The fix plan's four timelines of "one issue, one new Social Alert email" (a report that is not in the repository: fix_G2.json) must hold with reviews side by side: make them tests at a batch of 6.


## 17. S19a

You build step S19a of the plan: the code check, counted only: every post read is checked against the alert requirements that are numbers or lists. Its row in the plan's table of steps is your list: what it does, its files, its tests by name, what it must not change, what it amends; the sections that row cites say how. Your step is in the requirements-first file: section B4.2's row for S19a, with RQ1 and RQ2 in full, and section C. Nothing is posted, queued or reviewed because of your step: it reads, checks and counts.


## 18. S19b

You build step S19b of the plan: code passes reviewed and carded: a KOF's post, a 2,000+ post or Google's own post past 30 comments and 30% negative is reviewed alone and alerted once. Its row in the plan's table of steps is your list: what it does, its files, its tests by name, what it must not change, what it amends; the sections that row cites say how. Your step is in the requirements-first file: section B4.2's row for S19b, with RQ4 and RQ6 in full, B2.1's answers W-A1 to W-A13 and Q6, and section C.


## 19. S19d

You build step S19d of the plan: the quick look for single posts and quick passes, live from the first day. Its row in the plan's table of steps is your list: what it does, its files, its tests by name, what it must not change, what it amends; the sections that row cites say how. Your step is two rows of the requirements-first file built as one: section B4.2's rows for S19d and S19e, with RQ3, RQ7 and RQ8 in full, and section C1, which wins: there is no counting-only week and no second deploy; quick passes are live at the bar 0.35 under the setting open_quick_pass_live (default true; false gives the counting-only state with its C51 text), and everything S19d counts is counted from the first day. Build it in two parts, each its own commits: first the per-post look with its slice, its own guard kind and pause, its carry and its counts (no pass row yet); then quick passes into the list, their rank and places, the back-pressure, the bar guard and the daily audit of 20 failed posts. If the first screen's plan (the third plan file) exists, read its part "what changes in step S19d" and build the carry so that step S19h can put the screen in front without changing it.


## 20. S19h

You build step S19h of the plan: the first screen: many posts a call, in front of the one-post quick look. Its row in the plan's table of steps is your list: what it does, its files, its tests by name, what it must not change, what it amends; the sections that row cites say how. Your step is the third plan file, docs/build-plan/4_first_screen_plan.md: read it in full; it is built on section C3 of the requirements-first file.


## 21. S13

You build step S13 of the plan: the Watch: a single worrying post goes out alone when the pre-read says it matters. Its row in the plan's table of steps is your list: what it does, its files, its tests by name, what it must not change, what it amends; the sections that row cites say how. Read section 1's FL-F5 answer and O2's table. The requirements-first file leaves this step as written (its section B4.1) and later adds a one-check hold in step S19c: build nothing of that now.


## 22. S19c

You build step S19c of the plan: one path with the Watch, and growth: a flag waits one check for a queued pass; a post that grows past a tier after a "no" is reviewed once more. Its row in the plan's table of steps is your list: what it does, its files, its tests by name, what it must not change, what it amends; the sections that row cites say how. Your step is in the requirements-first file: section B4.2's row for S19c, with RQ6.


## 23. S19f

You build step S19f of the plan: every size grouped: stories made of every post that met nothing alone, whatever its size, and the words that said "small accounts". Its row in the plan's table of steps is your list: what it does, its files, its tests by name, what it must not change, what it amends; the sections that row cites say how. Your step is in the requirements-first file: section B4.2's row for S19f, with RQ5 in full (the table of words that say "small accounts" or "low-tier": every one, under the setting, with both parsers in the same commit).


## 24. S18

You build step S18 of the plan: "Why not this post?": the bot answers in the thread from what it holds. Its row in the plan's table of steps is your list: what it does, its files, its tests by name, what it must not change, what it amends; the sections that row cites say how. Also the row of S18 in section B4.1 of the requirements-first file (its texts come from RQ8; where the stores they read do not exist yet at your base, answer from the ones that do and say in your handover which texts wait for which step).


## 25. S19g

You build step S19g of the plan: misses counted: both error rates every day, by source and requirement, with each miss shown under its alert. Its row in the plan's table of steps is your list: what it does, its files, its tests by name, what it must not change, what it amends; the sections that row cites say how. Your step is in the requirements-first file: section B4.2's row for S19g, with RQ8 in full.


## 26. S14

You build step S14 of the plan: Direct BigQuery by time: every source read, 50 candidates ranked across sources, a card only while fewer than 3 wait unreviewed. Its row in the plan's table of steps is your list: what it does, its files, its tests by name, what it must not change, what it amends; the sections that row cites say how. The 500-engagement floor stays (section A3 of the open-engine plan). The fix plan changed the poll (C15's counts, the bigger-post rule, story notes: a report that is not in the repository: fix_G4_picked_up.json): its tests hold with row 51 OFF and its counts stay right with row 51 ON.


## 27. S16

You build step S16 of the plan: growth notes: a growing story shows its growth in its own thread. Its row in the plan's table of steps is your list: what it does, its files, its tests by name, what it must not change, what it amends; the sections that row cites say how. Read O3 row 12 and section 1's FL-F1 and FL-F8 answers. The note goes through the one helper for notes under cards and is outside its caps the way the fix plan's "final" requirement line and the watch's "Same story" reply are (a report that is not in the repository: fix_G1.json).


## 28. S17

You build step S17 of the plan: readability on a busy day: the hourly card for quiet stories, a related story as a reply only when the review names the card, spike notes in a story's thread. Its row in the plan's table of steps is your list: what it does, its files, its tests by name, what it must not change, what it amends; the sections that row cites say how. Read O6 and section 1's FL-F4 and "Event threads" answers.


## 29. S1

You build step S1 of the plan: the same-story check and the engine measurements, both run by hand and read-only. Its row in the plan's table of steps is your list: what it does, its files, its tests by name, what it must not change, what it amends; the sections that row cites say how. Read section A1 and A2 of the open-engine plan (they replace the labelling by a person and the "measure first, no code" step) and the row of S1 in section B4.1 of the requirements-first file (a band of big posts). Two functions in LiveVerify.gs, each run by hand in the Apps Script editor like verifyNewSourcesLive (read how that one is built and tested: a report that is not in the repository: fix_src-check_round_2.json), each read-only but for its own bot-made tab and, for the first, one small script property: (1) verifySameStoryLive(): samples and embeds as the plan's O1 "How it is measured" says, asks Gemini's quick-look service about every pair ("do these two posts tell the same story: yes / no / can't tell"; the two snippets only, links and handles removed), checks the judge first on the Sonar reference as A1 says, writes the bot-made tab "Same-story check" (with the blank "Your call" column that wins where a person fills it in) and stores the measured bars in the script property OPEN_LANE_BARS (JSON under 500 characters, with the date); run again it recomputes with any "Your call" entries. Nothing in a run of the bot reads that property yet (step S9 does). (2) measureEngineLive(): the report A2 lists, with no address, token or post text in it. Tests with fakes of your own (do not edit test/fakes.js): only GETs, dry runs, embedding calls and quick-look calls go out; the tabs are the bot's and a person's tab of the same name is untouched; no snippet holds a link or a handle; never X from Brandwatch; the judge that fails its reference check writes no bars.


## The checks to run against your own work after each group of steps

Do them as a skeptic would: assume the step is wrong until a test or a probe you ran shows otherwise.


1. The commits (messages: no Co-Authored-By, the session line last, no model name, no address) and the whole diff from the lane's base: anything outside the files the steps name? Was any existing test deleted, skipped or weakened?
2. ROW 51 OFF. Build a rich run of your own (the one-space setup and a setup with a Mirror space: several polls with Burson's alerts, stories forming, a Direct BigQuery card, a watch flag, a new source ON if the base has one) in copies of the lane's base and of its head and compare every Chat post, outbox row, email, Alert-log row, BigQuery and Gemini request, script property and cache value: with row 51 OFF they must be the same (step S2's run-time record is the one exception: it only records; check that it cannot throw, and what it costs a run). Both golden scenarios pass with their records untouched. Does anything in code turn row 51 or any switch ON?
3. Each step's own setting: with row 51 ON and that setting off, is that step off and only that step?
4. Burson's own alerts: in a run with row 51 ON and a Burson alert waiting, is it handled exactly as at the lane's base (same posts, same emails, at least as soon)? Can anything the lane added delay, queue, count or stop it? What happens to Burson's alerts when the lane's new work hits each of its walls (the day's run time, the outside calls, a "too busy" answer, the safety stop)?
5. For each step: build each test of its row yourself, independently (do not trust the builder's tests), and attack its rules with numbers: every answer in the plan's section 1 (and, for steps S19a to S19h, the requirements-first file's B2) that the step is the answer to: does the code really do what the answer says?
6. Every "no" has a row or a count, and no ending is counted twice or not at all: after every run of a long mixed day, do Control C19's numbers still add up and does each signal have exactly one ending?
7. Stored sizes in their worst case (each new or grown script property under 8,800 characters, cache value under 95,000, cell under 45,000), the property and cache reads and writes a quiet run adds, the Chat, Gemini, quick-look, BigQuery and Sheets calls a busy run adds, and the time added to a run.
8. Leaks and ownership: a full poll with everything ON in the one-space setup, beside a Mirror space and in the main flow: nothing new in the outbox, the relay, B25, B26 or an email; every new posted text is known as the bot's own and passes the leak guard; a tab of a person's with a new tab's name is never touched.
9. Every text a person reads, printed in each state with its length: plain words, the warning first, no number cut.
10. Mutation: break each new rule in your copy, one at a time, and see a test fail; name every rule that no test guards.
11. Run yourself, in your copy: the whole Node suite, pytest, the build check, the safety scan. A failure that also fails at the lane's base in a copy is not the builders'.


For the Brandwatch steps (2a to 2c) also:

1. The commits (messages: no Co-Authored-By, the session line last, no model name, no address) and the whole diff from the lane's base: anything outside the files the three steps name? Was the Watch's own Brandwatch reader edited beyond the one counting line?
2. Rows OFF. With rows 48 to 50 OFF, on a new Control tab and on one from before the change: no Secret Manager read, no Brandwatch call, no new property or cache item, exactly the BigQuery jobs of the lane's base with bodies byte for byte the same, C19 byte for byte the same; rows 11 to 48 and their texts as at the lane's base, row 49 written OFF, rows 50 to 52 blank, the help block at row 53 as at the lane's base (check a tab from before the new sources, one made at the lane's base, and a new one; nothing of a person's is overwritten). Does anything in code turn a row ON, or tick a query's Read?
3. The plan owner's changes: is there really no ceiling of mentions a day and no pacing anywhere (code, settings, notes, tab, tests): after 40,000 mentions in a day does it still read? Is the day's count still shown? Does the least time between reads come from one function? Is the trial's default still 0, as at the lane's base, and does a value above 0 still give a trial?
4. Row 49 ON, attack the reader with the fake, one by one: overlapping answers (each mention once); 1,250 mentions in the 5 minutes before the mark; "added since" ignored; the order ignored; X in the answer although none was asked (and try to make the bot ASK for X: a setting that lists twitter, a /metrics answer that lists it, a query whose sources are only X); a 400 that names the query list; 401 once and three times; 403 with a .test address in its body; 429; 500; a thrown fetch; a 10-second answer near the end of a run; each call-count header form and none. For each: the note's words, the marks, and that the next check's other sources are untouched.
5. The token and addresses: put the token and a .test address into every error text and every field of every answer: is either one in a property, a cache item, a cell, a log line, a BigQuery request, the parcel? Is every Brandwatch request a GET with no body? Is lastModifiedUsername kept anywhere?
6. The parcel and the job: the mark taken moves only when the job is collected; a cache item deleted between the read and the check; a pending job blocks the next read; two failures drop the parcel and say how many mentions were lost; the SQL text never holds a mention and no parameter ever holds SQL; the gates of the plan's Q1 and Q4 are all in the SQL (English both ways, not positive, names Google or a Google query, small accounts, reposts out, length); what AMIE skips while Brandwatch live is healthy, and that it stops skipping when Brandwatch live fails.
7. Where it runs: only after the Watch's block; the Watch's requests, results and timing with row 49 ON equal those with it OFF; what the read costs late in a run and whether it can push a run past its hard stop.
8. The notes of row 49 in every state, printed with their lengths: the warning whole and first within 200 characters; plain words; no promise that nothing is lost.
9. The tab: the ownership cases (a person's tab of that name, an empty one, a title one character off, protected, hidden); a Read cell is never written ON by code; ticks survive OFF and ON; cell sizes; its numbers equal the day record's.
10. Leaks: a full poll with rows 48 and 49 ON in the one-space setup, beside a Mirror space and in the main flow: nothing new in the outbox, the relay, B25, B26 or an email (no new-lane post's text, no query name, "AMIE" or "Brandwatch"). The golden tests pass with their records untouched.
11. Stored sizes (each new property and cache item in its worst case), the calls a day (Brandwatch, Secret Manager, BigQuery, Sheets), the time added to a run.
12. Steps 2c and 2d: the count never changes what the Watch's reader and Temp checks ask or return, and survives a failing write; how it lives with the rows-OFF rule; C19's ending appears only while a new source is ON and failing, and C19's numbers and sum are untouched (run the fix plan's own C19 tests).
13. Mutation: break each new rule in your copy, one at a time, and see a test fail; name every rule that no test guards.
14. Run yourself, in your copy: the whole Node suite, pytest, the build check, the safety scan. A failure that also fails at the lane's base in a copy is not the builders'.


For the Watch steps (3a, 3b) also:

1. The commits (messages: no Co-Authored-By, the session line last, no model name, no address) and the whole diff from the lane's base: anything outside the files the two steps name?
2. Rows OFF. With row 50 OFF (rows 48 and 49 ON or OFF): the Watch's SQL for every source byte for byte what it is at the lane's base, no request names the AMIE table from the Watch, no new property or cache item; rows 11 to 49 and their texts as at the lane's base; row 50 written OFF, row 51 still blank, the help block still at row 53. Does anything in code turn it ON?
3. Step 3a, the claim: every post a story's card links is claimed when the card is posted and when an update adds posts, and nothing for a story without a card. Then the meeting points with the fix plan, each as a timeline you build: a linked post of a story card that went out as a Social Alert, then a Watch flag on it, then a Direct BigQuery row for it (no second card, the notes as built); a linked post of a story card that sent no Social Alert, then the same two (each goes on as its own alert, as the main post does); the same in the other order. Is any alert lost, or sent twice, that was not at the lane's base? The golden records untouched.
4. Row 50 ON, attack the source: a row that lands 30 minutes late (sent once); the same row twice in the overlap; the cache item of handed-over keys gone (what repeats, and is it counted); the table missing a needed column, a column of another type, access refused (this source stops alone, with a plain reason on the Watch sources tab, and the other sources go on); no cap a day exists and the cap a look holds; the X status-id key (one Gemini row for two copies of one post); a post that a story card claimed gets no Watch card from this source.
5. The SQL as text against the plan's Q6 and Q10: staff and KOF feeds and rows out, news sites and bigger tiers as the plan says, positive rows out, English; no parameter ever holds SQL.
6. The approved-table change: exactly the tests and documents the plan lists, changed openly (the commit message names the owner's request); a .gs file that names any other table still fails the test.
7. Leaks: a full poll with rows 48 to 50 ON in the one-space setup, beside a Mirror space and in the main flow: nothing new in the outbox, the relay, B25, B26 or an email. Watch alerts from this source go only where Watch alerts go today.
8. Stored sizes, the calls and Gemini looks a day the source can add, the time added to the Watch's look against its job limit.
9. Mutation: break each new rule in your copy, one at a time, and see a test fail; name every rule that no test guards.
10. Run yourself, in your copy: the whole Node suite, pytest, the build check, the safety scan. A failure that also fails at the lane's base in a copy is not the builders'.
