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
- [ ] **S8** Velocity made correct (built in part: see below; left unticked)
      Built, under row 51 with the setting `open_velocity_fix` (true): points 1 and 2 of the plan's velocity section. A
      post whose hour was already counted for good (a late post) gives no velocity row, and a post the bot read more
      than `open_velocity_lag_minutes` (60) after it was posted gives none, so the baseline and the current count hold
      the same kind of posts (`ewsVelocityCounts_`). With row 51 OFF, or the setting false, velocity is as before. Suite:
      1,302 of 1,302 passed (`switch_open_velocity.test.js`). Left out, and why: points 3 to 7 (each lane family's own
      warm-up baseline in `EWS_ROLL_<lane>`, rows that know their lanes, coverage per lane, one topic vocabulary with
      split topic properties, and the requirements-first file's `big` lane family). The plan puts "storage first": an
      `acc` row gains a field, so `acc` must be chunked first (step S7), and S7's chunking is left out (see S7). Without
      it a bigger row would fill the one cache item sooner and lose velocity rows. The reviewers' warm-up scenarios
      (WR-M1, WR-M2) wait for those points.
- [ ] **S9** Equal standing (built in part: see below; left unticked)
      Built, under row 51 with the setting `open_equal_lanes` (true): freshness by the bot's own read time in place of the
      source's name (`ewsLate_`: a post read more than `open_fresh_minutes`, 180, after posting is late; a fresh one of
      any source, Tubular's and the nightly table's too, may start a story in Stage B, a late one only joins; the
      embedding order puts fresh before late); each of a signal's posts carries its source (`ewsRepsJson_`, kept
      through the queue by `edRepPosts_`); the reviewer's line ("Most of these posts come from Tubular, where the
      same-story grouping has not been checked yet: weigh whether they really tell one story.") in the story review
      when most posts come from a source not yet checked (Sonar and Sprinklr comments are; a source with measured bars
      from `open_lane_bars`, or the property `OPEN_LANE_BARS` when the setting is blank, is); `openLaneBars_` reads
      those bars (a malformed value means today's bars). Velocity keeps the slow lanes' meaning (S8's warm-up is not
      built). Suite: 1,306 of 1,306 passed. Left out, and why: the measured bars used in the grouping itself (each
      comparison would need its post's source; the bars exist only once step S1 has run live), the one platform rule
      with `Web`, one post once by link key plus who with its copy rules, one author function, exclusions and big
      authors for every lane, the alert memory's marks, Tubular and the nightly table read on change, and the Sources
      column on the Early Detection tab. Each changes the producer's SQL, its stitching or its stored state (the same
      ground as S7's carry), and none can be checked against the live tables here.
- [ ] **S10** The new sources' rules amended under row 51 (built in part: see below; left unticked)
      What the base has: all three new sources (rows 48-50: the AMIE table for Early Detection, Brandwatch live, the
      Watch's AMIE source), so all are amended here. Built, under row 51: no trial (whatever
      `early_wave_new_trial_days` says), no cap on the stories only a new source lifts, no share of the embeddings or the
      pool for the new lanes and no day's pace for them (`ewsNewCfg_`, `ewsEmbedSplit_`); the new lanes' lateness rule,
      the pool's age and their carry stay; Brandwatch live read at every Early Detection check (`bwLiveEveryMs_`: the
      producer's interval, a minute under the check's); the AMIE table read 5,000 rows a check from its mark. With row 51
      OFF the new-lane rules are exactly as at the base (switch_ed_new_lanes unchanged). The Brandwatch reader's day
      ceiling and pacing were never built (A4). Suite: 1,309 of 1,309 passed. Left out, and why: the one-sided rules of
      50aa822 (platforms only from today's lanes, one-sided exclusions, today's copy always wins): they give way to S9's
      one platform rule and its copy rules, which are left out with S9's stitching.
- [ ] **S11** Quick looks for every candidate, from 2 accounts (built in part: see below; left unticked)
      Built, under row 51: no count of 15 quick looks a check or 150 / 300 a day (`decSkipWhy_`; the day's quick-look
      ceiling, ApiGuard's runaway ceilings and the run's time bound them); `decisionsAskMany_` (any question set, any
      input shape: step S19d sends single posts through it) sends a batch side by side in one fetchAll, each call
      counted before, a failure pausing nothing unless more than half the batch failed; `decSignalAskAll_` and
      `ftAskAll_` ask a check's candidates in batches of up to 50 before the loops, which read the answers back and ask
      nothing again; a blank B45 reads 2 accounts; the early watch's raise rule (about Google and brand risk at the watch
      bar, medium-or-worse severity at the confidence bar, independent_reports no longer a bar) plus a P0 share of 0.35
      (RQ5); the wider hold-back (severity none at `open_hold_none_at`, 0.80, never with a P0 risk group or a raised
      hint); the early watch's caps of 5 a check, 60 a day and 20 looked at go. With row 51 OFF the fast triage and its
      pinned tests are as before. Suite: 1,315 of 1,315 passed. Left out, and why: the Sensitive Topic question in the
      story's early ask and its 0.35 raise (RQ5: a seventh question changes the request the recorded fixtures answer,
      and there is no recorded answer to test it on), sending the early watch's own asks side by side (they go one at a
      time inside the producer's loop, now without caps), the batch's growth from 10 to 50 by its speed, and the
      precision measure (it needs the Engine tab's daily row to know which early cards were later dismissed, from S3's
      records over days). No test catches the early watch's caps being kept: a run with more than 5 early-watch stories
      needs the producer's own scenario, which this harness does not build.
