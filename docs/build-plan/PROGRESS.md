# Progress

The first unticked step is the next one. Tick a step only when its tests pass and the whole suite passes, and add
one line under it: what was built, the suite's count, and anything left out with the reason.

## Done

- [x] **The first build** (Early Detection you can see, the Alert requirements line, notes under cards, one post one
      email, the documents).
- [x] **0a** The read-only live check `verifyNewSourcesLive`.
- [x] **1b** The rules for new lanes inside Early Detection's source.
- [x] **1a** Control row 48 and the seam to Early Detection.
- [x] **1c** The AMIE job.
- [x] **1d** The "New sources" tab and C48's notes.
- [x] The two lines merged; the help block at row 53; no trial by default.

## To do, in this order

### New sources (plan 1; briefs 1 to 5 in STEP_NOTES.md)
- [x] **2a** The Brandwatch reader
      Built `BrandwatchLive.gs` (entry point `bwLiveRun_`, the parcel's three functions for 2b, `bwLiveOff_`, row 49's
      words in `bwlNote_`), the query list with the owner's ticks and Brandwatch's row on the New sources tab
      (`NewSources.gs`), ten `bw_live_*` settings, the fake `test/fake_brandwatch.js` and 14 tests in
      `test/switch_bw_live.test.js`. Suite: 1,205 of 1,205 passed. Choices where the plan was silent: the first read sets
      `taken` to where it starts (so a lost first parcel is read again); the overlap's ids are kept with the parcel and
      count only once it is handed over; a parcel of 300 mentions with 1,500 characters of words can be larger than 6
      cache items, so the read then hands over fewer and the next read starts after the last one handed over; Brandwatch
      down or slow (5xx, no answer) is tried again at the next read, any other refusal waits an hour.
- [x] **2b** Control row 49 and the wiring into Early Detection
      Built row 49 (`edBwLive`, written OFF and never set ON, its help line and the row-19 help addition, the live-ops
      tool's switch rows), `bwLiveRun_` called right after the Watch's block with `bwLiveOff_` while the row is OFF, the
      job `bwl` that takes the parcel into Early Detection's next check (the mentions only in `@bwl`, the shared gates,
      the mark moved when the job is collected, the parcel dropped after two failed jobs), what the AMIE job skips while
      Brandwatch live reads, C49's note after each read and check, the dry run in `verifyNewSourcesLive`, and the README.
      Suite: 1,215 of 1,215 passed. Choices: AMIE leaves Brandwatch's networks to it only while row 49 is ON, it is not
      stopped and its last read that answered is under an hour old (the plan's Q6 words); the help area grew from 48 to
      49 rows (the help still starts at row 53); with no query ticked C49 shows only the ON text's waiting words (the
      note no longer repeats them); the "no mentions for N h" warning adds the plan's "(usually about N an hour)" from
      yesterday's count when there was one.
- [x] **2c** One count of every Brandwatch mention; C19's warning when a new source fails
      Built `bwCountMentions_` (BrandwatchLive.gs; one line in the Watch's `pwBwMentions_`, one in Temp checks after its
      two reads of mentions; the reader counts its own as it reads), shown in C49 ("the bot read N Brandwatch mentions
      today, all features"), the log line and the tab's "all features" slot; and C19's ending " · ⚠️ a new source is
      failing (row N)" (`nsrcFailingEnd_` in NewSources.gs, one call in BigQuery.gs `noteEarlyWave_`). New file
      `test/switch_ed_c19_new_sources.test.js`. Suite: 1,222 of 1,222 passed. Choices: the count runs only while rows 49 and
      19 are ON, so rows OFF store nothing new (the plan's E1 and E3); it says "since this row went ON" until it has run
      over midnight Eastern, then "today", and stops (its numbers go, the reader's own day counts stay) when row 49 goes
      OFF or waits for row 19; C49 shows it only when the Watch or Temp checks read some, so it never repeats the
      reader's own number. Failing, for C19: the AMIE table stopped, paused or failing; Brandwatch live stopped,
      failing, or paused because Brandwatch refused the key or the read (a wait for the shared login or a 429 is not a
      failure). To keep every number whole, `edDayNoteText_` takes the ending as an option and keeps room for it (with
      no ending its text is unchanged), beyond the one call the brief names.
- [ ] **3a** Every post of a carded story is claimed
- [ ] **3b** Control row 50: the AMIE table as a source of the Watch

### Open engine (plan 2; briefs 6 to 16)
- [ ] **S2** Row 51, the record of run time and outside calls, the safety stop, the guards, C51
- [ ] **S3** The Engine tab and the new endings
- [ ] **S4** The bot's own cards never make Burson look busy
- [ ] **S5** Ranking in place of the allowance
- [ ] **S6** Checks every 5 minutes
- [ ] **S7** Ingest capacity
- [ ] **S8** Velocity made correct
- [ ] **S9** Equal standing
- [ ] **S10** The new sources' rules amended under row 51
- [ ] **S11** Quick looks for every candidate, from 2 accounts
- [ ] **S12** Story reviews side by side

### Requirements first (plan 3, and plan 4 for S19h; briefs 17 to 25)
- [ ] **S19a** The code check, counted only
- [ ] **S19b** Code passes reviewed and carded
- [ ] **S19d** The quick look for single posts, and quick passes, live from the first day (the plan's S19d and S19e together)
- [ ] **S19h** The first screen
- [ ] **S13** The Watch: a single worrying post goes out alone
- [ ] **S19c** One path with the Watch, and growth
- [ ] **S19f** Every size grouped
- [ ] **S18** "Why not this post?"
- [ ] **S19g** Misses counted

### The rest (plan 2; briefs 26 to 29)
- [ ] **S14** Direct BigQuery by time
- [ ] **S16** Growth notes
- [ ] **S17** Readability on a busy day
- [ ] **S1** The same-story check and the engine measurements, run by hand

### Closing
- [ ] A look at the whole change as a skeptic (the checks at the end of STEP_NOTES.md, over everything built)
- [ ] `apps-script-chat-bot/README.md` and the Control tab's help say what was built
- [ ] Final runs: the whole Node suite, the Python tests, the build check, the safety scan

## Left out, and why

(nothing yet)

## What only a live run can prove

- Brandwatch: that it honours "added since", oldest-first order, the list of sources, `language=en`, reposts out and
  new mentions only in one request; the real names and form of the shared login's call-count headers; the shape of
  `/metrics`' list of sources; how long after posting it adds a mention; whether Reddit mentions come with their words.
- That a parcel of full-length mentions fits the script cache as measured in the harness (6 items of 90,000 characters).
- That the `bwl` job's SQL runs in BigQuery with a real array of structs as `@bwl` (the live check's dry run with three
  made-up mentions shows it compiles), and how long a Brandwatch read takes late in a real run.
