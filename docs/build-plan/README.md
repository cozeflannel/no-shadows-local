# Build plan: what is built, what is left, and how to finish it

This folder is the hand-over for the rest of the build. The designs are finished and were each attacked by independent
reviewers before they were accepted; nothing here needs designing again. What is left is building, step by step.

| File | What it is |
|---|---|
| `README.md` | this page: where things stand |
| `PROGRESS.md` | the checklist of steps, in build order; the first unticked step is the next one |
| `STEP_NOTES.md` | one brief for each remaining step, and the checks to run against your own work |
| `PROMPT.md` | one prompt that tells an AI coding tool to finish the build from this folder |
| `1_new_sources_plan.md` | the plan for the new sources (the AMIE table, Brandwatch live) |
| `2_open_engine_plan.md` | the plan for the open engine (its section A wins over the rest of the file) |
| `3_requirements_first_plan.md` | "requirements first, then clustering" (its section C wins over its section B, and the whole file wins over the open-engine plan where they differ) |
| `4_first_screen_plan.md` | the first screen in front of the one-post quick look (step S19h) |

## What is being built

The bot watches social posts about Google from several sources and alerts the team when a post, or a group of posts
telling one story, meets the alert requirements the agency partner (Burson) works to. Three things were asked for:

1. **Early Detection that can be seen** (done): the owner saw only Direct BigQuery cards, nothing that said which
   requirement a post met or missed, and nothing that showed posts grouping into a story.
2. **More sources, stitched together** (partly done): the AMIE table (Brandwatch's alert feeds, with X posts and
   their words) and Brandwatch read live (never X), next to the tables read today, so that one post or one person
   seen through two sources counts once.
3. **An open engine** (designed, not built): every source with the same standing, checks every 5 minutes, judgment
   and ranking in place of fixed review limits, and every post first checked against the alert requirements, with only
   what fails grouped into stories. Only real walls stay: the platform's run time, outside services' limits, and
   Burson's own requirements.

## What is done (in this repository, at this commit)

- **The first build.** In the one-space setup Early Detection goes first; up to 150 stories a day are reviewed (5 a
  check, 10 an hour, the serious first; one turned away comes back); Control C19 shows the day's numbers; a bot-made
  "Early Detection" tab has one row for every story with what became of it and why; every review ends with an "Alert
  requirements" line; cards that belong together point at each other with notes; one post gets one card and one issue
  one new Social Alert email; C15, C34 and C35 count what was posted and what was not. Seven settings under
  `burson_qa` switch the parts off. It was built in lanes, each reviewed twice, then reviewed as a whole from seven
  sides and fixed. See `apps-script-chat-bot/README.md`.
- **New sources, stage 0 and stage 1.** A read-only live check to run by hand (`verifyNewSourcesLive` in
  `LiveVerify.gs`); the rules for new lanes inside Early Detection's source (`EarlyWaveSource.gs`); Control row 48
  "Early Detection: also read the AMIE table", written OFF; the AMIE job with its checks of the table; the bot-made
  "New sources" tab. The Control tab's help block now starts at row 53, so rows 49, 50 and 51 are free for the three
  switches still to come. With row 48 OFF the bot is exactly the first build.

Tests at this commit: the whole Node suite passes (1,191 of 1,191), the Python tests pass, `Generated.gs` matches the
config, and `node scripts/repo_safety_scan.js` prints `clean`.

## What is left (in build order; `PROGRESS.md` is the live list)

| Group | Steps | What it gives |
|---|---|---|
| Brandwatch live (row 49) | 2a, 2b, 2c | Brandwatch's posts (never X) minutes after Brandwatch has them, from the queries ticked on the New sources tab |
| The AMIE table in the Watch (row 50) | 3a, 3b | the Watch sees X posts with their words about a day sooner |
| Open engine: guards and views | S2, S3, S4 | row 51; the day's run time and outside calls recorded; one safety stop; Burson's alerts always first; the Engine tab |
| Open engine: sooner, no review limits | S5, S6, S11, S12 | ranking in place of counts; checks every 5 minutes; Gemini's quick look for every candidate from 2 accounts; reviews several at once |
| Open engine: every source the same | S7, S8, S9, S10 | nothing lost when a check reads more than it can group; velocity made correct; freshness decides, not the source |
| Requirements first | S19a, S19b, S19d, S19h, S19c, S19f, S19g | every post checked against the requirements first; a post that meets one alone is reviewed and alerted alone; the rest grouped whatever its size |
| The rest | S13, S14, S16, S17, S18, S1 | the Watch's single post; Direct BigQuery by time; growth notes; a readable busy day; "Why not?"; two live checks to run by hand |
| Closing | — | a look at the whole change, the README and help texts, the final runs |

## The rules every step keeps

1. **A new switch OFF is the bot as it was, byte for byte.** Rows 48 to 51 are written OFF and never set ON by code.
   The golden tests (`node apps-script-chat-bot/test/run_tests.js "golden flows:"`) pass with no new record.
2. **Each step sits behind its switch and, where the plan names one, its own setting**, so a part can be turned off
   without a code change.
3. **No existing Control row moves or changes its text.** New rows: 49 (`edBwLive`), 50 (`watchAmie`), 51
   (`openEngine`). The help block stays at row 53.
4. **Burson's own alerts are never slowed, counted, queued behind anything new, or stopped.**
5. **Nothing new reaches the S-F Burson space (B25) or the Burson test copy (B26).** New texts posted in Chat are
   known as the bot's own and pass the leak guard.
6. **A tab the bot did not make is never read, cleared or written.** A cell holds at most 45,000 characters, a script
   property 8,800, a cache value 95,000, each shown in its worst case by a test.
7. **No email address anywhere**, in a file, a log line, a cell or a commit message; made-up addresses only on
   `.test`, and only where a test needs one. `node scripts/repo_safety_scan.js` prints `clean` before every commit.
8. **No test is deleted, skipped or weakened.** An expected text that changes is changed on purpose and named in the
   commit message. `Generated.gs` is rebuilt from the config, never edited by hand.
9. **Nothing here can reach the live sheet, BigQuery, Gemini or Brandwatch.** Everything is proven with the fakes in
   `apps-script-chat-bot/test/`; what only a live run can show is written down, never guessed.
10. `AGENTS.md` binds everything above and wins where it says more.

## What the owner does when a part is built

Deploy as usual (`clasp push -f` from `apps-script-chat-bot/`), then turn the part's row ON on the Control tab: 48
(the AMIE table), 49 (Brandwatch live, after ticking queries on the New sources tab), 50 (the AMIE table in the
Watch), 51 (the open engine). Before row 49, run `verifyNewSourcesLive()` once in the Apps Script editor: it only
reads, and prints a plain report.

## What nobody has been able to check from a desk

No price for the extra Gemini, BigQuery and embedding use is recorded anywhere; the first week's bill is the answer.
The account's daily run time and daily limit on outside calls, Gemini's rate limits, how many requests go out at once,
and how accurate the quick look is on a single post can only be measured live. Each plan ends with its own list.