- [ ] **S12** Story reviews side by side (not built: see below)
      Not built, and why: the step splits the story review (`edReviewAndPost_`) into prepare, one fetchAll of K Gemini
      reviews through a new `geminiGenerateMany_`, and decide-and-post, with the same-story check run again before each
      card, answers stored on the queued row before posting, K growing from 3 to 6 and halved on a 429, and one at a time
      after a run died. The fix plan's four "one issue, one Social Alert email" timelines must hold at K = 6. That
      rebuilds the one review path every story card and its emails go through, and Gemini's reply parsing that Burson's
      reviews share (GEM:406-449). Done in part, it would leave two review paths, and a fault there would reach
      Burson's own reviews. Under row 51 the reviews stay one at a time, with no count a run (S5), bounded by the run's
      time, the safety stop and the pace (S2), and the 10-minute back-off after a 429 for background calls (S2). Steps
      that depend on S12 here: none of those that follow need it to run.

### Requirements first (plan 3, and plan 4 for S19h; briefs 17 to 25)
- [ ] **S19a** The code check, counted only (built in part: see below; left unticked)
      Built, under row 51 with the setting `open_requirements_first` (true): `RequirementsFirst.gs`, `rqCheckPost_` (the
      plan's RQ2 steps 0-3 through `escalation_`, no number copied: a post already seen is not checked alone; Google's own
      post passes at 30 comments and 30% negative and fails below either; the rules alone with the source's KOF lists
      (less `RX_NOT_KOF_LIST_`), its official tag or topic, 2,000+ or a tier HIGH; a KOF sheet hit is a code pass
      (`KOF_SHEET`) without setting `kof`; a post no judgment could pass fails with its exclusion; else a judgment, gated
      under 40 characters), `rqKofIndex_` / `rqKofSheetHit_` (a profile link on its network, a bare handle on any), and
      `rqCountPosts_` in the producer after the same-author dedup: each post's `rq` and `rr` kept in memory and the Engine
      tab's `alone`, `codePass`, `gated`, `failed` and `codeMs` columns filled. Nothing is posted, queued or reviewed
      because of it. Suite: 1,318 of 1,318 passed. Left out, and why: the SQL columns (`kofl`, `stag`, `eng2`, `isnew`,
      `big`) and the `gated` rows kept out of grouping, DSD's KOF authors as a list, the owned facts' US job, and reading
      the KOF sheet's index from the knowledge cache (each changes the producer's requests or its stored state, the
      ground S7 and S9 leave out; the posts carry only today's columns, so today the check sees engagements and text, and
      a source's KOF list or tag only where a later step adds them); the seen set (it needs S19g's records); the
      "MR cases and RQ2 table give the same track as escalation_" test (the check calls escalation_ itself, so the
      track is escalation_'s by construction); request bodies with the setting false (no request changes here).
- [ ] **S19b** Code passes reviewed and carded (not built: see below)
      Not built, and why: the step reviews a code pass alone with Burson's own review (`reviewAlert_`, `escalationFor_`,
      `aiVeto_`) inside the drain, posts a card only when a requirement is met (Direct format with `[Why now]`), hands it
      to `handleNewAlert_` with the stored review, and claims the post in the alert memory, so it alerts once. Its code
      passes today would be only the 2,000+ posts: the KOF lists, the source tags and the owned facts come from the
      producer's SQL columns S19a leaves out. The Direct BigQuery poll already cards 2,000+ posts (with its own Social
      Alert path), so a second carding path for the same posts would break "one post, one path" until S19c joins them.
      It also adds a path that sends Social Alert emails. Built on a check that sees only part of the requirements, that
      path cannot be shown safe by these tests.
