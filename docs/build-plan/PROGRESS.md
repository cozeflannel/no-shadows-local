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
- [x] **3a** Every post of a carded story is claimed
      Built `notePosts` in the alert memory and `edNoteMembers_` in `edAct_` (EarlyDetection.gs): every post a story's
      card links, an update's new posts too, is seen by that card's Alert-log row as its main post is, only once the
      card is in the space. New file `test/switch_ed_claim_members.test.js`. Suite: 1,229 of 1,229 passed. What I found:
      a producer's `claim()` (the plan's word) makes `seenPost` answer "claimed", which the Direct BigQuery poll and the
      Watch take for the post's own card (`bqOnlyStoryCards_` is false), so a linked post would not be treated as the
      main post; it is noted as seen by the card's id instead, and then every check the fix plan built (where stories
      go first, `bqOnlyStoryCards_` / `pwStoryCardOnly_`; a card that went out as a Social Alert is the alert on it)
      treats it exactly as the main post. But the fix plan's own tests pin the opposite for linked posts today (a linked
      post is never "already alerted": its own Direct BigQuery card and note in every setup, and a Watch alert whose
      review sends no second email), so with the claim always on, 9 of them fail. Choice, from rule 2 (each step behind
      its switch and its own setting) and the plan's precondition ("before stage 3 is switched on"): the claim acts only
      while Control row 50 (key `watchAmie`, built in 3b) is ON and the setting `early_detection_claim_members` (true) is
      on. With row 50 OFF the bot is as it was and every fix-plan test passes unchanged; with it ON a linked post is the
      main post's equal (where stories do not go first, it then gets no Direct BigQuery card of its own). Left as it is:
      the memory rebuilt from the Alert log (its tab lost) learns only main posts, as the row keeps only record keys; a
      linked post of a story whose email went out is "seen" for 24 hours (or the window a late source asks), not
      "emailed" for 14 days as the main post is.
