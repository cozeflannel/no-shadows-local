# B. Requirements first, then clustering (amendment to the open-engine plan)

> **For whoever builds from this file in the repository.** It was written against an older commit: line numbers
> have moved, so find each place by its function or constant name. Paths that start with `scratchpad/` point at
> design notes that are not in the repository; this folder holds everything needed. Read `README.md` and
> `STEP_NOTES.md` in this folder first: where they differ from this file, they win.

Final amendment, 17 November 2026, to `docs/build-plan/2_open_engine_plan.md` (**OPEN**), for the owner's proposal of 17 Nov
(owner_direction.md:71-86): "everything first gets checked against the processes laid out in the knowledge docs and if
it fails to meet those thresholds, they're then clustered … only if it can remain as a quick review and alert". OPEN's
section A still wins over everything else in OPEN; this section B wins over OPEN where they differ, and says so step by
step (B4).

**Written from** two maps (`rq_map_requirements.md` = **MR**, `rq_map_frontdoors.md` = **MF**), two designs
(`rq_design_producer.md` = **PROD**, `rq_design_onedoor.md` = **DOOR**) and three reviews (`rq_attack_quick.md` = **Q**,
`rq_attack_wrong.md` = **W**, `rq_attack_flood.md` = **F**), all in `scratchpad/open/`, read in full, plus OPEN (sections
A, 0, 1, O1-O4, O8, the step table, the limits table, 6-8), `map_walls.md`, `map_turned-away.md`, `map_judgment.md`
(**MJ**), `scratchpad/spec_v2.md` (**V2**) and `docs/build-plan/1_new_sources_plan.md` (**SPEC**).

**Code.** b2ee90f, unpacked in my own copy `scratchpad/open/rq_plan/` (`git archive b2ee90f`). `File.gs:N` is
`apps-script-chat-bot/File.gs` there. Short names as OPEN: EWS EarlyWaveSource.gs, BQ BigQuery.gs, ED EarlyDetection.gs,
EDC EarlyDetectionCross.gs, EDT EarlyDetectionTab.gs, FT FastTriage.gs, DEC Decisions.gs, AG ApiGuard.gs, AC
AutoCorrect.gs, AM AlertMemory.gs, ESC Escalate.gs, REQ RequirementLine.gs, KN Knowledge.gs, PW ProactiveWatch.gs, WA
WatchAlerts.gs, OA OtherAlerts.gs, CFG `config/default_config.yaml`.