- [ ] **S19d** The quick look for single posts, and quick passes, live from the first day (the plan's S19d and S19e together) (part one built, counted: see below; left unticked)
      Built (part one, under row 51 with `open_requirements_first`): `decPostInput_` (the platform, the time and the
      cleaned text, at most 600 characters, nothing under 20; no link, handle, follower count, engagement or id),
      `decPostQuestions_` (about Google; the Exposure Tags and their own descriptions; the Sensitive Topics with GEN's
      descriptions and "none"; the severity scale), `decPostCompact_`, the verdict `rqDecide_` (not about Google under
      0.20; a P0 share at the bar gives a P0 tag; the chosen tag at 0.80; a topic at the bar, alone or as the share on
      any topic; about Google 0.50 lifts "Google as a verb"; the owned-post tag alone never; then `escalation_`), and
      `rqJudgeRun_`, the Auto-correct flow's last background step: this run's posts the code check left to a judgment,
      a P0 risk-term group first, then most engagements, one call per distinct text, asked side by side
      (`decisionsAskMany_`) in batches from 10 growing by 10 to 50 while a batch takes under 3 s, stopping at a slower
      one, within a 20-second slice, with 30 s of the flow kept, and only while the open engine allows a quick look; its
      verdicts counted at 0.30 / 0.35 / 0.40 / 0.50 on the Engine tab (`asked`, `qPass` at 0.35, `notReached`,
      `quickS`, the four counts in the day's note). Nothing is queued from it. Suite: 1,321 of 1,321 passed. Left out, and
      why: quick passes into the list, their rank, the back-pressure, the bar guard and the daily audit (part two:
      they need S19b's list and its review path, not built); the carry `rqj` and the answers `rqa` across runs (the
      producer's stored state, as S7); its own ApiGuard kind and pause (`decisions_post`, `DECISIONS_POST_STATE`: the
      looks share the story asks' session and pause today); C51's counting-only, paused and fetch texts.
- [ ] **S19h** The first screen (part S19h-1 built in part: see below; left unticked)
      Built, under row 51 with `open_requirements_first` and `open_first_screen` (true): in front of S19d's quick look,
      `rqScreenRun_` (RequirementsFirst.gs) sends the posts left to a judgment to Vertex AI's triage model 25 to a call
      with one of 12 known test posts (`RQ_SCREEN_KNOWN_`, in turn), the instruction built from GEN (`rqScreenSystem_`:
      the P0 tags but `RQ_NEVER_QUICK_TAGS_`, which `rqDecide_` now reads too; the topics; the products and their other
      names), the input from the platform, the product index, the source and the text only (`rqScreenInput_`, Google
      links and handles kept as words by `rqGoogleSigns_`), calls in rank order and posts inside a call by text hash; the
      answer check (`rqScreenRead_`: one entry a post, exact refs, the marks, the first words, the known post marked);
      posts in a P0 risk-term group and instruction-like texts kept out (`oq`, `oi`); its own sender (Gemini.gs
      `geminiRequest_` / `geminiReadReply_`, one `fetchAll` a round, temperature 0, LOW, a 4,096 cap, `safetySettings`,
      never `geminiGenerate_`); its own ApiGuard kind (`screen`, `screen_split`, `screen_posts`, ceilings 300 / 1,800
      from the carry's size, kept apart from `gemini`); the 429 list (`api_guard_v429_log`, one line in
      `geminiGenerate_`, written only while the screen marked itself on); its gates (the quick look's own, the day's run
      time or outside calls at 0.70, Burson first: their reviews bursting, the shared cooldown, a Vertex 429 in the last
      10 minutes, a new Burson alert; its pause; its ceilings; the bug stop; room in the slice and 30 s of the flow);
      rounds of `k` calls (4, doubling after a clean round with no 429 in the 2 minutes after, halving after a slow one,
      for an hour after its own 429, for a day after a 429 near a round); refused calls split once 13 + 12; a cut answer
      gives 13 posts a call, then an 8,192 cap, for the day; `safetySettings` refused drops them for the day; its own
      pauses (10 minutes after its 429, 15 after no answer or three slow rounds, a failed probe doubling to an hour);
      marks asked by rank, then the calls it could not read; 1 in 50 of the noes sampled and asked (1 in 200 at outside
      calls 0.60); in a run where it cannot run, the quick looks ask exactly as without it; its state `RQ_SCREEN`; the
      Engine tab's ten `screen` columns and the day before's rows (posts and picks by source, time off and why, the
      known post missed); C51's warning after an hour paused. Suite: 1,344 of 1,344 passed. Left out, and why: the
      carry's `fs` and `pi`, halves waiting for a later run, the 10-run wait `ow` and test 17 (the carry `rqj` is not
      built, S19d; the posts are this run's, and what the screen does not reach in a run gets its quick look as without
      it, so no post waits for it); the seen-set letters `n`, `F`, `M` (no seen set, S19a); the audit drawn at fail time
      and its row, test 21 (S19e's audit, not built); sample passes ranked in the review list, the back-pressure of test
      20 and the `rqj` sizes of test 22 (no list, S19d part two); the misses row "about N a day it should have picked"
      (it needs the review's confirmations; the sample's counts by source are kept); marks by kind and Launches by
      topic, misses by position third; S19h-2 (it needs S18 and S19g). Chosen where the plan is silent or would stall:
      a round's room is at most the whole slice (20 s), else a slow history would stop the screen for good; a quick look
      held by Gemini's "too busy" counts as Burson first; the cap of 8,192 applies from the next round; the Engine tab's
      Note cell holds 200 characters (the day rows). S19d's step test now runs with `open_first_screen` false, which
      gives the quick look alone as S19d built it.
- [ ] **S13** The Watch: a single worrying post goes out alone (built in part: see below; left unticked)
      Built, under row 51: `pwSolo_` takes the destination; in the Auto-correct space a flag the pre-read judged
      meaningful (`true`, not just not judged) with its own P1 tag or a Sensitive Topic is an alert of its own, whatever
      its reach; no pre-read, the Mirror or Other alerts spaces, or row 51 OFF: today's rules. Flags waiting for their
      pre-read for want of time or budget are noted (`pw_preread_wait`, the oldest's first sight; cleared when a
      pre-read runs); from 10 minutes on, the Auto-correct flow's background steps after Burson's pass stop at 210 s
      (`AC_PREREAD_LATEST_MS_`). Brandwatch mentions' 1,000 a day goes (60 a look stays). Posting while fewer than 3 of
      the bot's cards wait came with S4. Suite: 1,349 of 1,349 passed. Chosen: the plan moves the flow's latest stop from
      260 s to 210 s; that stop also ends Burson's own pass, so here only the background steps after it stop earlier
      (rule 4: Burson's alerts are never slowed). Left out, and why: "one config rule" (Brandwatch mentions' 7 configs
      read by `EWS_GOOGLE_CONFIG_RX_` instead): it changes the Watch's SQL, which this step must not change; the Watch
      sources tab's description of Brandwatch mentions still says 1,000 a day (it is written when the file loads).
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
- The first screen (S19h): which `safetySettings` values `gemini-3.8-flash` accepts (a 400 naming them drops them for
  the day); a 25-post call's real time and how many requests Apps Script's `fetchAll` runs at once; how often Vertex
  refuses a call; the mark rate by source; the share of ordinary posts the instruction filter keeps out; that a refusal
  arrives as `promptFeedback.blockReason` or a safety finish reason, as written.
- That `Session.getEffectiveUser().getEmail()` answers in a trigger run of this deployment (if it throws, the bot takes
  the lower budgets, 1.5 hours and 20,000 calls, until the settings are filled in).
