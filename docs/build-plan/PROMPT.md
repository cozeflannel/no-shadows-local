# The prompt

Paste everything in the block below into the AI coding tool, opened in this repository's folder. If the tool stops
before the list is finished, paste the same prompt again: it picks up at the first unticked step.

```text
You are finishing a build in this repository. The design is done and is in docs/build-plan/. Your job is to build
the remaining steps, in order, on your own, until the checklist is finished. Do not stop to ask me questions: where
something is unclear, the plan files decide; where they are silent, choose the smallest change that keeps every rule
below, and write down what you chose.

WHAT THIS IS
A Google Apps Script chat bot (apps-script-chat-bot/*.gs, one global scope) with a Node test harness
(apps-script-chat-bot/test/), a Python twin (triage_agent/, tests in tests/), and a config (config/*.yaml) that
scripts/build_apps_script.py turns into apps-script-chat-bot/Generated.gs. It reads social posts about Google and
alerts a team. It is live. Its owner is not a programmer.

READ FIRST, IN THIS ORDER
1. AGENTS.md: the project's rules. They bind you.
2. docs/build-plan/README.md: what is built, what is left, and the rules every step keeps.
3. docs/build-plan/PROGRESS.md: the checklist. The first unticked step is where you start.
4. docs/build-plan/STEP_NOTES.md: one brief for each step, and the checks to run against your own work.
Do not read the four plan files from end to end. For the step you are on, read its brief, then the sections of the
plan that the brief names. Line numbers in the plans are old: find each place by its function or constant name.

HOW TO WORK: repeat for each unticked step in PROGRESS.md, in order
1. Read the step's brief in STEP_NOTES.md and the plan sections it names. Read the code those sections touch.
2. Write the step's tests first (the plan names them), in the new test files it names. See them fail.
3. Build the step in small commits. Keep to the files and functions the step names. Do not reformat, reorder or
   re-indent code you do not change.
4. After each commit, run the tests that match what you touched. Before the step's last commit, run everything:
     node apps-script-chat-bot/test/run_tests.js            (the whole suite; four to five minutes)
     python -m pytest -q                                     (use the project's virtual environment if there is one)
     python -m scripts.build_apps_script --check             (after a config change, run it without --check first)
     node scripts/repo_safety_scan.js                        (must print: clean)
   If AGENTS.md lists a project tool for one of these (running tests, the safety audit, the leak guard, rebuilding
   Generated.gs), you may use it instead.
5. Check your own work as a skeptic, with the list at the end of STEP_NOTES.md: assume the step is wrong until a test
   or a probe you ran shows otherwise. Break each new rule on purpose and see a test fail; put the code back. Fix
   what you find.
6. Tick the step in PROGRESS.md and add one line under it: what was built, the suite's count (N of N passed), and
   anything left out with the reason. Add what only a live run can prove to the list at the end of that file. Commit.
7. Go straight on to the next step.

If a step cannot be built as its plan says: build what can be built, write exactly what is missing and why under the
step in PROGRESS.md (and under "Left out, and why"), leave its box unticked, and go on to the next step that does not
depend on it. Never invent a different design to get past it. Never leave the suite failing: if you cannot make a
step pass, take its unfinished commits out of the way (a branch or a revert) so that what stays passes.

RULES THAT ARE NEVER BROKEN
1. A new switch OFF is the bot as it was, byte for byte. Control rows 48, 49, 50 and 51 are written OFF and never set
   ON by code. With them OFF every Chat post, outbox row, email, stored value and outside request is what it was before
   your change. The golden tests (node apps-script-chat-bot/test/run_tests.js "golden flows:") must pass, and you must
   not record their files again. For each step, prove it with a test that compares a run with the switch OFF before
   and after your change.
2. Each step sits behind its switch and, where the plan names one, behind its own setting (added to
   config/default_config.yaml and triage_agent/config.py, then Generated.gs rebuilt). A setting switched off gives
   back the bot as it was before that step.
3. No existing Control row moves or changes its text. The only new rows are 49, 50 and 51. The help block stays at
   row 53.
4. Burson's own alerts are never slowed, counted, queued behind anything new, or stopped. Whenever a step adds work to
   a run, a test shows a Burson alert in the same run handled exactly as before.
5. Nothing new reaches the S-F Burson space (B25) or the Burson test copy (B26). Every new text the bot posts is added
   to the lists that tell the bot its own messages and that hold them back from Burson, and passes the leak guard.
6. A sheet tab the bot did not make is never read, cleared or written. A cell holds at most 45,000 characters, a
   script property 8,800, a cache value 95,000: show each new one in its worst case with a test.
7. No email address anywhere: not in a file, a log line, a cell, a stored value or a commit message. Made-up addresses
   only on .test, and only where a test needs one. No key, token or personal folder path in any file.
8. No test is deleted, skipped or weakened to get a pass. An expected text that changes is changed on purpose and
   named in the commit message. Generated.gs is rebuilt from the config, never edited by hand.
9. You cannot reach the live sheet, BigQuery, Gemini or Brandwatch, and you must not try. Prove everything with the
   fakes in apps-script-chat-bot/test/. What only a live run can show is written down, never guessed. Never put
   anything a live system returned into the repository.
10. Do not deploy. Do not run clasp. Do not push, and do not add a git remote. Commit on the branch that is checked
    out when you start, and stay on it.
11. Every text a person reads (a Control note, a tab cell, a note under a card, a log line) is in plain words, with the
    warning first, and fits its place: a Control note is cut at 200 characters, so print each new one with its length.
    Use the exact texts the plans give.
12. Commit messages: a plain sentence as the subject, then what changed and why in plain words. No "Co-Authored-By"
    line, no email address, no tool or model name.

WHEN THE CHECKLIST IS FINISHED, OR YOU MUST STOP
1. Do the three closing items in PROGRESS.md: the skeptic's look over everything built; apps-script-chat-bot/README.md
   and the Control tab's help brought in line with what was built (each sentence checked against the code); the final
   runs.
2. Leave the work committed, the working tree clean, and the whole suite passing.
3. End with a short report in plain words for the owner: what was built, what was left out and why, what only a live
   run can prove, and what they do next (deploy, then turn rows 49, 50 and 51 ON on the Control tab; run
   verifyNewSourcesLive() once before row 49).

Start now with the first unticked step in docs/build-plan/PROGRESS.md.
```
