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
- [ ] **2b** Control row 49 and the wiring into Early Detection
- [ ] **2c** One count of every Brandwatch mention; C19's warning when a new source fails
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