- [x] **3b** Control row 50: the AMIE table as a source of the Watch
      Built row 50 (`watchAmie`, written OFF, needs row 34, its help line) and the Watch's source `amie` ("Brandwatch alert
      feeds (AMIE)", US look, its SQL from `ace865c^`'s BMIE source with the plan's changes): read from 40 minutes before
      its mark, the keys of the rows handed over in the last 24 hours kept as hashes in `pw:amie:k` (at most 5,000, under
      95,000 characters) and left out when read again, one row a post by its key (the X status-id key), 100 a look, no
      cap a day, stale after 2 hours, its columns checked first with step 1c's `ewsAmiMeta_` (a changed table stops this
      source alone, its row on the Watch sources tab says why). While row 50 is ON a flag from it or from Brandwatch's
      mentions table asks the alert memory about 7 days. OFF forgets its check, keys, mark and numbers. Suite:
      1,238 of 1,238 passed. Choices: the source is added by `pwSources_()` only while row 50 is ON (last on the tab), so
      with it OFF every look's SQL, every tab and mark is byte for byte as before; the X status-id key and the key rows a
      look returns (kind `amk`) are in a look only with the source; the first look reaches an hour back and never more
      than 6 hours (step 1c's figures, the plan gives none); the 7-day check is behind row 50 too, as it changes what the
      Watch does for Brandwatch's mentions table; the tab's existing error words say "tried again at the next look" also
      for a stop for the day.

### Open engine (plan 2; briefs 6 to 16)
- [x] **S2** Row 51, the record of run time and outside calls, the safety stop, the guards, C51
      Built Control row 51 (`openEngine`, written OFF, needs row 19, its help line, C51) and `OpenEngine.gs`: the record of
      run time and outside calls (`RUN_LEDGER`, row 51 OFF too, only records: 24 hourly buckets of run seconds, outside
      calls with each request of a fetchAll counted once, runs, and starts that found the lock taken; a run that died,
      from its claim's start; Burson's pick-up times and its busiest pass; at most 8,800 characters; one property read
      and one write a run; never throws) and, under row 51, the day's safety stop with its derived ceilings (`OPEN_DAY`),
      the graded steps on run time and on outside calls, Burson's reserve, yield to Burson and the pick-up gauge,
      ApiGuard's runaway ceilings, the 10-minute wait after a 429, the web search off for background work only, C51 and
      C19's ending `safety stop reached`. Suite: 1,267 of 1,267 passed.
      For later steps (each never throws; what each returns is in `OpenEngine.gs`'s header): `openOn_()`,
      `openUsage_(now)`, `openMayStart_(kind, ctx, o)` -> `{ok, why, wall}` (kind 'review', 'card', 'quick', 'batch';
      `o.serious`), `openCountReview_(n)`, `openCount_(kind, n)` ('ql', 'wc', 'gb'), `openStopReached_()`,
      `openSerious_(row)`, `openYield_(ctx)`, `openShrinkMs_(usage)`, `openWall_(name)`, `openC51Text_(now)`,
      `openC51Add_(fn)` (fn(usage, day, now) -> a short part), `openFetches_()` and `openBursonPass_(before)`.
      C51's texts (characters): ON 113, waiting 67, OFF 72 (and, once a minute is recorded, `run time today: 1 h 20 of
      4 h 30 (last 24 h) · Burson pick-up 40 s (p90)`), the stop 168, the quick-look ceiling 153, run time ahead of pace
      105 and nearly used 95, outside calls ahead of pace 96 and nearly used 98, the day's line 85; every state at most
      200, the warning first. Choices: (1) the guard asks where background work starts today: Early Detection's drain (a
      review counted when it is sent, a failed one too), the Watch's pre-read (one call is one background review; serious
      = a KOF's or a 2,000+ post's flag), the Direct BigQuery poll (no check past the stop, from the 0.90 step, or with a
      Burson alert waiting), the story quick look in Decisions ('quick', counted toward the 20,000), and the Other alerts
      space's triage (counted; past the stop left for a person, with the reason; the pace steps and the yield are not
      put on it, since it is an alert flow of its own); (2) the stop and the steps need row 19 too (the plan: "only while
      row 51 is ON (and row 19 is ON)"); (3) a wall is counted once a run (C51's "Burson first 3×" is three runs);
      (4) Burson's reserve of outside calls (requirements-first F-P1): twice its busiest pass of the last 7 days, at
      most half the day's calls, off the budget first; (5) the account type: a consumer account is tested on its
      domain alone, since the rules allow made-up addresses only on .test and the safety scan refuses any other, even
      one put together at run time. Left out, and why: the Direct poll's serious-only rule between 0.80 and 0.90 (the
      poll is gated as a whole; step S14 rebuilds it by candidate); counting the reviews of the bot's own Watch and
      Direct cards in the Auto-correct space (telling them from Burson's copies there is step S4's); the per-post quick
      look's own ceiling, min(150 x the stop, half the call budget) (step S19d builds that look); the pick-up gauge on
      the Engine tab (step S3 builds the tab).
- [x] **S3** The Engine tab and the new endings
      Built, under row 51 only: `EngineTab.gs` (the bot-made tab `Engine`, A1 its 111-character title, one row a check
      and a row a day, newest first, 7 days kept, every cell a number or at most 100 characters; never a tab the bot did
      not make, and C51 says when one is in the way); on the Early Detection tab the reasons `today's safety stop of 2,000
      reviews was reached (Burson's alerts went on)` and `the day's run time was nearly used, so only serious stories were
      reviewed` for a signal that waited out its 3 hours while reviews were held, a `Check skipped` row when a due check
      is not made (Burson's alerts waiting, ApiGuard, the run time nearly used; the check itself now waits from the 0.97
      step), and the `Asked early (2-4 accounts)` summary row (`edAskedEarlyNote_`); none of these rows counts in C19's
      numbers. The tab's write is kept in the run's time before the reviews, and the rows that wait are kept in up to 10
      cache values with their counts in `ED_TAB_WAIT_MAN` (a dropped value is counted as not recorded); C51 says how many
      wait once they pass 200. The SLRR alerts table's two rules are written beside its name and tested. Suite:
      1,279 of 1,279 passed.
      How a later step writes its Engine column: `engAdd_(key, n)` at the place it counts (a number, summed until the
      next check's row) or `engSet_(key, text)`; the keys are in `ENG_COLS_` (`carried`, `lost`, `groupN`, `groupS`,
      `batch`, `batchS`, `cardsWait`, `gb`, `aiif`, `grounded`, `evict`, `qRaised`, and RQ8's `alone`, `codePass`,
      `gated`, `asked`, `qPass`, `failed`, `notReached`, `quickS`, `tokens`, `refused`, `codeMs`); the daily row's line
      is `engDayNote_`. The `ranked` reason (`it waited 3 hours while N more serious stories were reviewed first`) is in
      `edNeverWhy_` for step S5. Choices: (1) the rows that are no ending (`Check skipped`, `Asked early`) are laid out on
      the tab but never go through `edNote_`, so C19's sum is untouched; (2) a skipped check is said once for each due
      check; (3) the Engine tab's numbers between checks and the day's sums live in one property, `ENGINE_ACC`, with at
      most 12 rows waiting (the rest counted in a `not recorded` row). Left out, and why: the `Sources` column (step S9
      builds it: the posts carry no source today); `Single post` as a kind (step S19b); `Update noted in its card's
      thread` (step S16's growth notes); the early-ask summary's caller (step S11 makes the early asks); the daily row's
      faster / wider / accurate measures (they need the later steps' records: the row gives the day's sums and a line).
- [x] **S4** The bot's own cards never make Burson look busy
      Built, under row 51 in the Auto-correct space (Bot.gs, AutoCorrect.gs, WatchAlerts.gs, OpenEngine.gs): a Watch alert
      or Direct BigQuery card the bot posted that waits (the run's count of messages, a hold, its time) sets
      `report.bg_backlog`, never `analyst_backlog`, `held` or the time-budget error, and the cards it reviewed
      (`bg_handled`) are not counted in the flow's count of messages, so `slaBusy` stays false while only the bot's own
      cards wait; one at the count no longer stops the loop; an ordinary one (Watch: no KOF, 2,000+, P0 / P1 tag or
      Sensitive Topic; Direct: no KOF or 2,000+: `openCardSerious_`) waits for the next run while the story queue's next
      signal is serious (`ser`), or while a due Early Detection check needs the rest of the run (`openCheckRoom_`: the
      check's 30 s, a review's 90 s and a card's 40 s); the Watch posts a new card there only while fewer than 3 of the
      bot's own cards wait unreviewed (`pwAlertsMax_`, from `report.bg_waiting`; the 2 a run goes there), and the Direct
      poll already counted Watch cards in its 3 (`bqDirectWaiting_`). Suite: 1,286 of 1,286 passed. Choices: (1) the room for
      a due check (not in the plan's four points) was added because 30 cards at about 20 s each used the whole run
      before the check could start, so the story waited two runs; with it the story is reviewed within one run of its
      signal, as point 4 asks; (2) a person's sheet test in the space is handled as Burson's alerts (not a bot card).
      Left out, and why: a test for a person's message after the bot's own cards once the count is reached (the loop now
      goes on to it instead of stopping): in this setup Burson's alerts are handled before this loop and sheet tests
      at its start, so nothing of Burson's can be behind the cards; whether a Direct candidate not posted for want of
      room is marked as posted is left to step S14, as the plan says.
- [x] **S5** Ranking in place of the allowance
      Built, under row 51 in the allowance's flow (BigQuery.gs, EarlyDetection.gs, EarlyWaveSource.gs, OpenEngine.gs):
      the causes `check`, `hour`, `hourOrdinary`, `dayReviews` and `watchDay` are no refusals; in their place `stop`
      (the day's safety stop), `pace` (run time step 4, ordinary signals) and `ranked` (the queue of 24 full, ordinary
      signals); each waits unmarked in the list of signals left for a later check (`EARLY_DETECTION_DEFERRED`, at most
      150, codes `s`, `p`, `r`, the full queue's count kept with `r`) and ends only when it would leave the producer's
      180 minutes (`edAgesOut_`), with `it waited 3 hours while N more serious stories were reviewed first` and the
      stop's and pace's words; serious first as before; the queue holds `open_queue_max` (24), and a serious signal may
      take up to 4 places more, so an ordinary one is not pushed out for it (a fifth serious one at a full queue still
      pushes the lowest-ranked one out, ending "pushed out" as before: with more places the stored rows' worst case would
      pass 300 KB, `switch_open_storage.test.js`); the check reads every signal not yet ended in the 180
      minutes (up to 300) and the producer's buffer keeps 300 rows in several cache items (`bf:N`, their counts in its
      state; a dropped one counted lost on the Engine tab); the drain has no count a run. "Every signal read gets exactly
      one ending, counted once" holds: a waiting signal has no ending until it is queued or leaves the window. Suite:
      1,292 of 1,292 passed. Left out, and why: the seen map over 8 properties and the producer's stories told for 24 hours
      in chunks (the seen map's three properties and the 60 stories told stay as the fix plan built them: with the queue
      and checks of this step they hold, and step S7's carry is where the producer's items grow; a day's real counts
      are a live-only number); "150 s of the flow left" for a batch (step S12 makes batches; a single review keeps the
      90 s it has, plus the tab's 30 s from S3).
- [x] **S6** Checks every 5 minutes
      Built, under row 51: Early Detection's check every `open_check_minutes` (5), paced by the record of run time
      (`openCheckMs_`: every 10 minutes from 0.60 of the day's budget, every 15 from 0.70), the producer's own interval a
      minute under it (`openProducerMs_`), Gemini Decisions' pause after a failure one check's interval, the age rule
      and the "Check skipped" rows on the same interval; C51's day part says `checks every N min`; row 51's ON text is
      now `✓ ON: checks every 5 min, the most serious go first; one safety stop a day, and the day's run time and outside
      calls guarded so Burson's alerts keep their share` (152: the checks and S5's order put first) and its help line
      says so. No per-check number changes. Suite: 1,296 of 1,296 passed. Choices: C19's ON text still says "every 15
      min" (rule: no existing Control row changes its text); the Engine tab's "Gap (min)" column (S3) gives the real gap
      between checks. Changed expected texts: row 51's ON text and C51's day part in switch_open_engine; a check "not
      due" in switch_ed_tab's row-51 test is now 2 minutes old.
- [ ] **S7** Ingest capacity (built in part: see below; left unticked)
      Built, under row 51 (`openEws_`): 80 texts an embedding call (Vectors.gs), no count of 400 embeddings a check or
      20,000 a day (the check's own time bounds them), up to 5,000 posts a lane a read (real-time and slow), and up to 50
      signals of a kind a check (`ewsPromote_`, `ewsVelocity_`). With row 51 OFF and a new source ON, the new lanes'
      rules (their carry, their shares of embedding and the pool) are exactly as at the base. Suite: 1,300 of 1,300
      passed (`switch_open_capacity.test.js`). Left out, and why: the carry of posts not embedded for every lane, the
      chunked `acc` and `x`, Stage B's slice with its `nd` carry, the cursor carry at the last complete timestamp and the
      gap read of up to 24 hours at 2 hours a check. Each changes how the producer stores and re-reads its own state
      (EarlyWaveSource.gs, its marks and cache items). Built without them, a check that runs out of time would lose its
      posts silently. Built hastily, they could lose or double-count posts on the live tables, which the tests here
      cannot show. They need a step of their own with the producer's state tests (switch_early_wave_source) extended
      first. Until then, under row 51, posts the check has no time to embed are dropped from that check as today (only
      the new lanes carry theirs), and a lane's 5,000 rows have no cursor carry.
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
- That Apps Script lets the bot wrap `UrlFetchApp` for a run, so outside calls are counted (if not, the record says
  so, C51 shows no call count and only the run-time guard acts); the account's real daily trigger run time and outside
  calls (Google's figures as the plan remembered them, not verified); what a run that found the lock taken really costs.
- That `Session.getEffectiveUser().getEmail()` answers in a trigger run of this deployment (if it throws, the bot takes
  the lower budgets, 1.5 hours and 20,000 calls, until the settings are filled in).