**Lines I re-opened myself for the points where the designs and reviews disagree:** EWS 105-140 (the 40-s budget, the
20-s BigQuery wait, the size constants), 240-262 (`ewsRows_`: produce, then the early-watch ask, then the buffer is
read), 374-410 (the shared gate, size line at 381), 430-470 (the `spk` lane: `post_url AS url`, comment id only in
`mid`, 435), 515-528 (Sonar's KOF drop), 1692-1740 (`ewsProduce_`), 1895-1905 (`buffer.slice(-EWS_BUFFER_MAX_)`); AC
30-45 and 118-235 (the flow: `runOnce_` first, then Early Detection's check and drain, then the poll, and the reverse when
the poll is 10 min overdue); BQ 2330-2348 (`bqOnlyStoryCards_`), 2622-2645 and 2708-2720 (Direct's `alreadySeen` and its
claim after posting), 1005-1026 (`bqSprinklrPostStatsSql_`), 3434-3473 (the old card's "low-tier" words), 4240-4262
(`earlyWaveCheck_` returns early between checks); AM 74-92, 170-210 (`amPostKey_` keeps an `id:` key as it is),
1000-1045 (`seenPost`, `claim`: `claim` refuses whenever `seenPost` returns anything); ESC 78-255 (whole decision);
ED 405-470 (`edMergedFields_` falls back to the hint below 0.8), 575-610, 1165-1175, 1520-1528 (`*KOF:* No (small,
non-KOF accounts)`), 1867-1892; Drafts.gs 225-245 and 300-326 (`escalationFor_`, `aiVeto_`, `kofOnly_`); Review.gs
134-140, 525-542 (owned-post veto), 860-864 (the "100+ engagements" sentence); Bot.gs 1090-1100 (`handleNewAlert_`
takes a review already made), 1800-1812; WA 1340-1365 (`pwSolo_`), 1815-1858 (the Watch's `seenPost` and claim); OA
755-770 (`otherCollected_`); AG 19-36; DEC 36-80, 198-215, 330-340 (one pause, one counter, one fetch at a time); CFG
350-366; and a grep of every user-facing "low-tier" / "small accounts" text (list in RQ5).

**What I ran** (Node, the bot loaded by `test/fakes.js`, scripts in `scratchpad/open/rq_final_probe/`):
- `esc.js` **[RAN]**: `escalation_` on the disputed cases. Printed: an ongoing P0 post at 300 engagements gives
  `track: null, suppression: ongoing_no_kof`; YouTube the subject with a P0 tag and no topic gives `track: null,
  suppression: youtube_no_action`; YouTube the subject with a KOF gives `escalated: false, track: URGENT, action:
  YOUTUBE_CHAT_ONLY`; the Launches topic with no tag at 5 engagements gives `URGENT [SENSITIVE_TOPIC]`; the owned-post tag
  at 10 comments gives `URGENT [P0_TOPIC]`; no product and "Google that …" at 2,500 gives `track: null,
  EXCLUDED_GOOGLE_AS_VERB`. GEN holds 46 tags, 11 of them P0, and 12 Sensitive Topics.
  So `track !== null` is exactly "no suppression" (ESC:239 `track: alertable ? track : null`): it is the right test for
  "meets a requirement", and it keeps Burson's YouTube ping (W A5).
- `q.js` **[RAN]**: question sizes. Today's six: 13,249 characters; `about_google` 810, `category` 9,204 (48 options),
  `severity` 1,491. The final per-post set (about Google + category + severity + Sensitive Topic with the 12 config
  descriptions and "none"): **16,785 characters**, about **3,700-4,000 input tokens a call** with a 700-character post at
  the recorded 4.2-4.5 characters a token (DEC:46-52). I use **~3,900** below (estimate; the API returns the real count).
  Longest tag name 62 characters ("Content - Negative reaction to Google influencer post/activity", also the longest P0
  tag); longest topic 40 ("Medical Content / Medical Misinformation").
- `len.js` **[RAN]**: the length of every text a person reads in this section (each length below is its output; Chat
  links counted with a sample URL).
- One `node -e` for the stored sizes (Bloom filters, seen set, carry) and the token figures.

**NOT VERIFIED** marks every number nobody here could check (no sheet, BigQuery, logs, Brandwatch, Gemini or Apps
Script from here). **(A)** marks an assumption; each one has a rule that keeps it safe when it is wrong.

---

## C. Decisions of the plan's owner on this section (17 Nov 2026). They override anything below that differs.

Section B is adopted as part of the open-engine plan, with four changes. The bot's owner was promised that every post
is checked first, that it stays quick, and that the quick check's accuracy "will be counted from the first day"; the
owner has also rejected trial periods and anything that hands them a second task.

**C1. No counting-only week and no second deploy.** (Replaces "S19e, a separate deploy after at least 7 days and 5,000
asks of S19d", F-P6, the "counting-only" C51 text as the normal state, and the sentence "so the first week only counts before
any card depends on it" in B7.)
- S19d and S19e stay two build steps, but they ship together and quick passes are live from the first day, at the bar
  0.35, under one setting `open_quick_pass_live` (default **true**; false = S19d's counting-only state, with its C51
  text).
- Why this is safe without a trial: a quick pass can never make a card or an email; only the full review can. What a
  wrong quick pass costs is one review, and that cost is bounded from the first day by the rules already in this
  section: quick passes rank last, hold at most 8 of the 24 queue places, never push a story out, stop asking while
  waiting passes would not be reviewed in time (back-pressure), and stop at 0.70 of the run-time and fetch budgets.
- Everything S19d counts is still counted from the first day: pass rates at 0.30 / 0.35 / 0.40 / 0.50 by source and
  topic, confirmed and rejected passes, posts not reached and why, and misses. The bar guard adjusts the bar from
  those counts as designed.

**C2. The account type is read by the bot, so the budgets do not start at the wrong number.** (Replaces "open_fetch_day
blank = 20,000 until measureEngineLive() records the account's real daily count", and gives OPEN's
`open_runtime_budget_hours` the same source.) The script already has the permission to read the address it runs as
(appsscript.json lists it; Main.gs:66 and Knowledge.gs:154 already read it). Under row 51, once a day, the bot looks at
the part after the "@" in memory: anything but gmail.com or googlemail.com is a Workspace account. Only the answer
`workspace: true / false` and the day are kept (in `RUN_LEDGER`'s header); no address, no domain, nothing of it in a
log, a cell, a property or a cache value. Then, while the settings are blank: a Workspace account gets 100,000 outside
calls a day and 6 hours of trigger run time; any other, or an address that could not be read, gets 20,000 and 1.5
hours. (These are Google's published figures as the plan's writers remembered them: NOT VERIFIED here; C51 shows which
were taken, and `open_fetch_day` / `open_runtime_budget_hours`, when set, win.) Test: an address on a made-up .test
domain gives the Workspace figures; a gmail.com one the lower; a thrown read the lower; no stored value, log line or
cell holds any part of the address.

**C3. A first screen that takes many posts a call, in front of the per-post quick look** (new step **S19h**, built
after S19d; designed in detail and attacked before it is built: `docs/build-plan/4_first_screen_plan.md`).
- Why: with every source ON the per-post quick look alone is 141% of a Workspace account's daily outside calls on a
  normal day (RQ7's table: ~141,300 calls against 100,000), so by this section's own fetch rule a large share of
  posts would go "not reached" every day. That would break "everything first gets checked". The wall is the number of
  calls, not tokens; the way through it is fewer calls, not a higher cap.
- What: posts that code left as "judge" first go, many to a call (the number is set by the design: 20 to 50), to an
  ordinary Gemini call that answers only "which of these could be about a P0 issue or a Sensitive Topic involving
  Google: when unsure, yes", with the taxonomy's names and one line each. Only the posts it marks go on to the
  per-post quick look (calibrated numbers, the bar), and from there to the full review. The owner was told "many
  posts a call"; this makes that true for the first screen, and "one post a call" stays true for the second.
- Rules it must keep: it fails open (the call fails, is slow, is refused or is switched off: the posts go to the
  per-post quick look in rank order, exactly as this section has it without S19h); it never sits in front of code
  passes, grouping, or anything that needs no Gemini today; it must not use up the rate limit or the daily calls
  that Burson's own reviews need (its own ApiGuard kind and its own pause); its "no" is measured (the daily audit of
  failed posts says at which stage each was failed); one setting switches it off (`open_first_screen`, default true).
- Expected effect, to be checked by the design: calls a day for single posts fall from one a post to about one for
  every 20 to 50 posts plus one for each post the screen marks; tokens fall about tenfold.

**C4. Order of building.** S19a and S19b first (code passes, live): they need no Gemini beyond the review and give the
owner alerts on KOF posts, 2,000+ posts and Google's own posts from every source. Then S19d with S19e (C1), then S19h,
then S19c, S19f and S19g. Nothing in this section waits for a person.

---

## B1. The decision in one screen

Under row 51 (OPEN's open engine) with **one setting, `open_requirements_first`** (default true). With row 51 OFF, or
the setting false, nothing of this section runs. No new Control row, no question, no task for the owner.

**What happens to a post, in order:**

1. **Read.** Early Detection's producer reads every lane every check (OPEN: every 5 minutes). Under the setting it reads
   posts **of every size**, keeps **KOF authors** (today dropped, EWS:467-472, 522-523), and returns the posts today's
   text gates drop (under 40 characters, the spam words, Sonar's praise tags) marked `gated`, for the check only. It also
   reads **Google's own posts of the last 72 hours** with their comment count and negative share (every check).
2. **Checked in code, at once** (inside the check, ~0.1 ms a post in Node [RAN by PROD and Q]). One pure function builds
   the alert fields the post carries and asks **`escalation_`** (ESC:78), the same decision every Burson review ends in.
   Code passes: a **KOF author** (the source's own list, DSD's KOF authors, the KOF sheet the bot keeps), **2,000+
   engagements**, **Google's own post at 30+ comments and 30%+ negative**, a **P0 tag or Sensitive Topic the listening
   tool already set**. A code pass never waits for Gemini: it is in the review queue in the same check.
3. **Everything else is grouped into stories at once, whatever its size**, exactly as today's posts are. Grouping never
   waits for Gemini.
4. **Gemini's quick look, last in the run** (after Burson's alerts, the story reviews and the Direct poll, in what time
   is left): **one post a call, many calls at once**. Three questions from the taxonomy (about Google, which Exposure Tag,
   which Sensitive Topic) and the severity scale, then `escalation_` again on the answer. A P0 tag or a Sensitive Topic at
   **35%** or more passes (low on purpose: the only error allowed is passing too much). If the quick look is slow,
   refused, paused or out of room, the post simply stays in its story, as today.
5. **A pass gets the full Burson review, in the background, before any card** (Review.gs `reviewAlert_`, ~40 s), ranked:
   code passes first, then today's serious stories, then quick passes. The decision is `escalationFor_` (Drafts.gs:231) on
   the review's own fields, as for a Burson alert. **Met: one card** in Burson's format in the Auto-correct space with one
   `[Why now]:` line, the "Alert requirements" line, and the Social Alert email (while Testing, only to `Control!B30`).
   **Not met: no card**; it is counted; the post stays in its story.
6. **One post, one path, one card, one email**: the alert memory's claim at posting, keyed per comment for Sprinklr
   comments, with today's story-card exception; Direct BigQuery, the Watch and Burson's own alerts keep their paths and
   step aside for a claimed post. A carded post that later crosses 2,000 gets one more review.
7. **Counted from day one:** quick passes the review rejects, and posts the check did not pass that later got an alert
   (from Burson, a person or another path), by source and by requirement, plus a daily sample of 20 failed posts given
   the full review so the miss rate is an estimate, not only a floor.

**Build order:** code check counted first; code passes live; the quick look counting only (a week); quick passes live;
every size grouped; misses counted (B4).

**The words the owner reads** (all under the setting; lengths [RAN] `len.js`):
- Control row 51 ON note: `✓ ON: checks every 5 min, every post checked against Burson's alert requirements first, the
  most serious go first; one safety stop a day` (136).
- On a card: `[Why now]: checked alone first: 2,540 engagements (2,000+ is the bar)` (69; every form in RQ4, longest 171).
- On a story card: `*Alert requirements:* not met yet as a story (1 of its 8 posts met a requirement alone and has its
  own card). Posted early because 5 accounts tell the same story.` (162).
- C51 when the quick look cannot keep up: `⏸ quick check of single posts held: 40 likely passes wait for a review. New
  posts go to the stories as before; KOF, 2,000+ and owned-post checks go on · Engine tab` (163).
- In the owner paragraph (B7): "At busy times Gemini's quick look reaches the most likely posts first; the rest go into
  stories as before, and the Engine tab shows how many." (141).

**One correction to what the owner was told:** "many posts a call" is not how the quick-look service works. It answers
each question once about one input (DEC:525-526); a 20-post call needs 20 sets of questions and is as big as 20 calls
(Q [RAN]: 310,672 vs 311,840 characters). So it is **one post a call, many calls at once**, which is as quick. B7 says it
in those words.

---

## B2. Every "must fix" of the three reviews, and every point where the two designs differ

### B2.1 The reviews' must-fix items (32)

| # | Must fix | Decision and evidence |
|---|---|---|
| Q1 | DOOR's quick look takes 15 s of the 40-s check before embedding | **Fixed: no quick look inside the check.** EWS:112-113 (40 s, 20 s BigQuery wait) and Vectors.gs:30 (embedding stops at 15 s left) leave embedding nothing after a 15-s slice. The check runs only the code check and grouping; the quick look is the flow's last step (RQ3). Test `switch_rq_quick_look.test.js`: with a quick look answering in 30 s, a 5-account story forms in the same check as with the setting off. |
| Q2 | Both put the quick look ahead of work that needs none | **Fixed.** Confirmed: `ewsRows_` asks the early watch after `ewsProduce_` and reads the buffer only after that (EWS:255-260), and the drain needs 150 s (OPEN:578), the poll 120 s (BQ:1597). Code passes go into their own list in the check and the drain reads that list every run (RQ4); the quick look runs after `earlyDetection()` and `pollDirect()` (AC:205-211), in the time they leave. Test: with a 30-s quick look, a KOF code pass is reviewed in the same run as with the quick look off, and the poll's run is unchanged. |
| Q3 | ApiGuard's Decisions ceilings and the token wall not counted | **Fixed.** Confirmed AG:30-31 (30 / 90; OPEN row 20 makes them 600 / 2,400) and one counter for every caller (DEC:208). A new ApiGuard kind `decisions_post` with ceilings derived from the token wall: 0.6 x 1,000,000 / ~3,900 tokens = **153 calls a minute**, 1,530 in 10 min, 9,180 in 60 min (recalculated from the Engine tab's measured tokens a call). The stories keep OPEN's 600 / 2,400 untouched. Test: 2,000 per-post asks in one check leave a story's ask in the same check unrefused. The owner is told peaks reach the most likely posts first (B7). |
| Q4 | A per-post failure pauses the stories' quick looks | **Fixed.** Confirmed one pause state (`DECISIONS_STATE.until`, DEC:66, 78, 204). The per-post look gets its own state `DECISIONS_POST_STATE`; its 429s shrink only its own pace and never start OPEN's shared 10-minute background back-off. Test: 50 per-post 429s leave `decSkipWhy_` empty for a story ask, and a story review starts in the same run. |
| Q5 | PROD's quick passes "always serious" evict story rows | **Fixed.** Three ranks (RQ4): code passes, then today's serious stories and flags, then quick passes. Quick passes hold at most 8 of the 24 queue places and never push a story row out (`ED_QUEUE_MAX_` drops the lowest-ranked, BQ:3348). Test: 30 quick passes and 12 story signals keep every story row queued. |
| Q6 | DOOR reviews every pass in the foreground B10 loop | **Fixed by PROD's place.** Passes are reviewed in Early Detection's background drain, under the run-time ledger and yield to Burson; the card is posted only after "met". The one exception is a code pass not reviewed within 60 min: it is posted as today's Direct card is (raw, reviewed in B10), and only while fewer than 3 bot cards wait (`BQ_DIRECT_MAX_WAITING_`, BQ:1614). |
| Q7 | DOOR replaces the Watch's KOF / P0 "alone" branches | **Fixed: `pwSolo_` (WA:1351-1363) and OPEN S13 stay as written.** The Watch only holds a flag (at most one check, 10 min) when a pass for the same post is already queued for review (RQ6). Test: with the quick look paused, a Watch flag with a listening-tool P0 tag at 12 engagements is posted alone, as today. |
| Q8 | DOOR moves DSD's alerts off the poll | **Fixed: DSD stays on Direct's poll**, untouched. The producer keeps DSD's alerted links as an exclusion (EWS:461-466) and DSD's KOF authors become a KOF list (RQ2). |
| Q9 | DOOR claims at read in one place, at posting in another | **Fixed: claim only at posting** (as BQ:2715). Other paths skip only a claimed or emailed post, never a queued one. |
| Q10 | DOOR carries ids only | **Fixed: the carry keeps the text** (`rqj:N`, records <= 1,150 characters, RQ3), sized to the cache. |
| W-A1 | The claim is keyed by the Google post's link for Sprinklr comments | **Confirmed and fixed.** EWS:435 returns `post_url AS url`; `claim` / `seenPost` key on `amPostKey_(url)` (AM:1006-1007, 1030-1033). `amPostKey_` returns an `id:` key unchanged (AM:181), so a comment's key is `id:spk:<comment_id>` in the claim, `seenPost`, the seen set, the Bloom filter and the queue; the owned post keeps its link key. Test: a KOF comment carded under post X, then X at 41 comments 37% negative, gives two cards; two KOF comments under X give two cards. |
| W-A2 | A story card that saw the post first blocks its own alert | **Confirmed and fixed.** `claim` returns false whenever `seenPost` returns anything (AM:1033), including `outcome: 'seen'` for a story card with no Social Alert; Direct already lets such posts through (`bqOnlyStoryCards_`, BQ:2335-2345; AC:119). Our claim and queue check pass the same exception (a new `opts.overStoryCards` on `claim`). Test: a monitor story card first, then a KOF pass on its main post, gives one post card, one email and the cross note. |
| W-A3 | A post carded early cannot be alerted when it later reaches 2,000 | **Fixed.** A "grown" read in Sonar's job (posts re-received in the window, first seen within 48 h, now 2,000+, BQ:1601's 48 h) and Tubular's read on change (OPEN S9, `MAX(total_engagements)`). A post whose review said "not met", or that was carded with no email, gets **one** more review when it first crosses the alert memory's next tier (2,000 / 10,000 / 50,000, AM:83). Test: a quick pass rejected at 3 engagements, then the same post at 2,100, gives one more review and one Social Alert. |
| W-A4 | PROD's priority hint becomes the decision when the review is unsure | **Confirmed and fixed.** `edMergedFields_` takes the review's tag and topics only at 0.8+ (ED:439, 445) and falls back to `priorityHint` (ED:459-462). The pass is reviewed by Review.gs's own review (`reviewAlert_`, Review.gs:134), whose fields are taken at any confidence, and decided by `escalationFor_` + `aiVeto_` (Drafts.gs:231-324); no hint enters the fields. Test: a P0 hint with a review that says P2 gives no Social Alert. |
| W-A5 | PROD's "met" = `escalated` loses the YouTube ping | **Confirmed [RAN] and fixed:** met = `track !== null` (ESC:239). |
| W-A6 | "Google that" with no product fails a 2,000+ post | **Confirmed [RAN] and fixed.** The lane topic goes through `mapBqProduct_` (BQ:1426); if the product is still blank and the only suppression is `EXCLUDED_GOOGLE_AS_VERB`, the answer is "judge", never "fail"; after the quick look, `about_google >= 0.50` lifts that exclusion. Test: 2,500 engagements and "Google that was a disaster" with no product passes. |
| W-A7 | PROD's guessed non-P0 tag makes a real topic "restate the tag" | **Fixed:** a non-P0 tag from the quick look goes into the fields only at 0.80 or more; below that the tag is blank and the redundancy rule (ESC:105) cannot fire. Test: privacy tag at 0.45 and Privacy at 0.60 passes. |
| W-A8 | The Watch can take a passed post and decide it by its own rule | **Fixed.** (1) The Watch's poster (WA:1819) asks `RQ_PENDING`: while a pass for the post is queued, the flag waits one check (at most 10 min), then goes as today. (2) Under the setting `otherCollected_` (OA:760-767) counts a Sensitive Topic as collected (Burson: any engagement, CFG:378, 396). Test: a Watch flag and a queued pass on one Sonar post give one card, decided by `escalation_`. |
| W-A9 | = Q1 | Fixed as Q1. |
| W-A10 | DOOR's B10 reviews; no budget for quick-pass reviews | **Fixed** as Q6, plus F-P3's back-pressure (a quick-look batch is not sent when the passes already waiting would not be reviewed in their 180 minutes). A count share (W's 25%) is not taken: the room is derived from the run-time wall, not a number. |
| W-A11 | A code pass ends by age without a review | **Fixed.** A code pass never ends by age: not reviewed within 60 min, it is posted as a Direct card (raw, reviewed in B10, "a person decides" as Direct today). A quick pass that waits 180 min ends T4d, which says it is "in its story only". |
| W-A12 | "Every post first checked" is not built: gates before the check | **Fixed in part, rest counted.** The text floor (40 characters / 7 tokens), the spam regex and Sonar's praise / functional-use tags (EWS:384, 390-404, 524-525) apply to grouping only; such rows come back `gated` to the code check and the quick look (the quick look's own floor is 20 characters of clean text). Positive sentiment, non-English, bots, Grok and deleted stay out (settled by the owner, owner_direction.md:47-51; business rules), and a later alert on a post the check never read is counted "never read" by lane, so the count shows it. |
| W-A13 | The story line says none of its posts passed | **Fixed.** The cause is built from the members' marks: `(1 of its 8 posts met a requirement alone and has its own card)` or `(none of its 8 posts met a requirement alone; 2 were not checked)` (RQ5). Test: a story with a passed member never reads "none". |
| F-P1 | The UrlFetch day can be exhausted by the quick look, and then Burson's alerts stop | **Accepted; fixed in S2.** A fetch ledger beside the run-time ledger counts every request (each of a `fetchAll`) in `RUN_LEDGER`'s hourly buckets; budget `open_fetch_day` (blank = 20,000, the lower training figure, until `measureEngineLive()` records the account's real daily count) minus Burson's reserve (2x the busiest Burson-pass fetch count of the last 7 days). At 0.70 of it no per-post quick look; at 0.90 no background fetch. The derived ceiling becomes `min(150 x open_daily_stop, 0.5 x fetch budget)`. The quota's real number: **NOT VERIFIED**. |
| F-P2 | The 2,400-an-hour Decisions guard silently judges 8-41% | **Fixed** as Q3 (own kind, derived from the token wall). "Not reached: rate" is counted by source. |
| F-P3 | No break-even, no back-pressure from the review room | **Fixed.** Before each quick-look batch: if (quick passes waiting x the measured review run time) exceeds what the ledger leaves before the oldest waiting pass reaches 180 minutes, no more per-post asks this run ("not reached: reviews full", C51 text). The owner paragraph says that at busy times the most likely posts go first. |
| F-P4 | = Q5 | Fixed as Q5; in the ledger's 0.80-0.90 band a quick-pass requirement row counts as serious only once its measured confirm rate is 1 in 3 or more over 50+ reviews (`RQ_DAY`). |
| F-P5 | PROD's pass rows share the newest-N buffer | **Confirmed (EWS:1901) and fixed:** passes live in their own chunked list `rqm:N` with a manifest, never in the buffer. Test: 400 quick passes and 20 story signals in one window: every story signal and code pass is read. |
| F-P6 | PROD has no counting-only phase | **Fixed:** S19d asks and counts only (no pass row) for at least 7 days and 5,000 asks; S19e turns quick passes live with the bar set in that commit from the measured counts. Code passes go live before (S19b). |
| F-P7 | DOOR posts every pass raw before its review | **Fixed** as Q6: review first, card only when met. |
| F-P8 | DOOR's queue of 30: the 31st | **Moot** (no door queue). The `rqm` list is storage-bound and ranked; a quick pass that does not fit is not written ("not reached: reviews full"); a code pass always fits (code passes are tens a day by Burson's ~55, PW:46-47; (A)). |
| F-P9 | DOOR's quick look not on the run-time ledger | **Fixed:** at f >= 0.70 no per-post quick look; the code check and code passes go on (OPEN's ledger table, B4). |

### B2.2 Should-fix items taken (not all listed by number)

Taken: Q11 (a batch is never cut: "a new batch starts only within the slice"; first batch 10, stop for the run after a
batch over 3 s), Q12 and F missing-8 (the owner is told plainly), Q14 (code check timed per check; past 3 s the posts
beyond the first 1,000 ranked are checked after grouping), Q15 (posts not `big` embedded ahead of `big` ones in the same
risk group), Q missing-8 (the producer's deadline becomes `min(now + 40 s, ctx.deadline - 5 s)` under the setting), W-B1
(bar 0.35, severity asked and kept), W-B3 ("at least N missed" plus a daily audit of 20 failed posts), W-B5 (velocity
warm-up for `big`, the pool rule, the prompt lines ED:839, 851, 1044), W-B6 (the full wording sweep and both parsers),
W-B7 (KOF forced only from the source's own list; a sheet hit is judged by the review's `kof_fit`), W-B8 (index rows
indexed / rows on the sheet), W-B9 (owned posts by the raw comments appended in the window), W-B10 (reposts), F-P10 (topic
passes counted by topic; "spread" counted apart), F-P12 (same-story passes as thread replies), F-P13 (ceiling derived),
F-P15 (no refusal count; carry by freshness), F-P17 (rejected quick passes counted, not written to the Early Detection
tab).
**Refuted or narrowed:** W-B2 "leave Launches out": the full review offers all 12 topics, Launches included
(Review.gs:850 builds the list from `GEN.sensitive_topics`), and `escalation_` passes it [RAN]; leaving it out would make
the quick check stricter than the review, the one direction forbidden. Launches stays, ranked last among quick passes and
counted on its own row. W-B4 (retiring DOOR's net): moot, Direct is not retired. Q12's sentence is used as written.

### B2.3 Where the two designs differ, and which wins

| Point | PROD | DOOR | Decision and why |
|---|---|---|---|
| Where the quick look runs | after the producer, before the buffer read | inside the check, before embedding | **Neither: last in the flow** (Q1, Q2). |
| Where a pass is reviewed | Early Detection's drain, ED's review | B10 loop, Burson's review of a Direct card | **PROD's place, DOOR's review**: the drain (background, ranked, ledger, yield), running Review.gs's `reviewAlert_` and `escalationFor_` (W-A4, Q6, F-P7). |
| Card before or after the review | after, only when met | before, every pass | **After** (F-P7). |
| "Met" | `escalated` | `track` | **`track !== null`** (W-A5, [RAN]). |
| Card kind | new ED card `REQUIREMENT_MET` | Direct card + `[Why now]` | **Direct card (Burson's format) + `[Why now]`**: the review is Burson's, which reads that format (`parseAlert_`, Alert.gs:356), and `handleNewAlert_` (Bot.gs:1095) takes the stored review for the requirement line, write-up and email. The Early Detection tab gets the row (kind `Single post`). |
| Question set | 48 options + 12 topics | 11 P0 + other + none, 12 topics | **48 options** (same taxonomy as the stories and the review; keeps the redundancy rule; tokens do not bind on a normal day, F-P11) **plus severity** (W-B1). |
| Bars | 0.40 | 0.35 | **0.35** on the P0 share and on the Sensitive share; the recorded suicide-chats risk story has a P0 share of 0.354 (W probe `p0mass.js`): 0.40 would lose it. A non-P0 tag only at 0.80+ (W-A7). |
| Non-P0 tag from the quick look | the chosen tag | none | **Only at 0.80+** (W-A7). |
| Direct BigQuery | untouched, 500 kept | net, retired by measure | **Untouched** (Q, F, W-B4). Misses it catches are counted. |
| The Watch | untouched | requirement branches replaced | **Untouched**, plus the hold and `otherCollected_` (Q7, W-A8). |
| DSD | exclusion as today | into the door queue | **On Direct's poll as today**; DSD's KOF authors become a KOF list in the producer (Q8). |
| Owned posts | `own30` filtered on `spk` | owned facts in the US job | **DOOR's facts, filtered on the raw comments appended in the window** (W-B9). |
| Counting-only phase | none | D3 | **DOOR** (F-P6). |
| Token pace | none | 60% of the limit | **DOOR's, as its own ApiGuard kind** (Q3, F-P2, F-P14 wording: "a margin under the rate limit"). |
| Bar guard | automatic, raises on low confirms | none | **PROD's, with F-P15's condition**: a bar is raised only when no later-alerted post of the last 48 h sat between the old and the new bar. |
| Carry | text, 60 min | ids, 180 min | **Text, 180 min, 1,000 records** (Q10, F-P15). |
| Misses | Bloom filter 7 days | seen set 48 h with p0 / s, note under the alert | **Both**: the seen set (48 h, with the numbers) for notes and bar checks, the daily Bloom filters (7 days) for the slow lanes (W, B3). |
| Velocity for big posts | warm-up | not mentioned | **PROD** (W-B5). |
| Review.gs:862 "100+ engagements" | not changed | reworded for every flow | **Reworded under the setting only** (row 51 OFF changes nothing). |
| KOF sheet hit with no network on the row | code pass, `kof` not set, review asked | code pass, review's `kof_fit` | **DOOR**: Burson's review has `kof_fit` (Generated.gs:1624); the ED review has none. |
| Refusals | pass, 50 a day | pass, no cap | **Pass, no cap**, ranked last (F-P15). |
| Grown read | first sighting only | grown CTE | **DOOR's**, with one more review on a tier (W-A3). |
| Single-post step S15 and S13 | S15 dropped | S13 change and S15 dropped | **S15 dropped; S13 kept** (Q7). |
| Setting | `open_requirements_first` | `open_front_door` (+2) | **`open_requirements_first`**, the one switch; DOOR's bar and net settings are not taken (constants; no net). |

---

## B3. The nine questions

### RQ1. The requirements

**Decision.** The check applies the requirements the bot already holds, from one source: the config's `collection` block
(CFG:265-404, "SLRR Collection Requirements (March 5, 2026)") built into Generated.gs and decided by `escalation_`
(ESC:78-253), plus the one rule `escalation_` leaves to a later veto, the owned-post rule (Review.gs:527-541), with the
same numbers. No number is copied into new code; the words for people come from `escalationRuleLines_` (Voice.gs:400-427)
and REQ. The review's system sentence "threshold-qualified posts (100+ engagements …)" (Review.gs:862) is never used: 100+
is SLRR's collection floor (also OA:20, PW:72), not the Social Alert bar.

| # | Requirement | Facts it needs about one post | Kind at read | Code that decides |
|---|---|---|---|---|
| R1 | P0 Exposure Tag, new issue: any engagement (CFG:366-377; 11 tags [RAN]) | tag priority; new / ongoing | **judgment** (a source tag can carry it: Sonar smart tag that is an official name, BQ:1709-1712; Brandwatch's exposure-tag category, PW:137, 674) | ESC:94-99, 155 |
| R2 | Sensitive Topic, new issue: any engagement, P0 to P2 (CFG:352-364, 378, 396; 12 topics) | topic; not a restatement of the tag (CFG:293-303); Politics only US / blank location or an English election mention | **judgment**; the Politics rule is code | ESC:101-113, 156 |
| R3 | Briefed topic counts as Sensitive | product, text | code (`briefed_topics: []`, CFG:304) | ESC:62-72, 157 |
| R4 | KOF author: any engagement, new or ongoing | author on a list the bot holds | **list** (RQ2) | ESC:117, 158, 167 |
| R5 | 2,000+ engagements (CFG:269) | engagements | **number** (every lane but DSD and AMIE, which give a tier, MF §2.11) | ESC:118-123, 160 |
| R6 | Ongoing (14 days, CFG:270): only KOF or 2,000+, four always-alert Content tags excepted (CFG:368-371) | status, KOF, engagements, tag | status unknown for a raw post: blank = NEW (Review.gs:62-65), the permissive side | ESC:162-171 |
| R7 | Google's own post: 30+ comments and 30%+ negative (CFG:348) | Google's post, comment count, negative share (Sprinklr's sentiment) | **number** (Sprinklr) | not in `escalation_` [RAN: passes at 10 comments]; Review.gs:527-541; BQ:1830 |
| R8 | Exclusions unless a risk topic (CFG:285-292, 327-341) | text, topics, product | code (regex); `google_as_verb` needs a product (W-A6) | ESC:125-151 |
| R9 | YouTube protocol (CFG:420-429) | product, issue name, tag | from the review's fields | ESC:173-196 |
| R10 | English only (CFG:268) | language | code (each lane's SQL; Review.gs:543-557) | — |
| R11 | Suspension + censorship = Perceived bias (CFG:274) | tag, text | judgment (tag) + regex | ESC:95-97 |
| R12 | One post one email (14 days); same story in 24 h folds | post key, story embedding | code (alert memory) | AM:76-91, 1000-1045 |
| R13 | Gemini's 90%+ "not warranted" vetoes 2,000+-only and KOF-only alerts, never P0 / Sensitive | the review | the review only | Drafts.gs:303-324 |

What code can decide when the post is read: R4 (where a list holds the author), R5, R7, R3, R8, R10, R12 and the
Politics part of R2. R1 and R2 need a judgment. R6, R9, R11 and R13 can only take a pass away, so leaving them to the full
review keeps the quick check's error on the "passes too much" side. **"Fails whatever its topic" is rare**: for a raw post
code knows "ongoing" only when the same post was already alerted, which one-post-one-path takes out before the check
(PROD RQ1, [RAN] by PROD and DOOR).

**Not verified.** The Collection Requirements document itself (CFG:541) could not be read (Drive: "not found", MR §5);
the config's numbers are applied as the bot holds them, and a config change reaches the check through Generated.gs with no
other change.

### RQ2. The check in code

**Decision.** One pure function, `rqCheckPost_(post, facts)`, in a new file `RequirementsFirst.gs`, called in
`ewsProduce_` after the same-author dedup (EWS:1711) and before the stories load (EWS:1715). It builds the fields as
`edBaseFields_` does (ED:407-430) plus the facts below, and calls `escalation_` at most twice:

0. **Repeats first.** `seenPost` (AM:1006) with the comment key (W-A1) and the story-card exception (W-A2): claimed or
   emailed, a DSD-alerted link (EWS:461-466) or a post in the SLRR log (7 days, BQ:1815-1818) is not checked alone; it
   stays a story member. A repost whose stripped text matches a post passed in the last 24 h is skipped (`repost`, W-B10).
1. **Google's own post** (the owned facts): 30+ comments and 30%+ negative passes (`OWNED`), with
   `sprinklr_total_comments` and `sprinklr_neg_pct` on the fields so the review's veto (Review.gs:527-541) sees the same
   numbers. Below either number nothing passes (the comments under it are posts of their own).
2. **The rules alone.** `escalation_(fields)` with the source's own tag and topic only when they are official names
   (`lookupTag_`, `lookupTopic_`). `track !== null` -> **passes alone** with its reasons (`KOF`, `HIGH_ENGAGEMENT`,
   `SOURCE_P0`, `SOURCE_TOPIC`; DSD and AMIE tier HIGH count as 2,000+, their KOF type or column as KOF).
3. **Could a judgment pass it?** `escalation_` again with an always-alert P0 Content tag and `Child Safety` (DOOR's step 3).
   No track even then -> **fails whatever its topic** (rare: an exclusion that a topic does not lift). Otherwise
   **judge** (R1 / R2). A blank product with only `EXCLUDED_GOOGLE_AS_VERB` is always "judge" (W-A6).

Stored on the post: `rq` one letter (`m` met, `f` failed, `j` judge, `g` gated-and-judge), `rr` the reason code (<= 24
characters).

**What it reads, by lane** (the columns the SQL adds under the setting; with the setting false the request bodies equal
today's, snapshot test):

| Lane | Author | Followers | Engagements | KOF the bot can tell at read | Google's own | Tags the source carries |
|---|---|---|---|---|---|---|
| `sonar` (EWS:489-527) | handle from the link, else username (EWS:502-510) | `follower_count` | likes + comments + shares (EWS:512) | new column `kofl`: `influencer_list` and `influencer_list_names` (today dropped, EWS:522-523), minus `RX_NOT_KOF_LIST_` (Alert.gs:38); DSD's KOF authors; the KOF sheet | no | new `stag`: the smart tag when it is an official tag name (BQ:1709-1712); `isnew` shown only |
| `spk` Sprinklr comments (EWS:434-446) | `author_username` | `author_followers` | likes + replies | DSD's KOF authors (same handle and platform); the KOF sheet | no (a comment) | — |
| owned facts (new, US job) | the account | — | comments, negative share | — | **yes** | the owned-post rule |
| `bw` nightly (EWS:447-456) | `author` | `reachEstimate` | new `eng2`: likes + comments + replies + retweets + shares (as BQ:1916) | new `kofl`: tags starting "KOF" (BQ:1919); DSD; sheet | no | new `stag`: Brandwatch's SLRR exposure tag via `pwSourceTax_` (PW:1384-1410) |
| `tub` Tubular (EWS:528-538) | creator name (weak) | subscribers | `total_engagements` | the sheet by exact whole cell | no | — |
| `ami` AMIE (@50aa822, no reader yet) | as SPEC:290-340 | as SPEC | **none** (SPEC:522): tier HIGH = 2,000+ | `KOF` column, KOF feeds (SPEC:293-298) as `kofl` | — | — |
| `bwl` Brandwatch live (not built) | the API's author | NOT VERIFIED | NOT VERIFIED | its KOF tags NOT VERIFIED; the sheet | — | NOT VERIFIED |

**KOF from the sheet** (decided in code for the first time). A handle index `rqKofIndex_` built from the knowledge cache's
copy of the KOF sheet (`kof_lists.p0_kof_sheet`, CFG:259-260; ~3,000 rows, KN:56) with the cell rules of
`knowledgeKofCellHit_` (KN:953-962), recording per handle the network a profile link names, or `*`; where the cache says
the sheet was cut, the rest is read once per change with `knowledgeKofLive_` (KN:1035) (W-B8). Rebuilt only when the
knowledge cache's Drive check (every 15 min, KN:57) says the sheet changed, outside the check's 40 s. A post matches when
the handle is equal and the network is equal or `*`. A sheet hit is a code pass (`KOF_SHEET`), but `kof` is **not** set in
the review's fields: Burson's review decides it with `kof_fit` (Generated.gs:1624; CFG:238) (W-B7). Only a source's own
list sets `kof: true`. "No" from code never fails a post (MR §3). Engine tab: rows indexed / rows on the sheet.

**The owned facts** (W-B9, DOOR RQ6). Under the setting the US job adds `bqSprinklrPostStatsSql_(72 h, 72 h)`
(BQ:1012-1024) for posts with a comment appended to the raw comments table in this check's window, naming Google
(`bqGoogleTextSql_`), not in the SLRR log (7 days). Bytes **NOT VERIFIED**: `measureEngineLive()` dry-runs it; if it costs
more than Sonar's job, it runs every third check.

**Cost.** ~0.1 ms a post in Node: 2,000 posts 0.19 s with one call a post, 0.35 s with two (Q [RAN]); Apps Script's factor
**NOT VERIFIED**. Timed per check on the Engine tab; past 3 s, the posts beyond the first 1,000 (risk terms, then
engagements) are checked after grouping (Q14).

### RQ3. The quick judgment

**Decision.** A per-post quick look in Decisions.gs (`decPostInput_`, `decPostQuestions_`, `decPostAsk_`) asked by
`rqJudgeRun_(ctx)`, the **last background step of the Auto-correct flow**, after `earlyDetection()` and `pollDirect()`
(AC:205-211), through OPEN S11's `decSignalAskAll_` (one `UrlFetchApp.fetchAll` a batch).

- **Asked:** `about_google` (today's question, "the post in `text`"), `category` (today's 48 options with their own
  descriptions, DEC:511-525), `sensitive` (new: the 12 Sensitive Topics with their CFG descriptions plus `none`),
  `severity` (today's scale, DEC:484-505; kept for ranking and measuring, not a pass reason this round).
- **Knowledge docs in the call:** the taxonomy only (the config's copy of the Collection Requirements). No Resources text,
  no Guidance, no KOF rows, no numbers (code's). No author, handle, link, follower count, engagement or id is sent
  (DEC:14-24, 375-388).
- **Input:** `{"signal": "one post", "platform": …, "posted_at": …, "text": …}`, text cleaned by `decCleanText_`, at most
  600 characters (EWS:131). Under 20 characters of clean text: not asked ("too short", counted).
- **Answer kept** (`decPostCompact_`): `{g, c, cp, p0, st, sp, sev}`, about 90 characters.
- **From answer to verdict** (`rqDecide_`, pure): `g < 0.20` -> fail (not about Google). `exposure_tag` = the most probable
  P0 tag when the P0 share >= **0.35**; otherwise the chosen tag only when its probability >= 0.80 (W-A7), else blank.
  `risk_tags` = the top topic when its probability >= 0.35, **or** when the topic share (1 - P(none)) >= 0.35 (counted as
  "spread", F-P10). `g >= 0.50` lifts `EXCLUDED_GOOGLE_AS_VERB` (W-A6). Then `escalation_` again: `track !== null` ->
  quick pass. A safety refusal (DEC:79) -> quick pass `refused` (permissive; no daily count, F-P15). The owned-post tag is
  never a quick pass (it needs Sprinklr's numbers).
- **Why 0.35:** the only recorded P0 shares are the 8 story answers: lawsuit 0.58, suicide-chats lawsuit 0.354, CERT-In
  0.04, the 5 noise 0.00-0.01 (W probe on FX `signal_responses`); a single post's shares are likely flatter (**NOT
  VERIFIED**). The bar is measured in the counting-only state (S19d) at 0.30 / 0.35 / 0.40 / 0.50 and set in S19e's commit; never above
  the value that keeps a recorded true pass. **The bar guard** (automatic, S19e): +0.10 (up to 0.65) after a day with 50+
  quick passes of which fewer than 1 in 10 were confirmed, **only if** no post alerted later in the last 48 h had a share
  between the old and the new bar; -0.10 a day when 1 in 3 or more are confirmed.

**Tokens and time a call.** Questions 16,785 characters + input ~700: **~3,900 input tokens, no output (estimate)**
[RAN q.js]. 0.25-0.46 s a call from a laptop (DEC:46-52); from Apps Script and how many requests `fetchAll` runs at once:
**NOT VERIFIED**.

**How many at once, and the slice.** One post a call. A batch starts at 10, +10 after each batch under 3 s (up to 50); the
run stops asking after any batch over 3 s (Q11). The slice: a **new** batch starts only while the flow has at least 30 s
left beyond it and the slice (at most 20 s of the run) is not used (a sent batch cannot be cut: DEC:41-42). Before each
batch: one listing of S-F Burson (OPEN yield to Burson); the ledger (no per-post look at f >= 0.70); the fetch ledger (none
at 0.70 of the fetch budget, F-P1); its own ApiGuard kind `decisions_post` (153 a minute, Q3); its own pause
`DECISIONS_POST_STATE` (more than half a batch failed: 15 minutes; 429s halve its pace for 10 minutes and nothing else, Q4);
the back-pressure rule (F-P3). Ask order: a P0 risk-term group first, then P1 (EWS:220-227), then `gated` and fresh before
late, then most engagements, then newest.

**The carry.** Posts read in a check wait in `rqj:N` (record: id, key, lane, platform, author, followers, engagements,
posting time, KOF hint, text: <= 1,150 characters; 80 a 95,000-character item; at most 1,000 records = 13 items, newest-
ranked) and are judged in every run's slice while fresh (180 minutes from the bot's read). Overflow: "not reached: carry
full". A dropped chunk: counted lost (OPEN's manifest rule). Answers are reused 3 hours by text hash (`chash`, EWS:395) in
`rqa:N` (~30 characters each).

**Never sent:** code passes and code fails (RQ2); repeats and reposts (RQ2 step 0); copies (key + who, OPEN O1.3; same
`chash` in 3 h); posts dropped before the check by today's lane SQL (positive, non-English, bots, Grok, deleted,
Google's own accounts, EWS:380-384, 442-444, 474-480); under 20 characters; anything while row 51 or the setting is off,
the look is paused, the ledger is at 0.70+, the fetch ledger at 0.70+, the rate ceiling is reached, the reviews are full, or
the derived day ceiling is reached (all counted by cause and source on the Engine tab).

### RQ4. Passed alone: quick review and alert

**Decision.** A pass becomes a record in `rqm:N` (chunked cache list, manifest in `EWS_STATE`, never in the buffer, F-P5).
At the top of every run's drain (`edDrainQueue_`, ED:1867), `rqQueue_` moves `rqm` records into the Early Detection queue
as signals of kind `REQUIREMENT_MET` (`ED-REQ-<post key hash>-<stamp>`), so a pass made in a check is reviewed in that
run's drain, not at the next check (`earlyWaveCheck_` runs only every interval, BQ:4251-4252).

| Stage | What | Code place |
|---|---|---|
| Queue order | rank 1 code passes (owned, KOF from a source list, 2,000+, source P0 / topic, then KOF sheet); rank 2 today's serious stories and flags (`edSerious_`, FT:371-383); rank 3 quick passes by `max(p0, sensitive)`, then "spread", Launches and refusals last. Quick passes hold at most 8 of the 24 places and never push a story row out (Q5) | `edQueueRank_` BQ:3951-3963 |
| One post, one path | `seenPost` with the comment key and story-card exception, right before the review and again right before posting | AM:1006-1045; BQ:2335 |
| Review | `reviewAlert_` (Review.gs:134) on `parseAlert_` (Alert.gs:356) of the card text built by the source's Direct builder (owned BQ:1505, DSD / nightly BQ:1557, Sonar / Tubular BQ:1709; new builders in the same format for a Sprinklr comment and for AMIE / Brandwatch live), with the `bq` enrichment (owned counts, the source's KOF), the `[Why now]` line cut from the review's input. One at a time this round (batching it is section B6), under the ledger and yield to Burson | Review.gs; BQ:1192-1201 |
| Decision | `escalationFor_` (Drafts.gs:231) then `aiVeto_` (Drafts.gs:303): the decision of every Burson alert. Met = `track !== null` and no veto | Drafts.gs |
| Card | met: `bqPostCard_` (BQ:2951) in the Auto-correct space, claimed (`mem.claim(key, 'early', info, {overStoryCards})`), then `handleNewAlert_(ctx, m, parsed, review, report, history)` (Bot.gs:1095) with the stored review: the corrected alert, the write-up, the "Alert requirements" line, the Social Alert email (while Testing only to `Control!B30`; none when B30 is blank). The message is marked handled in the flow's store so the B10 loop never reviews it again. The plan's `edStoryPrior_` fix (`Math.min(2, keys.size, L.keys.size)`, ED:1169, OPEN WR-M8) comes from S15 | BQ:2951; Bot.gs:1095 |
| Not met | no card; counted (rate 1); a code pass rejected gets T4a on the Early Detection tab; a quick pass rejected only the Engine count and "Why not?" (F-P17); the seen set marks it `r` | EDN:168 |
| Waiting too long | a code pass not reviewed in 60 min: posted raw as a Direct card (registered in `BQ_INGESTED_MSGS`, BQ:1618, reviewed in B10 as today) while fewer than 3 bot cards wait; T4e. A quick pass at 180 min: T4d | BQ:1614 |
| Growth | a post marked `r`, or carded with no email, crossing 2,000 / 10,000 / 50,000 (AM:83) gets one more review (W-A3) | — |
| Same story | a pass whose story (cluster id) or alert-memory story (AM:90-91) already has a pass card in the last 24 h goes as a thread reply under it, with a review only when it raises the alert memory's stakes (a new tier, a first KOF, a P0: `AM_EXEMPT_TIERS_`, AM:84) (F-P12) | AM:84-91 |

**Texts a person reads** (lengths [RAN] `len.js`; the card stays under Chat's 4,000, Bot.gs `MAX_TEXT_`):
- `[Why now]:` line on the card, one of:
  - `[Why now]: checked alone first: a KOF author (CAM Tech/AI (INFs)), on the list the post's source gives` (102)
  - `[Why now]: checked alone first: the author's handle is on the KOF sheet (tab Tech); the review checked it is the same
    account` (125)
  - `[Why now]: checked alone first: 2,540 engagements (2,000+ is the bar)` (69)
  - `[Why now]: checked alone first: Google's own post with 41 comments, 37% negative (30+ comments and 30%+ negative is the
    bar)` (124)
  - `[Why now]: checked alone first: the listening tool tagged it P0 (Content - Negative reaction to Google influencer
    post/activity)` (128, longest tag)
  - `[Why now]: checked alone first: the listening tool tagged a Sensitive Topic (Medical Content / Medical
    Misinformation)` (118)
  - `[Why now]: checked alone first: the quick check found a likely P0 issue (Content - Negative reaction to Google
    influencer post/activity, 62% sure); the review confirmed it` (171, longest)
  - `[Why now]: checked alone first: the quick check found a likely Sensitive Topic (Medical Content / Medical
    Misinformation, 48% sure); the review confirmed it` (156)
  - `[Why now]: checked alone first: the quick check could not read it (its safety filter refused the post); the review
    confirmed it` (127)
  - raw: `[Why now]: checked alone first: 2,540 engagements (2,000+ is the bar). Posted before its review: the bot's reviews
    were full for an hour` (136)
- Same-story reply: `🔗 *Same story:* another post that meets a requirement on its own: X, 2,540 engagements (2,000+)
  <link|post>` (145 with a sample link).
- The "Alert requirements" line: today's forms (REQ:24-45), no new form.
- Early Detection tab endings (through `edNote_`, EDN:168, counted once in C19): T4a `Checked alone: it met a requirement by
  the numbers (a KOF author), but the full review found no Social Alert (Gemini: not newsworthy, 92% sure). It stays in
  its story` (166); T4b `Checked alone: taken by another path (a Direct BigQuery card was already posted for it)` (87); T4c
  `Checked alone: taken by another path (its Social Alert already went out: QA-12345)` (82); T4d `Checked alone: the quick
  check found a likely requirement, but the reviews were full for 3 hours (12 more serious posts first); it is in its story
  only` (151); T4e `Checked alone: it met a requirement by the numbers; the reviews were full for an hour, so its card went
  to the space to be reviewed there` (137).
- `[Why now]:`, `🔗 *Same story:*` and `*First check:*` are added to `Voice.gs isBotFormattedText_`, `Outbox.gs
  OUTBOX_GUARD_PATTERNS_` and the leak audit's deny list (V2 P0b, OPEN O8); every new text goes through
  `slrr_test_leak_guard`; nothing is posted to B25 or B26; `[Why now]` never reaches a review input, a write-up or an email.

**Worked timelines** (minutes from the bot's read of the row, t = 0 at the check; before it come the source's lag and 0-5
minutes to the next check; one run a minute, one at a time, Main.gs:287-290; review median 37-46 s, p95 80-133 s,
GEM:118-121; arithmetic, end to end **NOT VERIFIED**):

| Moment | A KOF's post (Sonar list, 12 engagements) | 2,500 engagements (Tubular, first read at 2,500) | 40 followers, a new P0 issue (Sonar, 3 engagements) | A quick pass the review rejects |
|---|---|---|---|---|
| t = 0 to +0:40 | code pass in the check, into `rqm` | same | "judge", grouped, into the carry | same |
| quick look | — | — | the same run's last slice, if time is left (+0:40 to +3:00); else the next run's (+1 to +4.5 min) | same |
| review starts | the same run's drain when 150 s of the flow are left after the check (OPEN:578); else the next run: +0:40 to +4:30 | same | the next run's drain: +1 to +4.5 min after the answer | same |
| review ends | +40 s median (p95 +133 s) | same | same | same |
| outcome | card, requirement line, Social Alert draft (KOF; Gemini can veto a KOF-only alert at 0.9, Drafts.gs:311-315) | card, draft (2,000+) | card, draft (P0) | no card; counted; the post stays in its story |
| total after the read | **~1-6 min** | **~1-6 min** | **~2-10 min** | **~2-10 min** to the count |
| today | a Direct card at the 5-min poll, reviewed the next run: ~5-7 min (MF §4.1) | Direct at 500+ in its poll: ~5-7 min (and earlier, at 500) | **no path alone** (MF §2.1) | — |

During S19d (counting only) a quick pass makes no card; from S19e it does. On a busy day passes wait their rank; code passes
before serious stories, quick passes after them.

### RQ5. Failed alone: clustered, whatever its size

**Decision.** Every post read is grouped as today, whatever its size; only alerted links, Google's own accounts and the
SQL drops RQ3 lists stay out; `gated` posts are checked but not grouped (their text gates were set for grouping,
EWS:59-76, 128-130). Passed posts stay members marked `rq: 'm'` (OPEN O1.5: the alert memory marks, it does not drop).

| Item | Today | Under the setting | Code place |
|---|---|---|---|
| Size gate | followers <= 5,000 (or unknown) and engagements < 500, in SQL | out of `WHERE`; a column `big` (used for bars, velocity, ordering and counts only) | EWS:126-127, 381 |
| KOF authors | dropped (Sonar lists, DSD's KOF authors) | kept as members; DSD's KOF authors a KOF list | EWS:467-472, 522-523, 758-762 |
| Similarity bars (0.80 / 0.82 / 0.83) | set on 1,198 and 3,900 small-account posts | unchanged until measured; S1 gains a `big` band (300 posts of 24 h with `big` true, judged by Gemini as A1 says); a failure writes `{"big": {...}}` into `OPEN_LANE_BARS`; a pair with a big post uses the higher bar | EWS:59-76, 140-142; S1 |
| The bar of 5 accounts (4 on 2 platforms), 2 links | spread, not a requirement | unchanged; a big account counts as one | EWS:151-154 |
| Velocity | small posts only | `big` warms as a lane family 7 days on its own baseline (OPEN S8) | EWS:1286-1396 |
| Embedding order | risk, shared, newest | within a risk group, posts not `big` first (Q15); "big not embedded" counted | EWS:1666-1667 |
| The pool (1,200, 6 h) | | unchanged; the Engine tab shows its oldest post's age; under 180 min, `rq: 'm'` posts leave the pool first (W-B5) | EWS:144-145 |

**What a group is checked against as it grows.** (1) Each member alone, as above; a member that passes gets its own card
and the story is not held for it. (2) The story's early asks at 2-4 accounts (OPEN S11) gain the `sensitive` question and
one raise reason: P0 share >= 0.35 or Sensitive >= 0.35 (CFG:366, 378, 396 need no threshold). (3) At 5 accounts: today's
signal and review, decided as today for stories (ED:522-630); ending that decision in `escalation_` is section B6.
(4) Not applied: a sum of members' engagements against 2,000; Burson's bar is per post (ESC:118-123).

**Words that say "small accounts" or "low-tier"** (all under the setting; with it off every text is today's; one sweep
test over every text the fakes produce):

| Place | Today | Under the setting |
|---|---|---|
| REQ:52 `REQ_EARLY_CAUSE_` | `small accounts, no KOF author, no P0 tag` | built from the marks: `none of its 8 posts met a requirement alone; 2 were not checked` (63) or `1 of its 8 posts met a requirement alone and has its own card`; whole line 164 / 162 (B1) |
| ED:1527 taxonomy line | `*KOF:* No (8 small, non-KOF accounts)` | `*KOF:* No (none of its 8 accounts is on a KOF list the bot holds)` (65) or `*KOF:* 1 of its 8 accounts (that post has its own card)` (55) |
| BQ:2421, EDC:61-67 | `5 small accounts on X and Reddit` | `🔗 *Part of a story:* 5 accounts on X and Reddit tell it (<link|story card>)` (108 with a sample link) |
| ED:1456, 1468, 1573 | `Small accounts posting …`, `8 small accounts on X posted about this` | `Several accounts posting …`, `8 accounts on X posted about this` |
| EWS:1425, 1471 headlines; ED:1453 its parser | `Low-tier claim cluster (N accounts): …`, `Low-tier velocity …` | `Claim cluster (N accounts): …`, `Velocity …`; ED:1453's pattern accepts both |
| BQ:3434-3471, ED:1308-1324 labels | `Emerging low-tier discussion`, `Low-tier semantic cluster emergence`, `Low-tier velocity spike`, `Multiple low-tier authors`, `distinct low-tier authors`, `low-tier mentions`, `Early watch (a few low-tier accounts …)` | the same without "low-tier"; `Early watch (a few accounts on one story, below the usual bar)`; the engagement label from `levelFor_` of the post's count |
| ED:134 parser; EDC:80 regex | read only `low-tier mentions`; strip only `N accounts` / `Small accounts posting` | `(?:low-tier\s+)?mentions`; `(?:[\d,]+|Several|Small) accounts posting`, in the same commit (W-B6) |
| ED:400-401, 626, 1797 | `benign low-tier chatter` (shown on the tab) | `benign chatter` |
| ED:503-505 (`edBuildEscalation_` basis); Drafts.gs:1800 ("Why:" fallback) | `low-tier semantic cluster …`, `low-tier semantic cluster or velocity spike` | `semantic cluster …`, `semantic cluster or velocity spike` |
| Review prompt ED:833, 839, 851, 873, 1044 (Gemini reads) | "across small accounts", "low-tier by design", "across the low-tier posts", "among small accounts", "open-world low-tier Early Detection layer" | "across posts that met no alert requirement one by one (every size, each checked alone first)"; "this pipeline groups posts that met no requirement alone"; "across the posts"; "of posts that did not meet them one by one"; "open-world Early Detection layer" |
| Review.gs:862 (Gemini reads, every flow) | "threshold-qualified posts (100+ engagements, …)" | `alerts against the escalation thresholds (2,000+ engagements, KOF authors, P0 exposure tags or Sensitive Topics at any engagement, or 30+ / 30%+ negative owned-post comments)` (174); its own test (the prompt says 2,000+, never "100+ engagements") |
| EDT:42, Control.gs:144 (row 19 help), OA:1127 | "posts from small accounts", "small accounts are starting to tell …", "several small accounts told the same story" | "posts that met no alert requirement on their own (any size)", "several accounts are starting to tell before any one post meets an alert requirement", "several accounts told the same story"; Control.gs's help is rewritten once with OPEN's move of the help to row 53 |

### RQ6. One post, one path

**Decision.** Direct BigQuery, the Watch and Burson's own alerts keep their paths. The alert memory decides, at three
moments: before the check (RQ2 step 0), before the review, and right before the card (`claim`, false -> T4b).

- **Keys** (W-A1): comments `id:spk:<comment_id>` (AM:181 keeps an `id:` key); every other post `amPostKey_(url)` plus who
  (OPEN O1.3).
- **Story cards** (W-A2): the claim and the checks pass `bqOnlyStoryCards_` (BQ:2335-2345) as Direct does.
- **Direct BigQuery**: unchanged, its 500 floor (BQ:1600-1608) and DSD included (OPEN A3, O3 row 26). It already refuses a
  claimed post (`alreadySeen`, BQ:2627-2633). Race: if Direct's raw card is posted first (it claims after posting,
  BQ:2715), our queued pass ends T4b before its review; if ours is first, Direct skips it. Cost at most one review, never a
  second card. With row 15 OFF the producer's check is the only door for these posts.
- **The Watch**: `pwSolo_` and OPEN S13 unchanged. Its poster (WA:1815-1858) reads `RQ_PENDING` (post keys of queued
  passes): a flag for a queued post waits one check (at most 10 min, Watch detections status `waiting one check: the first
  check is reviewing this post on its own`, 68), then goes on as today if the post is still unclaimed. `otherCollected_`
  counts a Sensitive Topic as collected (W-A8). The Watch's own owned-post rule (25 negative or 30% of 20, PW:115-118)
  stays the Watch's.
- **Burson's own alerts**: untouched (AC:124). A post Burson alerted before the check is skipped (SLRR log, alert memory);
  one Burson alerts after our email is a repeat (REQ: "the other flow already sent it").
- **The story holding a passed post**: stays a member; the story card gets V2 P4a's cross note; when the story's main post
  is the carded pass, the story card goes as a reply in that card's thread (F-P12; story cards are not triaged by B10, so
  OPEN's refutation FL-F4(c) does not apply). One issue, one email (AM:90-91; G2.2).
- **OPEN S15 (`SINGLE_POST`)**: dropped; its `edStoryPrior_` fix and the claim at posting move into S19b.
- **Direct's 500**: stays; it no longer decides whether a post is checked against the requirements, because the producer
  checks every post it reads. Direct cards for posts the check failed are counted as misses (RQ8).

**What this cannot give:** a Sprinklr comment or nightly row that grows past 2,000 after its read (only Sonar re-receipts
and Tubular re-reads are re-checked); posts the lanes' SQL drops (positive, non-English, bots); what a text-only look cannot
see (pictures, video, who the author is); posts not reached (counted); owned posts older than 72 h; sources the producer
does not read (the Watch's Brandwatch-live election query PW:101-104; Brandwatch for X, never); the lateness of slow
sources (nightly 1-6 days, PW:49; Tubular ~39 h median, README.md:299).

### RQ7. Quick, and what it costs

**Posts a day** (recorded figures; everything else **NOT VERIFIED**; F `calc.js` arithmetic):

| Stage | Normal, today's sources | Normal, all sources | 5x day, today's | 5x, all |
|---|---|---|---|---|
| Read a day (upper bound: Sonar ~22,000 PW:47-48; comments 2,000-5,600 EWS:58-60; nightly <= 600 a read; Tubular <= 2,400; AMIE ~24,800 SPEC:388; Brandwatch live <= ~86,000 OPEN:80-82) | ~30,600 | ~141,400 | ~153,000 | ~707,000 |
| A 5-minute check | ~106 | ~491 | ~531 | ~2,455 |
| Code passes | (A) 30-100 (Burson alerts ~55 a day, PW:46-47; DSD ~42, README.md:303) | NOT VERIFIED | (A) 150-500 | NOT VERIFIED |
| Quick looks (calls) | <= ~30,500 | <= ~141,300 | <= ~152,500 | <= ~706,500 |
| Tokens (~3,900 a call, estimate) | ~119 M (~83,000 a minute) | ~551 M (~383,000 a minute) | ~597 M | ~2.76 B: over the recorded 1,000,000 a minute |
| Judged at most under `decisions_post` (153 a minute = ~220,000 a day) | all | all on average | all on average | ~31% |
| Against the UrlFetch day (100,000 Workspace / 20,000 consumer, training figures, **NOT VERIFIED**) | 31% / 153% | 141% / 707% | 153% / 765% | far over |

Copies, the lanes' English and positive gates and reposts lower "sent" by an amount not recorded. Peak minutes: NOT
VERIFIED. **The binding walls** are the review room and the UrlFetch day, not tokens, on a normal day (F section 2).

**Time each stage adds.** To a check: the code check (~0.19 s for 2,000 posts in Node; Apps Script NOT VERIFIED), outside
grouping's needs; the KOF index rebuild only on a sheet change, outside the check. To a run: at most a 20-s slice at the
end of the flow, only in time nobody else needs. A day: if `fetchAll` runs 50 at once at ~1.5 s a batch (A), today's
sources ~0.26 h, all sources ~1.2 h of run time, on the ledger. If it runs fewer at once, fewer posts are reached in the
slice (counted), never a longer run.

**Full reviews a day.** Code passes (A) 30-100 at ~40 s each (serial Burson review) = ~0.3-1.1 h. Quick passes: whatever
the review room allows. The room on a normal day is (A) ~300 reviews (F section 2: the ledger's 4.5 h less the plan's own
work); a quick look passing 1% of today's sources (~300) already fills it, so on most days **the back-pressure decides**,
not the bar: passes wait ranked, then further asks stop ("not reached: reviews full"). The 2,000 stop is not the bound
(F section 2); it still counts every review.

**The rules that keep it quick** (all automatic, none asks the owner): grouping never waits (the quick look is not in the
check); a code pass never waits for Gemini (its own list, read by every run's drain); the quick look runs last, in a
slice, and a new batch starts only inside it; fail open (slow, refused, paused, 429: the post stays in its story); its own
rate kind and its own pause; the ledger (none at 0.70+), the fetch ledger (none at 0.70+ of the fetch budget), the
back-pressure, and the derived day ceiling `min(150 x 2,000, 0.5 x fetch budget)`.

**C51 texts** (each <= 200, `noteSwitch_` cuts at 200, Control.gs:842; warning first, as OPEN O7):
- normal: `today: checks every 5 min · 132 of 2,000 reviews · quick check 24,310 of 25,150 posts · run time 2 h 05 of 4 h 30
  (24 h) · walls hit: Gemini busy 2×, run short 14×, Burson first 3× · Engine tab` (193; the quick-check part sits before
  "walls hit" so the cut never takes it);
- counting-only (S19d): `today: checks every 5 min · 132 of 2,000 reviews · quick check (counting only) 24,310 of 25,150 posts · run
  time 2 h 05 of 4 h 30 (24 h) · Engine tab` (149);
- paused: `⏸ quick check of single posts paused 15 min (Gemini didn't answer): posts go to the stories as before; KOF, 2,000+
  and owned-post checks go on · Engine tab` (155);
- reviews full: `⏸ quick check of single posts held: 40 likely passes wait for a review. New posts go to the stories as
  before; KOF, 2,000+ and owned-post checks go on · Engine tab` (163);
- fetch wall: `⛔ fetch limit: 71,000 of 100,000 calls today. Single posts go to the stories unchecked until the reset;
  Burson's alerts go on` (125);
- ceiling: `⛔ safety stop at 4:12 PM: 300,000 single-post quick checks today. Posts go to the stories as before; KOF, 2,000+
  and owned-post checks go on. No big event? Tell the engineer` (173; the number is the derived ceiling's).

### RQ8. Seen and measured

**What the owner sees.**

| Post | Where | What |
|---|---|---|
| Passed and met | Auto-correct space; Early Detection tab | the card with `[Why now]`, the requirement line, the Social Alert as today; tab row kind `Single post` |
| Code pass, review said no | Early Detection tab | T4a |
| Quick pass, review said no | Engine tab count; "Why not?" | `Why not: read 10:42 AM from Sonar; the quick check said it may be a P0 issue (41% sure), and the full review found no requirement met (P2 tag, 140 engagements).` (160) |
| Failed and grouped | Engine tab counts by source and cause; "Why not?" (OPEN S18, B10 only) | `Why not: read 10:42 AM from Sonar and checked alone: no requirement met (P0 18%, Sensitive Topic 7%, 140 engagements, not on a KOF list). It joined the story "Pixel 10 battery drain" (3 accounts).` (196) |
| Passed, has its card | "Why not?" | `Why not: read 10:42 AM from Sonar; it passed the first check (2,540 engagements) and has its card: <link|card>` (143) |
| Never judged | Engine tab by cause; C51 when paused or held; "Why not?" | `Why not: read 10:42 AM from Sonar; not checked alone (the quick check was paused), so it went to the stories as before.` (119) |

**Engine tab** (OPEN O7.3) gains per check: `alone read`, `code pass` (owned / KOF source / KOF sheet / 2K / source tag),
`gated`, `asked`, `quick pass`, `failed`, `not reached` (slice, rate, fetch, ledger, reviews full, carry full, pause,
ceiling), `quick s`, `tokens`, `refused`, `code check ms`; daily row example `checked alone 24,310 · code pass 31 · quick
pass 212 (confirmed 19) · not reached 840 · at least 3 missed (later alerted) · audit 20: 1 passed` (142).

**Error rate 1: a pass the full review rejects.** Counted at the decision, by lane and by reason row (`owned`, `KOF
source`, `KOF sheet`, `2K`, `source P0`, `source topic`, `quick P0`, `quick topic`, `quick spread`, `quick Launches`,
`refused`) and by the review's cause (tag corrected, ongoing, Gemini's veto, owned veto, English). "Ongoing" is shown apart:
it is the rule working, and it never counts toward the bar guard (W note). Code passes are on their own rows. In
`RQ_DAY` (property, 10 lanes x 12 rows x 2 numbers, <= 3,000 characters) and the Engine tab's daily row.

**Error rate 2: a post the check did not pass that later got an alert.** Looked up when a later Social Alert is decided:
Burson's (B10 handling), a person's (Results / Alert log rows, Speed.gs; sheet-test alerts), another path's (Direct, Watch,
a story). Two records answer: the **seen set** `RQ_SEEN` (chunked cache + manifest, 48 h: key hash, verdict, P0 share,
Sensitive share, severity: 16 characters a post) and, for older posts and the slow lanes, a daily **Bloom filter** per lane
(1% false match; FNV-1a double hashing) on the bot-made tab `Requirement check`. A hit gets one thread note under the later
alert, in the Auto-correct space only:
- `*First check:* this post was read 12 h 10 min before this alert, from Brandwatch live, and did not pass alone (P0 tag 22%
  sure, Sensitive Topic 5% sure; 1,340 engagements, no KOF author).` (187);
- `*First check:* this post was never checked alone: the quick check was paused (Gemini said "too busy"). It went to the
  stories as before.` (136);
- `*First check:* this post was read in the last 7 days and did not pass alone (its numbers are no longer kept).` (109);
- `*First check:* this post was never read by the first check (its source or its text kept it out).` (96).
It is shown as **"at least N missed"** (a floor: it sees only what another path or a person alerts, W-B3), by lane and by the
requirement the later alert met. **The audit** makes it an estimate: each day 20 posts drawn at random from the failed ones
(by lane) get the full review, ranked last among the quick passes; the share the review passes is the day's estimated
false-fail rate (about 20 x 40 s = 13 min of run time). In the counting-only state (S19d) the same lookups say at which bar (0.30 / 0.35 /
0.40 / 0.50) each missed post would have passed.

### RQ9. Into the plan

The setting, the order and the tests are in B4. In one line: S2 gains the fetch ledger; S1, S3, S8, S11 and S18 gain parts;
S15 and OPEN section 6 item 4 are dropped; S19a-S19g are added after S18, each behind row 51 and
`open_requirements_first`.

---

## B4. The steps

**The setting.** `open_requirements_first` (default **true**) in `burson_qa:` of CFG, `BursonQAConfig` in
`triage_agent/config.py`, `Generated.gs` rebuilt with `.venv/bin/python -m scripts.build_apps_script`; read only while row
51 is ON (OPEN O8). False gives back the plan as amended without this section: today's producer gates, today's words, no
single-post path (S15 is dropped). Row 51's ON note becomes B1's text (136). **No new Control row.** Rule for every step:
row 51 OFF byte for byte (`switch_golden_flows.test.js` passes with no update) and the setting false byte for byte (a
snapshot of the producer's two request bodies and of every text); each step runs its own tests by name
(`node apps-script-chat-bot/test/run_tests.js "<name>"`), then the full suite, pytest, `scripts.build_apps_script --check`,
`slrr_test_leak_guard` on every new text, and `node scripts/repo_safety_scan.js` printing `clean` before its commit (V2 2,
AGENTS.md 2.7).

### B4.1 Steps of OPEN that change

| OPEN step (its key as written) | What changes |
|---|---|
| **S1** Same-story check | `verifySameStoryLive()` gains a band `big` (300 posts of the last 24 h with `big` true, every lane), judged as A1 says; its bars into `OPEN_LANE_BARS` as `big`. Test added to `switch_same_story_check.test.js`: the band is sampled and a big post is never in a snippet with its handle. |
| **S2** Row 51, ledger, stop, yield, guards, C51 | adds the **fetch ledger** (F-P1): every request counted in `RUN_LEDGER`'s hourly buckets (still <= 8,800 characters, tested), new plan setting `open_fetch_day` (blank = 20,000 until `measureEngineLive()` records the account's daily count), Burson's reserve, steps at 0.70 / 0.90, C51 fetch text (125). Test added to `switch_run_ledger.test.js`: with a budget of 1,000 and 2,000 posts, no per-post quick look after 700, and Burson's pass still reads and reviews. |
| **S3** Engine tab and visible endings | the columns and daily row of RQ8. |
| **S8** Velocity made correct | `big` is a lane family that warms 7 days on its own baseline. Test: big posts do not spike velocity in their warm-up. |
| **S11** Quick looks for every candidate | `decSignalAskAll_` takes any question set and input shape; the story's early ask gains `sensitive` and the raise on P0 share or Sensitive >= 0.35 (RQ5). Test: a 2-account story with P0 0.60 is raised; one at 0.10 waits for 5. |
| **S13** The Watch: the single worrying post | unchanged in what it does (Q7). |
| **S15** Single small post (needs S11, S5) | **dropped.** Its `edStoryPrior_` fix (ED:1169-1172) and the claim at posting move to S19b. |
| **S18** "Why not?" (needs S3) | the texts of RQ8 from the seen set, the carry and the marks. |
| O0 point 2 ("A single worrying post is acted on alone …") | becomes "A single post that meets a requirement is acted on alone, whatever its size: code checks KOF, 2,000+ and Google's own posts at once; Gemini's quick look checks P0 and Sensitive Topics." |
| O2 table "A single worrying post" | the row "Under 1,000 followers and 100 engagements" becomes "every post: the first check (B)"; "Under the floor with no risk word: not in this round" goes. |
| O3 row 19 (quick looks) | the per-post look has its own derived day ceiling `min(150 x open_daily_stop, 0.5 x fetch budget)`. |
| O3 row 20 (ApiGuard) | adds `decisions_post`: 0.6 x 1,000,000 / tokens a call, a minute (153 at ~3,900), 10x and 60x for 10 and 60 minutes; the stories' 600 / 2,400 unchanged. |
| O4 ledger table | 0.70-0.80 gains "no quick check of single posts; the code check and code passes go on"; 0.80-0.90 "only serious" includes code passes, and quick passes only for requirement rows confirmed 1 in 3 or more over 50+ reviews. |
| O8 settings | `open_requirements_first` (true) and `open_fetch_day` (blank) added. Heads `[Why now]:`, `🔗 *Same story:*`, `*First check:*` added to the guard lists. |
| Section 6 item 4 | removed: a single post with no risk word is judged in this round. |
| Section 8 | replaced by B7. |

### B4.2 Steps added (after S18; each small enough for one engineer)

| Step | What it does | What it alone gives the owner | Files | Tests (new names) | Must not change | Depends on |
|---|---|---|---|---|---|---|
| **S19a** Code check, counted | SQL columns `big`, `kofl`, `stag`, `eng2`, `isnew`, and the `gated` rows (kept out of grouping); DSD's KOF authors as a list; the owned facts; `rqKofIndex_`; `rqCheckPost_` (steps 0-3); the seen set; the producer's deadline tied to the flow's; Engine columns. Big posts are read and **checked**, not yet grouped; no pass row | how many posts a day meet a requirement by code alone, by source, and the size of the mid-size gap (MF §5: "not recorded anywhere") | new `RequirementsFirst.gs`; `EarlyWaveSource.gs` (126-127, 374-410, 429-540, 717-762, 1692-1715); `Knowledge.gs` (index beside 944-1045); `EngineTab.gs`; config trio + `Generated.gs` | `switch_rq_code_check.test.js`: the MR cases and RQ2 table give the same track as `escalation_`; a Sonar KOF-list post at 3 engagements is a code pass; "Google owned channel" is not a KOF; 1,999 judge, 2,000 pass; owned 30 / 30% passes, 29 / 30% and 30 / 29% do not; spam at 2,500 judge; "Google that" with no product judge; a DSD KOF author on another platform is no KOF; a sheet row on another network does not count, a bare handle counts as `KOF_SHEET` without `kof`; the index of 3,000 rows <= 2 items; a 36-character post comes back `gated`; setting false: request bodies equal today's | stories, Direct, Watch; the 40-s check (timed) | S2, S3, S7 |
| **S19b** Code passes reviewed and carded | `rqm` list; `rqQueue_` at the drain's top; rank 1; `REQUIREMENT_MET` kind; Burson review in the drain (`reviewAlert_`), `escalationFor_` + `aiVeto_`; card only when met (Direct format + `[Why now]`), `handleNewAlert_` with the stored review, message marked handled; claim with comment keys and `overStoryCards`; `edStoryPrior_` fix; raw Direct card after 60 min; T4a-T4c, T4e; the story's requirement cause from the marks (A13); Review.gs:862 and the prompt lines under the setting | a KOF's post, a 2,000+ post or Google's own post past 30 / 30% from any source is reviewed and alerted alone within minutes, once | `RequirementsFirst.gs`; `EarlyDetection.gs` (1754-1903, 1169-1172); `BigQuery.gs` (3951-3963, 1505, 1557, 1709, 2951); `AlertMemory.gs` (1029-1045: `opts.overStoryCards`); `FastTriage.gs` (371-383); `RequirementLine.gs:52`; `Review.gs:862`; `Voice.gs`, `Outbox.gs` heads | `switch_rq_decide.test.js`: a code pass the review confirms gives one card and one draft with track HIGH_ENGAGEMENT (not forced URGENT); the decision equals `escalationFor_` on the same review; a P0 hint never enters the fields; a YouTube-subject KOF post gives the YouTube ping, no email; an owned post the review finds at 10 comments gives no card; a KOF-only pass Gemini rejects at 0.92 gives no email; `handleNewAlert_` with a stored review makes one requirement line and the B10 loop never reviews the card again; `[Why now]` is in no review input, write-up or email; Testing with B30 blank sends nothing. `switch_rq_one_path.test.js`: Direct's raw card first ends ours T4b with no review; ours first makes Direct skip it; a monitor story card first, then a KOF pass on its main post: one card, one email; a KOF comment under X then X at 41 comments 37%: two cards; a code pass not reviewed in 60 min is posted raw once; a story with a carded member never reads "none" | Burson's pass; Direct and its 500; the Mirror flow | S19a, S4, S5 |
| **S19c** One path with the Watch, and growth | `RQ_PENDING` and the Watch's one-check hold; `otherCollected_` with Sensitive Topics; the grown read (Sonar re-receipts, Tubular on change) and one more review per tier; same-story replies; the story card as a reply under a carded main post | the Watch and a passed post never make two cards or decide one post two ways; a post that grows to 2,000 after a "no" is reviewed again | `WatchAlerts.gs` (1815-1858), `OtherAlerts.gs` (760-767), `EarlyWaveSource.gs` (489-527), `RequirementsFirst.gs`, `EarlyDetectionCross.gs` | `switch_rq_watch.test.js`: a Watch flag and a queued pass: one card, by `escalation_`; with the quick look paused a listening-tool P0 flag at 12 engagements goes alone as today; a held flag goes after 10 min if unclaimed. `switch_rq_growth.test.js`: a rejected pass at 3, then 2,100: one more review and one Social Alert; two passes on one story: one card and one reply | `pwSolo_`, S13, the Watch's SQL | S19b, S13 |
| **S19d** The quick look, counting only | `decPostInput_`, `decPostQuestions_`, `decPostAsk_`; `rqJudgeRun_` last in the flow; slice, batch growth and stop; `decisions_post` ApiGuard kind; `DECISIONS_POST_STATE`; ledger, fetch ledger and yield; the carry `rqj`; answers `rqa`; verdicts counted at four bars, no pass row; C51 counting-only, paused and fetch texts | before any quick pass reaches a review: pass rates by bar and topic, tokens and seconds a call and a batch in Apps Script, posts not reached and why, misses against Burson at each bar | `Decisions.gs` (36-80, 198-215, 304-360, 422-625), `RequirementsFirst.gs`, `AutoCorrect.gs` (after 205-211), `ApiGuard.gs` (19-36, 112-143), `OpenEngine.gs`, `Control.gs` (C51) | `switch_rq_quick_look.test.js`: four questions, 48 + 13 options, descriptions equal to GEN's; the input has no link, handle, follower count, engagement or id; one `fetchAll` of N; a 30-s fake gives one batch, then the run stops asking; the story forms in the same check as with the setting off; a code pass is reviewed in the same run as with the look off; 2,000 asks leave a story ask unrefused; 50 per-post 429s leave the story's `decSkipWhy_` empty; at f = 0.75 no call; at 0.70 of a fetch budget no call; a carried post is asked next run and left at 180 min; the same `chash` costs no call; C51 texts <= 200 in every state | the stories' fast triage and its pins (`switch_fast_triage.test.js:902-915`) | S19a, S11, S2 |
| **S19e** Quick passes live (a separate deploy after at least 7 days and 5,000 asks of S19d) | quick passes into `rqm` at the bar set in this commit from S19d's counts (0.35 unless the counts say lower); rank 3 and 8 places; back-pressure; the bar guard; refusals, spread and Launches last; the daily audit of 20 | a P0 or Sensitive post from a 40-follower account is reviewed and alerted alone within minutes | `RequirementsFirst.gs`, `BigQuery.gs` (3951-3963), `EarlyDetection.gs` (drain) | `switch_rq_quick_pass.test.js`: P0 share 0.72 on a 40-follower post gives one review; 0.30 none; Child Safety 0.64 with a privacy tag at 0.45 passes; Privacy with a privacy tag at 0.85 does not (redundant pair); Politics, location India, no election word: none; a refusal passes; 30 quick passes and 12 story signals keep every story row; at f = 0.85 a serious story goes before 30 quick passes; with 40 passes waiting and the ledger short no new asks and C51 reads "held"; the guard raises the bar only when no later-alerted post sat between the bars; 20 audit reviews a day, ranked last | code passes' order; S19d's counts | S19b, S19d |
| **S19f** Every size grouped | the size line out of `WHERE` for grouping; KOF posts as members; `big` bars from S1, warming from S8; embedding order; the pool rule; the wording sweep and both parsers (RQ5) | stories made of every post that met nothing alone, whatever its size | `EarlyWaveSource.gs` (126-127, 381, 522-523, 1286-1396, 1425, 1471, 1666), `EarlyDetection.gs` (134, 400-401, 503-505, 626, 833-873, 1044, 1306-1333, 1451-1475, 1520-1528, 1573, 1797), `EarlyDetectionCross.gs` (61-80), `BigQuery.gs` (2421, 3434-3471), `Drafts.gs:1800`, `EarlyDetectionTab.gs:42`, `Control.gs:144`, `OtherAlerts.gs:1127` | `switch_rq_any_size.test.js`: a 20,000-follower post at 150 engagements joins a story of 4 and makes it 5; with the setting false it is dropped as today; no text the fakes produce says "small accounts" or "low-tier" with the setting on; a card's Cluster Spread is still read by ED:134; the cross note strips "Several accounts posting"; big posts do not spike velocity in warm-up | the bars for posts not `big`; the bar of 5 | S19a, S1 (`big` band), S8, S9 |
| **S19g** Misses counted | seen-set lookups and daily Bloom filters on the bot-made `Requirement check` tab (`isRqTab_` beside `isAnalysisTab_`, AGENTS.md 2.5); the lookups at Burson's, a person's and another path's alert; the `*First check:*` notes; "at least N"; the audit's estimate; the Results split (Speed.gs:747, 1230-1231: door cards vs other paths); "Why not?" texts | both error rates every day, by source and requirement, with each miss visible under its alert | `RequirementsFirst.gs`, `EngineTab.gs`, `Bot.gs` (after the requirement decision), `Speed.gs`, `WhyNot.gs` | `switch_rq_measure.test.js`: a quick pass rejected counts once under its lane and row; a code pass rejected on its own row; "ongoing" apart; a failed post Burson alerts two days later counts as missed with Burson's requirement; a post never read counts "never read"; a filter of 30,000 is 2 cells <= 45,000; a person's tab named `Requirement check` is never touched; a dropped cache hour counts "not recorded"; each note <= 200 and only in B10 | other tabs; B25 / B26 | S19a, S3, S18 |

**Dependencies, in one line:** S2 + S3 + S7 -> S19a -> S19b (with S4, S5) -> S19c (with S13); S19a + S11 -> S19d -> S19e
(with S19b, after 7 days); S19a + S1 + S8 + S9 -> S19f; S19a + S3 + S18 -> S19g.

**Stored values and their worst cases** (each tested; summed in OPEN's `switch_open_storage.test.js`, whose 300 KB of
properties gains `RQ_DAY`, `RQ_PENDING` and `DECISIONS_POST_STATE`):

| Store | What | Worst case |
|---|---|---|
| `rqm:N` (cache, manifest in `EWS_STATE`) | pass records (post, facts, reason, quick answer) | ~60 x <= 2,000 = 120,000 characters, 2 items |
| `rqj:N` (cache) | posts waiting for the quick look | 1,000 x <= 1,150 = 13 items |
| `rqa:N` (cache, 3 h) | answers by text hash | ~3,800 x 30 = 2 items (today's sources); ~6 (all) |
| `RQ_SEEN` (cache, 48 h, manifest) | 16 characters a post | 30,600 x 2 x 16 = 979,200 characters = 11 items; all sources 48 items. If evictions are counted, `f` entries with both shares under 0.10 drop to 24 h |
| `rqk:N` (cache) | KOF index | ~3,000 rows x ~33 = 99,000, 2 items |
| `RQ_DAY` (property) | the day's counts | <= 3,000 characters |
| `RQ_PENDING` (property) | keys of queued passes | <= 60 x 40 = 2,400 |
| `DECISIONS_POST_STATE` (property) | day, asked, failed, refused, until, pace | <= 500 |
| `Requirement check` tab | one row a day and lane, 7 days | Bloom 30,000 posts at 1% = 287,552 bits = 47,928 base64 characters = 2 cells; 141,400 posts = 6 cells; cells <= 45,000 (AGENTS.md 2.4); the day's missed list <= 50 links in one cell |
| Engine tab | the new columns | ~2,000 rows (OPEN O7.3), cells <= 20 characters |

Cache items at all sources: ~70 of the ~1,000 shared items (EWS:195-196; the total **NOT VERIFIED**).

---

## B5. Rows for "Every limit that remains" (changed and new only)

| Limit | Kind | Evidence the owner can check |
|---|---|---|
| **Changed:** "Low tier = 5,000 followers / 500 engagements in stories" -> under the setting it no longer decides what is grouped; it remains only as the mark `big` for the similarity bars and velocity warm-up until S1 and S8 measure them | correctness (bars set on small posts) | EWS:59-76, 126-127, 381 |
| **Changed:** "Direct's 500 engagements" -> stays, but no longer decides whether a post is checked against the requirements | business (SLRR leads) | BQ:1600 |
| The quick check runs in what time a run has left, at most 20 s, a new batch only inside it | wall-derived (the 6-minute run) | AC:35-37; Engine tab "quick s" |
| Per-post quick looks: about 153 a minute (60% of the recorded 1,000,000 input tokens a minute / ~3,900 a call) | wall-derived (Gemini's rate limit), tier **NOT VERIFIED** | FX `error_429_live`; Engine tab "not reached: rate" |
| The UrlFetch day: per-post quick looks stop at 0.70 of the fetch budget | wall (platform), number **NOT VERIFIED** | C51; Engine tab fetches a day |
| Reviews room: no new quick-look asks while waiting passes would not be reviewed within 180 minutes | wall-derived (daily run time) | C51 "held"; Engine tab |
| Quick passes at most 8 of the 24 queue places | correctness (today's story signals are never pushed out) | BQ:3348 |
| Carry: 1,000 posts for 180 minutes | wall (cache storage) | EWS:195-196 |
| Seen set 48 hours; Bloom filters 7 days | wall (cache and cell sizes) | AGENTS.md 2.4 |
| Bars 0.35 on P0 and Sensitive shares; a non-P0 tag only at 0.80 | judgment, permissive by design (only "passes too much") | W probe `p0mass.js`; Engine tab rates |
| Posts kept out before the check: positive, non-English, bots / Grok / deleted, Google's own accounts; under 20 characters for the quick look | business (owner's answer; English only) and correctness | owner_direction.md:47-51; EWS:380-384, 442-444; CFG:268 |
| Text only: pictures and video are not seen by the quick look | kept this round (cost) | DEC:3-6 |
| Growth re-checked only for Sonar re-receipts (48 h) and Tubular re-reads | correctness / reads | EWS:494-499; BQ:1601 |
| One more review per alert-memory tier for a post already judged | correctness (no review loop) | AM:83 |
| Day ceiling `min(150 x 2,000, 0.5 x fetch budget)` single-post quick looks | safety | C51 |
| A pass's review is one at a time | kept this round (B6) | Review.gs |

---

## B6. Not in this round, and what only a live deployment can prove

**Not in this round, and why:**
1. **Single-post Burson reviews side by side.** `reviewAlert_` is one call a review and is not split into prepare /
   conclude like OPEN S12's story reviews; batching it touches the review V2 built. Serial this round; the Engine tab's
   review room says when it is needed.
2. **Ending the story's own decision in `escalation_`** (on its main post): Early Detection's 0.8 rule stays for stories
   (ED:589-603), as both designs agree.
3. **One reader per table for all three paths**, retiring Direct's 500 floor or the Watch's 100+: only after the miss counts
   show the check misses nothing they catch (both reviews: retiring on 30 cards proves little, W-B4).
4. **Pictures and video to the quick look**: their risk is often in the picture (Tubular, TikTok); misses are counted with
   Tubular and TikTok shown apart.
5. **Severity as a pass reason** (W-B1): asked and recorded; counting-only shows whether "medium or higher at 0.55" would catch
   misses; a later change if it does.
6. **A two-stage quick look** (names only, then the full set): tokens do not bind on a normal day (F-P11).
7. **Positive posts read for the miss count**: the owner settled positives out; a later alert on one counts "never read".
8. **Novelty ("ongoing") as a fail**: only ranked; the alert memory's bars were set on story texts (MR §4).
9. **Grouping in BigQuery / Cloud Run** (OPEN section 6 item 2): unchanged.

**What only a live deployment can prove:**
1. Tokens a call and a day, and the price (none recorded anywhere).
2. How many requests `fetchAll` runs at once in Apps Script; a batch's time; the code check's time at 2,000-5,000 posts.
3. The account's UrlFetch day and type, and the Decisions rate tier.
4. The quick look's accuracy on a single post, and pass rates per bar and topic (S19d's week).
5. Code passes a day by source; the mid-size gap's size (S19a's counts).
6. The review room: real review run time, and how many passes a day fit.
7. That `handleNewAlert_` with a stored review behaves in the live space as in the harness (the harness tests it).
8. The KOF sheet's layout, how much the cache cuts, and handle collisions across networks.
9. Bytes of the owned facts, the grown read and the widened lane SQL (`measureEngineLive()` dry-runs them).
10. The pool's real age with posts of every size; similarity on big posts (S1's `big` band).
11. Whether Sonar's repost rows carry the original's counts.
12. That Burson's pick-up time does not rise, and nothing reaches S-F Burson (B25) or the Testing space (B26).

---

## B7. For the owner (one paragraph; replaces OPEN section 8's sentence "and acts on a single worrying post alone …")

Every post from every source is now first checked against Burson's alert requirements, before any grouping. The parts that
are numbers or lists are checked at once by the bot itself: a KOF author, 2,000 or more engagements, and Google's own posts
that reach 30 comments with 30% negative. The parts that need judgment, a P0 issue or a Sensitive Topic, are checked by
Gemini's quick look: one post per call, many calls at the same time, in the time each run has left after Burson's alerts.
A post that meets a requirement goes straight to the full review, about 40 seconds, and if the review agrees you get one
card and one Social Alert, usually within a few minutes of the bot reading it; if the review disagrees, no card is posted
and the post stays in its story. Every other post is grouped into stories whatever its size, so a story still forms on
time even when Gemini is slow or down. At busy times Gemini's quick look reaches the most likely posts first; the rest go
into stories as before, and the Engine tab shows how many. The bot counts every day how often the quick check passes a
post the review then rejects, and how many posts it let through to stories that later got an alert anyway, by source. What
stays limited, and why: the quick look adds a large number of Gemini calls whose price is not in the bot's records, so the
first week only counts before any card depends on it; the bot's daily run time, Google's daily limit on outside calls and
Gemini's rate limit decide how many posts the quick look reaches on a very busy day; and the quick look reads words, not
pictures or videos.
