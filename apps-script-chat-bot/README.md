# Burson QA bot (V1, Apps Script)

The bot does the alert QA that Google analysts do today in **[S-F] Burson Automated Alerts V3**, so analysts can
focus on escalation (Social Alerts, Trust & Safety). It's an Apps Script project that checks the Burson space every
minute, as the account that ran `setup()`. It doesn't use a Chat app or webhooks.

| Situation | In the Burson space | In the analyst space |
|---|---|---|
| Alert is correct | Its action emojis (below); 👍 only while it still waits on a person (legend: "Confirming receipt, no action yet taken") | The alert, exactly as Burson sent it |
| Alert has mistakes | ⬇️, plus a reply in the alert's thread that lists each fix and asks Burson to update and resend | The alert with the fixes applied, in Burson's format, plus a `🤖 QA corrected:` line |
| Something only Burson can supply (for example the link) | Asked for in the thread (with the Auto-find missing links switch ON, a missing link or author is looked up first, and Burson is asked only if it isn't found) | Forwarded, with `🤖 QA: Link missing (requested from Burson)` |
| Gemini thinks something is off but is less than 90% sure | Nothing | Forwarded, with a `🤖 QA check:` line for analysts to double-check |
| Burson resends the fixed alert | ⬇️ on the original ("Addressed on updated post below"); 👍 on the resend only if the alert wasn't actioned yet | Nothing new: analysts already have the corrected alert. A thread note is added only if the resend changed something, such as adding the missing link |
| Resend still has a mistake | A reply in the resend's thread with only what's still wrong | Nothing |
| Burson asks a question or pushes back in an alert's thread | An answer in that thread, with a link to the document the rule comes from (Resources tab) | Nothing |
| "ok, will fix" | Nothing (👍 in the legend is for alerts) | Nothing |
| Alert needs a Social Alert email, while testing (`escalation.stand_in` set, as now) | 📦 and each team's emoji (📰 💬 ⚖️ …) for every distro it would have gone to | Nothing. The bot sends the email itself, as it would live, but only to the stand-in, with a last line naming the distros it would have gone to |
| Alert needs a Social Alert email, with real distros (no stand-in) | 👍 while the draft waits; once it's sent from Gmail, 📦 and each team's emoji, matching who the email actually went to | A draft in Gmail with every team the rules or Gemini picked already on it, and a note with why and who's on it |
| New P0 / Sensitive Topic product failure (escalation protocol) | 🧑‍💻 once the DM went out | Nothing. While testing the DM goes to the stand-in, naming the leads it would have gone to |
| T&S should see it (a person submits the form, unless the Auto-submit T&S form switch is ON) | ✍️ once the "WD Intake Request" confirmation email arrives | A pre-filled T&S form link (see "T&S pre-filled link" below) and the values to enter |
| Alert is correct but doesn't need a Social Alert, or the draft is deleted unsent | ❌ ("No action taken") | ❌ (the reason goes to the run log) |
| A follow-up on a post that already went out as a Social Alert: the author's own reply or thread, anyone's reply under it or quote of it (the bot reads the thread from X's and Bluesky's public data), or the same post alerted again (also when it's in the SLRR alert log from an earlier day) | ❌, with no second email, when Gemini is sure it adds nothing new | ❌ (the run log names the earlier alert). If it adds something (a new incident, new evidence, P0 or a new Sensitive Topic, 2K+ engagements of its own), the update goes out on the earlier email's thread |
| Alert escalated only because the author is a KOF, which Gemini is 90%+ sure needs no Social Alert | ❌, when one of Gemini's no-alert checks holds and the bot can back it up (an earlier alert went out for it or its thread, the leads' current guidance covers it, or the post itself shows a mistake or nothing actionable) | ❌ (the run log gives the check and Gemini's evidence). P0, Sensitive Topic and briefed-topic alerts always go out |
| An analyst disagrees and adds a legend emoji (✍️, 📦, ❌, …) on the forwarded copy | The same emoji appears on Burson's post (👎 never does) | — |
| Zapier sends something the bot can't read | 👍 | Forwarded as received, with a note |

That is the bot with every Control tab switch OFF, as they start. With **Never wait on Burson** ON (row 23), a wrong
alert is processed right away instead, and Burson is told what the bot changed (see "Row 23: Never wait on Burson").

**In S-F Burson itself** (the real Burson space: the one in **S-F Burson space**, B25, on the Control tab), the "In the
Burson space" column is only what the bot *would* do. With **Post in S-F Burson** OFF (row 24, as it starts), none of
it is posted, replied or reacted there; the run log counts what was held back. With it ON, each one waits on the
**Burson outbox** tab until a person sets it to Send (see "Row 24: Post in S-F Burson"). In a test feed or the Mirror
space the bot posts and reacts as the table says. In a Burson space people outside Google can join that isn't the B25
space (or while B25 is blank), nothing is posted, reacted or queued at all: see "S-F Burson space (B25)".

Nothing the bot posts in the Burson space mentions the analyst space, forwarding, escalation, emails, forms, internal
tools or people. Every message bound for Burson, including each Gemini answer, goes through a guard in `Voice.gs`. If
a message trips the guard, the bot sends a fixed, generic one instead. What the Burson outbox sends to S-F Burson goes
through a wider check as well, right before it's sent. The tests check every message the bot posts in a Burson space.

## Managing the bot: the Control tab

Everything day to day happens on the **Control tab** of the bot's Google Sheet, "Burson QA bot". `setup()` creates the
sheet, and its link is in the bot's first message in the analyst space. You don't need the Apps Script editor.

| Cell | What it is | Who changes it |
|---|---|---|
| **Bot** (B2) | `ON` or `OFF`. OFF pauses the bot. When it's back ON, it skips anything posted while it was off | You |
| **Burson space** (B3) | The space where Zapier posts the alerts | You |
| **Analyst space** (B4) | The space the corrected alerts go to | You |
| Column C | ✓ and the name of the space the bot found, or ✗ next to the space to fix | The bot |
| **Status** (B5) | ✅ Working (or `🔴 LIVE · ✅ Working` when LIVE), ⏸ Paused, or ⚠️ followed by what to fix | The bot, every minute |
| **Last check** (B6) | When the bot last ran | The bot, every minute |
| **Today** (B7) | Alerts reviewed, alerts sent back to Burson, questions answered | The bot |
| **Runs as** (B8) | The account the bot posts as. It must be a member of both spaces | `setup()` |
| **Mirror space**, **Auto-correct space** (B9, B10) | Optional test spaces (below) | You |
| **The switches** (B11:B24, B27:B29, B32, B34, B36, B37) | `ON` or `OFF`, all OFF to start: what the bot may do on its own (below) | You |
| C11:C24, C27:C29, C32, C34, C36, C37 | What each switch does when OFF, or what it is doing when ON | The bot, every minute |
| **S-F Burson space** (B25) | Which space is the real Burson space, S-F Burson: its link, id or exact name. Only this cell decides it; the code never names it. Blank to start (see "S-F Burson space (B25)" below) | You |
| C25 | ✓ and the name of the space the bot found, ✗ and what to fix, or ⚠️ Not set and what waits for it | The bot |
| **Burson test copy** (B26) | Optional. A Google-only space to practise the Relay in without touching S-F Burson: the bot copies S-F Burson there, and while it's set the Relay sends the analysts' side (and, with row 24 ON, the bot's own Burson replies and emojis) there instead of S-F Burson. Blank to start (see "Practising the Relay with a Burson test copy" below) | You |
| C26 | ✓ and the name of the space the bot found, ✗ and what to fix, or what blank means | The bot |
| **Testing: send to** (B30) | Up to 5 email addresses (any domain) every email goes to while Testing. Blank: nothing is sent while Testing until an address is entered in B30. C30 shows what the bot made of it | You |
| **Brand safety groups** tab | Read-only worksheet (`Google Group Name`, `Google Group Email`) supplying live Social Alert Google Group addresses at runtime (cached 10 minutes; zero hardcoded emails in code) | You |
| **BigQuery lookback** (B31) | How far back Direct BigQuery alerts (row 15) and the Early wave check (row 19) look: 15, 30, 45 or 60 minutes (blank: 60). C31 shows what the bot is using | You |
| **Other alerts space** (B33) | Optional. A Google-only space with other alerts (a campaign space, say) the bot works every minute beside the Mirror space, always in Testing (see "Other alerts space (B33)" below). C33 shows how it's doing | You |
| **How it works** (from A39) | A plain-language guide to all of the above | `setup()` and the bot |
| **Watches**, **Watch detections** and **Watch sources** tabs | Only with Proactive watch ON (row 34): what to look for (one watch a row, each ON / OFF), what the watches would have flagged (with its source and a scorecard against Burson's alerts), and which sources are live or stale (see "Proactive watch (row 34)" below) | You edit the watches and rate the rows; the bot writes the rest |
| **Follow-up** tab | Only with Track post-alert outcomes ON (row 21): what came of the bot's Social Alerts, which teams replied, each alert's status and next step, and editable P0/P1/P2 reply deadlines in B5:B7 | The bot updates it; you can edit B5:B7 |
| **Burson outbox** tab | Only with Post in S-F Burson ON (row 24) while LIVE: what the bot or the Relay would post in S-F Burson, each row waiting for you to set it to Send or Skip | The bot adds rows; you set Status |

**To change a space**, open the space in Google Chat, copy the address bar, and paste it into B3, B4, B25 or B26. The
space's exact name also works. Within a minute, column C shows the space the bot found.

**If something's wrong**, Status says what to fix in plain words. The bot never posts into a space that fails its
checks. It won't use an analyst space that is the same as the Burson space, that is S-F Burson (B25), or that allows
people outside Google.

**The Resources tab is the bot's knowledge base.** Gemini reads every document listed there and uses it the way a
person uses the team's handbook. It shapes the field fixes, the Social Alert call, who gets the alert, and Trust &
Safety, and it answers questions from it. Each row has a **Name**, a **Link**, **What it covers**, **Burson can see
it?** (Yes / No) and a **Bot status** the bot writes:

- **What it reads:** Google Docs and Slides (their text), Google Sheets, text, CSV, Markdown, HTML and JSON files in
  Drive, and public web pages. A Sheets link to **one tab** (it has `#gid=` in it: open the tab and copy the address
  bar) reads only that tab. The KOFs come from one row linked to the KOF spreadsheet's **[SLRR Global INFs]** tab (the
  ~3,000 KOFs being tracked). A link to the whole spreadsheet (Share > Copy link, no `#gid=`) reads every tab. Bot status
  names the tab it read, for example `Google Sheet, tab "[SLRR Global INFs]"`. Up to 1,000,000 characters of each document are kept.
- **What it can't read**, and Bot status says what to do instead: go/ links (paste the full link), PDFs and Word,
  Excel or PowerPoint files (save them as Google Docs, Sheets or Slides first), folders, pages behind a sign-in, and
  Chat links. A document the bot's account can't open says so: share it with that account (Viewer is enough).
- **Staying current:** a new or changed row is read on the next run (within a minute). Every 15 minutes the bot asks
  Drive whether a document changed and reads it again if it did. Web pages are read again every 6 hours, and a
  document it couldn't read is tried again every 30 minutes. The text is kept in the bot's own hidden **Knowledge
  cache (bot)** tab, so an alert never waits on Drive. `refreshKnowledge()` reads them all now.
- **Tabs:** keep the Resources tab named **Resources**; nothing needs renaming. If it is renamed anyway, the bot still
  finds it by its header row (Name · Link · What it covers) and never makes a second one. The bot makes its storage tab
  itself and never reads, clears or writes a tab it didn't make: if a tab people made already has that name, Bot
  status says so and nothing is touched.
- **Who sees what:** every review and analyst answer gets the documents: all of them when they fit, otherwise the
  parts that bear on the alert or question (for example the author's row of a KOF list). **Only rows marked Yes in
  "Burson can see it?" are ever used in answers to Burson or linked for them.** Everything else is internal. The two
  starting documents are Yes; on a tab from before, they're set to Yes once and every other row is left blank
  (internal) until you choose.
- **Order of authority:** the Guidance tab (while a row applies) overrides the documents, and the documents override
  the bot's built-in playbook. Exact product, tag and topic names still come from `config/default_config.yaml`.
- **Evidence:** Gemini names the documents it relied on. They're in the run log (`knowledge used: …`) and in the Alert
  log's `knowledge_used` column. On a KOF alert, a document that says "no Social Alert" can back a ❌ only when
  `kof_no_alert_judgment` is on (it's off): the leads' guidance (Guidance tab or emails) can back one either way.

Reading Docs, Slides and Drive files uses the Drive read-only permission. The first time, open the Apps Script
project, run `refreshKnowledge` and click **Allow**. Until then the bot can't run.

**If the bot keeps failing** (5 runs in a row), it tells analysts in the analyst space, never in the Burson space. It
reminds them every hour while the problem lasts, and says so when it's running again. If **Last check** is more than
10 minutes old, the bot has stopped. Ask the person in **Runs as** to open the Apps Script project and run `setup()`.

**Script properties** (Project Settings in the Apps Script editor) are the bot's own memory: how far it has read,
today's counts, the sheet's id. They aren't settings, and nobody needs to change them. The bot has no on-call names or
other day-to-day values to keep up to date. `setup()` deletes what the old prototype left there (`ONCALL_…`,
`PROCESSED_…`, `CASE_…` and others).

Share the sheet (as Editor) with the people who manage the bot. **Don't share it with Burson.**

### S-F Burson space (B25): which space is the real Burson space

**Right after deploying this version: paste S-F Burson's link in B25.** Row 25 is new and starts blank: the bot adds it
to the Control tab on its next run, with rows 1-24 as they were (no need to run `setup()`). Until someone pastes the
link, the Mirror (B9), Auto-correct (B10) and Relay (row 22) are paused (with B9 set, the bot reviews nothing until
then), and the Burson outbox sends nothing. Pasting it just before deploying works too: on today's tab B25 is an empty
cell beside the help text, and a link pasted there is kept and used from the first run.

Only this cell decides which space is S-F Burson (today **[S-F] Burson Automated Alerts V3**): no space id for it is in
the code, so if something goes off course you can point the bot at another space, or clear the cell, from the sheet.
Paste the space's link, `spaces/…`, the bare id or the space's exact name, as for B3 and B4. C25 shows ✓ and the name
of the space the bot found, or ✗ and what to fix (for example, that the bot's account must be a member of that space).
The bot reads it once a run, and everything about S-F Burson uses it:

- the Mirror (B9), the Auto-correct space (B10) and the Burson test copy (B26) read S-F Burson's alerts there;
- the Relay (row 22) relays with it, and the Burson outbox (row 24) posts only there;
- the bot is **LIVE** only when **Safety valve (row 29)** is `OFF`, **Burson test copy (B26)** is blank, and S-F Burson (B25) is set and found (with alerts coming from it via B3 or Mirror B9);
- the analyst, Mirror, Auto-correct and Burson test copy spaces can never be this space.

**Blank or not found, all of that stops (fail closed).** The Mirror, Auto-correct, Burson test copy and Relay don't run: C9, C10, C26 and C22
say they need B25 (with B9 set the bot works in the Mirror space, so it reviews nothing until B25 is set). The Burson
outbox sends nothing and queues nothing new: rows set to Send wait, and C24 says why. The bot is never live, so every
switch behaves as it does in a test space. Status (B5) shows `⚠️ S-F Burson space (B25) …` with what waits for it, but
only when something needs it (B9, B10 or B26 set, Relay ON, or a Burson space people outside Google can join); otherwise the
bot keeps working in a Google-only test feed as before.

**Whatever B25 says, the bot never posts or reacts itself in a space people outside Google can join.** When the Burson
space (B3) is one and isn't the B25 space (or B25 is blank or can't be found), every post, reply and reaction there is
held back like row 24 OFF: nothing is written or queued, the run log counts it, and C3 and Status say why. The bot
still reads the alerts there, and analysts get them as usual. When B3 is the B25 space, row 24 decides as always (OFF:
withheld; ON: the Burson outbox). As a backstop, `Chat.gs` refuses any write to the B25 space except an outbox row
being sent, and any write to a Burson space people outside Google can join that isn't S-F Burson.

**Changing B25** takes effect on the next run. The Mirror and Auto-correct start from the new space's last 15 minutes, the Burson test copy from then (nothing older),
the Relay starts again (as when it's turned on), and Burson outbox rows queued for the old space are never sent:
they're Blocked, "queued for a different S-F Burson space". Clearing B25 is the quick way to stop everything bound for
S-F Burson: the outbox, Mirror, Auto-correct, Burson test copy and Relay pause, and (as people outside Google can join S-F Burson)
nothing is posted or reacted there.

**To try the bot on another space** (for example a campaign space with its own alert format) while the Mirror space
keeps working S-F Burson's alerts, paste that space in **Other alerts space (B33)** and leave B25 as it is (see "Other
alerts space (B33)" below). To work only that space instead, paste it in B25 and set **Work directly in B25 (row 32)**
ON. When only Google people can join it, the bot works right in it, as in the Mirror space, and stays in Testing (see
"Row 32: Work directly in B25" below). With people outside Google able to join B25, row 32 does nothing and everything
above holds.

### Practising the Relay with a Burson test copy (B26)

To practise the Relay (row 22) end to end without posting in S-F Burson itself, paste a second Google-only space's link in **Burson test copy (B26)**:

1. **Every run**, the bot copies into the test copy (B26) **everything in S-F Burson (B25), in S-F Burson's own order** (an item that can't be copied yet holds back the ones after it, so nothing lands out of order). It starts from the moment a run sees B26 set (or changed): nothing from before then is copied, so the space isn't flooded with a backlog.
   - Zapier's top-level alerts, unchanged;
   - everyone's thread replies (under the matching alert's copy when in its thread), top-level messages and emojis, as `Name (Burson): text` or `Name (Google): text` when the `Relay names` tab says, or `Name: text` while it doesn't. Nothing waits on that tab. The bot's own work never comes over from S-F Burson.
   - Chat stamps each copy with the time it was posted (it can't backdate a message), so the times shown are up to about a minute after S-F Burson's; the order is the same. Each emoji is added by the bot's account, so one several people added shows once. Edits, deletions and removed emojis aren't copied.
2. **With Relay with S-F Burson ON (row 22)** while B26 is set:
   - S-F Burson still comes into the **Mirror space (B9)** the same way (everything, in its own order);
   - the analysts' replies, messages and emojis in the Mirror space go **straight to the Burson test copy (B26)** — under the matching alert's copy, as a new thread, or as an emoji on the matching copy — with their name (`Dana Lee: text`). No **Burson outbox** row is needed and **Post in S-F Burson (row 24)** can stay `OFF`;
   - with **Post in S-F Burson ON (row 24)**, the bot's own Burson-facing replies (asking Burson to fix and resend, answering Burson's questions) and legend emojis in the Mirror space also go straight onto the matching message in the **Burson test copy (B26)** (internal analyst notes never do);
   - **nothing is ever written to or queued for real S-F Burson (B25)** while B26 is set (even if B26 has a configuration error or row 24 is `ON`).
3. **Clear B26** when you finish practising: the copy stops, and (once the **Safety valve**, row 29, is `OFF`) the bot goes **LIVE** and queues both the analysts' side (row 22) and the bot's own Burson replies/emojis (row 24) on the **Burson outbox** tab for S-F Burson.

### Test spaces: Mirror space (B9) and Auto-correct space (B10)

| Cell | What it is | Who changes it |
|---|---|---|
| **Mirror space** (B9) | Optional. A Google-only space where analysts work: live Zapier posts from S-F Burson (B25) are copied there, unchanged, and the bot works them there | You |
| **Auto-correct space** (B10) | Optional. A Google-only test space: live alerts from S-F Burson (B25) are posted there already corrected by the bot (below). Always stays in Testing, even when the main Mirror run is LIVE. C10 shows how it's doing | You |

**Both need the S-F Burson space (B25)**, where they read the live alerts. While it's blank or can't be found, neither
runs: C9 or C10 says it's paused because it needs the S-F Burson space (B25), and Status says what to fix. When B25
changes, each starts from the new space's last 15 minutes.

**The auto-correct space** is a second test beside the Mirror space, which keeps working exactly as before on Burson's
unchanged alerts. Paste a Google-only test space's link in B10 (or run `startAutoCorrect("space link")`). Every minute,
right after the Mirror space's run:

1. The bot reads new Zapier alerts in the live Burson space (S-F Burson, B25). It **only reads** there: it never
   posts, reacts or answers, and it ignores people's messages and thread replies. Its chat client refuses any write to
   that space.
2. It reviews each alert as it does everywhere, then posts the **corrected alert** in the test space, in Burson's own
   format, instead of asking Burson for the fixes.
3. A short note in the alert's thread says what it changed, for example `Product: Gems to Gemini App`. A rewritten
   text shows only its new wording. Anything only Burson can add (for example a missing link) is listed as "Still
   needs Burson". There's no note when nothing changed.
4. It works the alert there as an IM would: the legend emojis, the Social Alert email (always in Testing, so only to the stand-in; its subject starts with `[Auto-correct test]`, so you can tell it from the Mirror space's), the pre-filled
   T&S test-form link in the alert's thread, the 🧑‍💻 escalation-protocol ping (to the stand-in), and answers to questions asked there.
5. When the IMs in the live space ask Burson for fixes and Burson resends, the resend counts as the same alert: nothing
   new is posted unless the priority or engagement went up.

C10 shows its status and today's counts (alerts, corrected, Social Alerts sent, questions answered). Its records are
kept apart from the Mirror's (its rows in the Alert log end in "(auto-correct)"), so the Results tab can compare the
two. Clear B10 (or run `stopAutoCorrect()`) to stop it. It refuses S-F Burson (B25), a space people outside Google can
join, and a space the bot already posts in.

### Other alerts space (B33): another space, beside the Mirror

To have the bot work a second space at the same time as the Burson side, for example a campaign space where a
monitoring tool posts `🚨 X Alert: 2026 Midterm Elections / Civics - Negative 🚨` alerts, paste that space's link in
**Other alerts space (B33)**. B25 stays S-F Burson, so Zapier's alerts keep coming into the Mirror space (and the Relay,
the Burson test copy and the Burson outbox) exactly as before. Every minute, right after the main run (`OtherSpace.gs`):

- **It works that space directly**, as row 32 works B25: an alert in another format gets its own triage (see "Alerts
  in other formats" under row 32), with its note in the alert's thread and 👍, ❌ or a Social Alert; an alert in
  Burson's format gets the usual review; a question in an alert's thread gets the analysts' answer there.
- **Always 🧪 Testing, even while the bot is LIVE:** every email goes only to the testers in B30 (blank: the stand-in),
  with its subject starting `[Other alerts space]`; the T&S form is the test copy, and the 🧑‍💻 escalation-protocol message
  goes only to the testers.
- **Nothing from it reaches S-F Burson:** not the space itself, the Burson test copy or the Burson outbox, whatever rows
  22 and 24 say. Its name and id are on the leak guards of what goes to S-F Burson.
- **Kept apart:** its rows in the Alert log end in "(other alerts)". The Results, Follow-up and Analysis tabs leave them
  out (they compare the bot with the IMs on Burson's alerts), Write back to SLRR BigQuery (row 16) never writes them, and
  Direct BigQuery alerts (row 15) and the Early wave check (row 19) never post there.
- **Its own time:** up to 150 seconds of each run, after the main run. On a busy minute its alerts wait for the next
  run; none is skipped.

C33 shows `✓ <space> · 🧪 Testing ·` and today's counts (alerts, how many were in other formats, Social Alerts to the
testers, questions answered), or ✗ and what to fix. It starts from the space's last 15 minutes (after a pause, from a
minute ago, as the main run does), and its problems never change the main Status (B5). It refuses the space in B25, a
space people outside Google can join, and a space in B9, B10 or B26 or that the main run already works in (B3, B4); the
space in the other cell keeps working. Clear B33 to stop it.

### Proactive watch (row 34): spotting issues before Burson does

Burson's alerts reach S-F Burson a median of about 5 hours after the post went live. Pendulum's live feed in BigQuery
(`sonar_raw`) saw 54% of the posts Burson alerted on from Oct 19 to 30, 88% of those before Burson did, a median 2.5
hours sooner. The Proactive watch tries to turn that head start into early warnings, and casts a wider net with every
other feed the bot can read. With row 34 `ON` (`ProactiveWatch.gs`, OFF to start like every switch), every 5 minutes,
after the other spaces:

- **What's new in every source, read-only.** Each source is queried where it already is; no table, view or pipeline is
  made (a script's temporary table is gone when the script ends). BigQuery reads one location a job, so a look is two
  jobs:

  | Source | Location | What it adds | How fresh |
  |---|---|---|---|
  | Sonar (`bsip-s-bsip-gg-26-2cf3.google_bg.sonar_raw`) | us-central1 | The posts Pendulum first saw since the last look (none it saw in the 24 hours before), posted within 24 hours, with a risk smart tag, from accounts with 1,000+ followers or 100+ engagements (~4,200 a day); plus what wasn't noticeable at first: posts that were small when first seen and grew past that floor later (~90 a day), and posts already checked that broke out (10x the engagements, 1,000+; ~165 a day), both posted within 72 hours. Breakouts first, then the biggest accounts, 150 a look at most | Current to the minute |
  | Tubular (`google_tubular_mentions.tubular_videos`) | us-central1 | Videos that mention Google (YouTube, Instagram, Facebook, TikTok), each run's new ones, posted within 72 hours (1,000+ followers, 100+ engagements or 10K+ views), 60 a look, the most viewed first | A run every few hours; it finds a video a median ~39 hours after it went up |
  | Brandwatch mentions (`raw_data.brandwatch_raw_mentions_base`) | US | Brandwatch's mentions of Google's products (`Google Search`, `Google AI`, `Google Cloud`, `Gemini`, `Google Pixel`, `Google Glasses`, `Googlebook`) on Reddit, Bluesky, Facebook and Instagram that Brandwatch rates negative and tags with an SLRR exposure tag: English, no shares, 1,000+ reach or 100+ engagements, posted within 72 hours, each mention once, the biggest first, 60 a look (a bigger batch over the next looks) and 1,000 a day at most (X comes from Sonar; YouTube and TikTok from Tubular and Sonar) | Loaded in a nightly batch (1–6 days after posting); read when the table changes |
  | Sprinklr owned posts (`reporting_data.sprinklr_outbound_reporting`) | US | Google's own posts in English from the last 72 hours whose comments turned negative (25+ negative comments, or 30%+ negative once there are 20+), on X, Reddit, Bluesky, Facebook, Instagram, YouTube and TikTok, 40 a look, the most negative first | Loaded once a day (~10 AM ET); read when the table changes |
  | Sprinklr comments (`reporting_data.sprinklr_inbound_comments`) | US | Comments on Google's own posts: a post whose negative comments reach 5 within an hour, or a negative comment from a 100K+ account | A median ~22 minutes after the comment |
  | DSD story selection (`DSD.DSD-story-selection`) | US | Brandwatch's HIGH and KOF alert emails about Google, one row a post (the DSD desk's story pool, ~42 a day): posted within 72 hours, with text; no reach floor, since Brandwatch's alert already picked them. KOF first, 40 a look | Every ~30 minutes; a median ~2.4 hours after posting |
  | Other alerts space (the Alert log) | US (a query parameter) | The Brandwatch alerts (and other tools' alerts) posted in the Other alerts space (B33, e.g. Midterms 2026), as the bot read them | As they're posted |
  | Brandwatch: 2026 Election Alerts (Brandwatch's API: project 1998344909, query 2004167929) | US (a query parameter) | What Brandwatch added to the query since the last look (an hour back on a first look, 6 hours at most), posted within 72 hours, the newest added first (100 a page, 3 pages a look at most). Read with the shared token slrr-campaigns keeps in Secret Manager (`slrr-campaigns-bw-token`, read each look; never kept, logged or written). Brandwatch's API gives X posts without their text, author or link (X's licensing; about half of this query), so the bot reads those from X's public embed data (60 a look, the biggest accounts first); an X post X won't show is counted as not sent. 100 a look | Usually minutes after posting |

  Dropped Nov 1 as stale (no new rows): the daily Brandwatch export, DSD content vectors and Reddit Pulse. Dropped Nov 11
  (not on the approved table list): BMIE alert mentions and Sprinklr's older outbound media export. A Watch sources tab
  made before then loses their rows at its next update.

  Each source keeps its own place: Sonar and the comments go by the look's window; the others start after the newest
  item they last handed over (on a first look: an hour for the Other alerts space and the Brandwatch query, 2 hours for
  DSD story selection and Brandwatch mentions, 24 to 30 hours for Tubular and Sprinklr owned posts), so a feed that
  stops and starts again counts again at once.
  Each source runs in a block of its own: one that fails is noted and the others carry on.
- **Gemini, inside BigQuery.** For each watch ON on the **Watches** tab (up to 5), `AI.IF` answers the watch's yes/no
  question for each post (the same post from two sources once, the first to hand it over); for the posts that match,
  `AI.SCORE` scores how likely it is to become a brand-safety issue in the next 6 hours (1-10, by the watch's rubric) and
  `AI.CLASSIFY` picks its topic. They use the script's own cloud-platform token (end-user credentials): no connection or
  new permission. X posts are judged at first sight (on the post and the author's reach): waiting for 100+ engagements
  in Sonar leaves only ~5 minutes' lead on X, against hours on Instagram, TikTok and YouTube.
- **Sent now, collected later.** Each job goes out in one run and is collected in a later one, so it never holds a run
  up. A failed job is tried again from the same start at the next look, the other location carrying on; after 3 tries
  its window is skipped (C34 says so), so one bad window never stops it. A job still running after 4 minutes is
  cancelled and counts as a try. After a pause or a gap it looks only at the last 15 to 30 minutes.
- **Recorded, and posted only where you say.** Each post at or above a watch's bar (Flag at score, 7 to start), and each near miss
  (within 2 of it, to tune the bar), goes on the **Watch detections** tab once a watch: when its source had it (never
  before the look's window: a late feed can't claim a lead it couldn't have had), the watch, the score, the topic, the
  post, its **source** (and why it was asked about when that isn't the usual: `Sonar · grew`, `Sonar · broke out`,
  `Brandwatch mentions · negative`, `Sprinklr owned posts · negative comments`), network, author, followers and engagements, the source's issue or query (Pendulum's issue name,
  the Brandwatch query, the subreddit...) and whether it's a new issue, its summary, and a **Rating** column for you
  (Useful or Noise). With **Watch alerts** (row 35) OFF, as it starts, nothing is posted in any space or emailed; nothing
  is ever written to BigQuery.
- **The scorecard** (the top of the Watch detections tab, every 10 minutes and right after new rows): for each of the
  last 7 days, Burson's alerts (the posts in the Alert log that reached S-F Burson that day; never one the bot took from
  BigQuery or an Other alerts space's), how many a watch caught at its bar, how many before Burson's alert and the
  median lead in minutes, the flags and near misses, and your ratings; then the 7-day total. Each row gets "Burson
  alerted" and its lead over Burson once Burson alerts on the same post.
- **The Watch sources tab**: one row a source: what it adds, the table it reads, its status (live; stale when its table
  hasn't changed for longer than it usually goes; an error at its last look), when its table last changed (read free
  from the dataset's `__TABLES__`), the newest item it handed over, what was new and what Gemini checked at the last
  look and why (for example `new 27, grew 3, broke out 2`), and today's checked and flagged.

The **Watches** tab starts with two watches, both `OFF`: **Midterms 2026 × Google** (posts tying Search, AI Overviews,
Gemini, YouTube, Android, Waymo, Google ads or Google's executives to the 2026 midterms: election info, political ads,
bias, censorship or interference claims, election misinformation, election-day failures) and **Google brand safety
(all)**. Set a watch's On to `ON`, edit its question, rubric, topics, bar or networks (`X, Instagram`; blank: all), or
add your own rows; the bot writes only its Status column. The three tabs are made the first time row 34 is ON; a
Watches or Watch detections tab that the bot didn't make is never read or written (C34 says to rename it), and a Watch
sources tab it didn't make is left alone. C34 shows the last look (new posts, flagged), today's flags and near misses,
and the sources (live, stale, failing). A look reads about 0.4 GB (Sonar's ~0.33 GB most of it; Sprinklr's export adds
~0.2 GB the first time and when it changes); BigQuery refuses a job that would read more than 5 GB. Both jobs are
labeled `purpose: proactive-watch` (`lane: c1` or `us`).

### Watch alerts (row 35): the watch's flags as alerts

B35 says where the Proactive watch's flags go (a dropdown; `OFF` to start, and only a person changes it):

| B35 | What happens |
|---|---|
| `OFF` | The watch only lists its flags on the Watch detections tab (as above) |
| `Other alerts space (B33)` | Posted in the space in B33, a space of their own. To move them, paste another space in B33: the next ones go there. Always Testing there |
| `Mirror space (B9)` | Posted in the Mirror space, beside Burson's alerts. The Mirror and the Relay work exactly as before, and nothing the bot posts is ever passed on to S-F Burson |
| `Auto-correct space (B10)` | Posted in the Auto-correct space and worked there. Always Testing there |

**Not every flag is an alert.** Before anything is posted, one Gemini pre-read of the waiting flags (up to 12 a run)
writes each card's summary and its Product, Exposure Tag and Sensitive Topic lines, says which flags tell the same
story, and compares them with the alerts posted lately, the small posts still waiting, and the stories already alerted.
Then, story by story:

| The flag | What happens |
|---|---|
| Matters by itself: a KOF author (from the listening data), 100+ engagements, or a P0 exposure tag | Posted as an alert of its own. A post the pre-read judged a passing mention or a bare link needs a KOF author or 2,000+ engagements |
| Small (none of those) | Not posted. It waits on the Watch detections tab. Once **3 accounts** tell the same story within **12 hours** (two posts from one account count once), they go out together as **one** alert: the newest post leads, its card has a `Building:` line, and the other posts are listed in its thread. One that never gets company stays on the tab, unposted |
| Small, then it grows | When a source hands the post over again with 100+ engagements, it is queued again and goes out as an alert of its own |
| On the story of a watch alert posted in the same space in the last 24 hours | Added to that alert's thread, not posted again. A KOF author where the alert had none, or 2,000+ engagements where the alert had fewer, is posted as a new alert |
| On a story already alerted in the last 14 days (any flow: Burson's alerts, Direct BigQuery alerts, another space) | Not posted again, unless the stakes rose (as above) or the pre-read says the post reports something new (a ruling, an official response, new evidence) |
| Not about Google (the pre-read), with no Google product from the listening tool | Not posted, unless a KOF wrote it or it has 2,000+ engagements |
| The same post or X thread already alerted, a post not in English, or nothing to show (no summary, text or picture) | Not posted |

The thresholds are SLRR's own: 100 engagements is the collection floor, 2,000 the high-engagement bar, 14 days the
novelty window. Follower count alone never makes a post an alert: in two days of live Watch alerts (Nov 10 to 12, 2026)
it didn't predict which cards were useful.

Each alert is a text message in the bot's own format, so it never looks like a Zapier alert, with the post's picture
attached when one can be found:

```
🔭 *Watch alert · Midterms 2026 × Google*
*Link:* View the post on X                    (a hyperlink)
*Author:* @someone · X · 1,700 followers · 520 engagements
*Posted:* 2026-11-01 23:26 ET
*Product:* Search, AI Overviews
*Exposure Tag:* Product - Perceived bias (P0)
*Sensitive Topic:* Politics
*KOF:* Yes (Viral KOFs)
*Summary:* … (the pre-read's neutral summary, else the watch's own)
*Building:* 4 small posts from 3 accounts within 2 hours (X, Reddit) · 57 engagements in all
*Same story:* 3 more posts in the thread (@a, @b, @c)
```

The `Building:` line is only on an alert for a build-up of small posts, and `Same story:` only when other posts are
listed in its thread. The score, the watch's bar and topic and the source that found the post stay off the message; the
triage gets them from the bot's own record.

The space's flow works the alert on its next run (a minute later) with a full Gemini triage: ❌ No action, 👍 Worth a
look, or a Social Alert to the right teams (only the testers while Testing, as for any alert), and T&S only when the
post's rules say so. For a build-up, the triage is told to judge the story and its momentum, not the one post's
engagement. Its Alert-log row says `Watch alert`: never on the Results tab, never written to the SLRR tables.

At most 5 go out a run in B33 and 2 in the Mirror or Auto-correct space (the flags that matter by themselves first, then
the highest scores; none while that space's flow ran out of time). If the pre-read fails, flags wait up to 30 minutes
for it, then go by the listening tool's own classification. A flag that can't go out within 3 hours (B33 blank, say) is
dropped, never posted late, and only flags seen while B35 is set ever go out. A post two watches flag gets one alert.
C35 says where they go and counts the day: posted, how many of those were a build-up, posts added to a story's thread,
small ones held to be grouped, repeats held back, off-topic ones not posted, and why any wait.

### Temp checks (row 36): the team's temperature check, on request

With **Temp checks** ON, an analyst writes `temp check` and the Brandwatch query's name in a thread of the Mirror space
(B9) or the Other alerts space (B33), as the team names them in **[SLRR] Private** (`temp check [G EVENT] NOV26 Issue
name`; part of the name, the query's link or its id work too). After that run's alerts the bot **emails** the temp check
from its account to the testers (B30, else the stand-in: "from me to me", as the Social Alerts go while Testing), in the
team's UPDATED STANDARD TEMPLATE (docs.docx, "Brand Safety Temp Check") line for line, times in PT:

```
(10/29) 2020 Election Query Results (6am PT)
BW source: Link ([G EVENT] OCT26 2020 Election Query Results)

TL;DR: There have been 7,322 total mentions regarding 2020 Election Query Results. Volume is currently [#], placing the
story in the [bottom / top-XX%] of Google Issues YTD. Velocity is -70% since the peak at 12pm PT on 10/28. <Gemini's summary>

Sentiment: 60% neutral, 37% negative, and 3% positive.
  • Negativity Drivers: … (Gemini)
  • Themes: … (Gemini)

Source Breakdown: X (84%), followed by Bluesky (7%) and Reddit (5%).

Highest Engaging Posts:
  • CameronCorduroy on X - "…" (18.5K Engagements)
  • HQNewsNow on X - "…" (8.3K Engagements)
  • couriernewsroom on IG - "…" (2.5K Engagements)
```

The thread only gets a short note: `🌡️ Temp check sent: @asker (10/29) 2020 Election Query Results (6am PT) was emailed to
… Open the email. Reply "refresh" here for an update.` The write-up itself is never posted in Chat.

- **Where the count starts:** the first hour the query reached 100+ mentions (the slides' rule), looked for from 48
  hours before the query was made; an issue that never got there counts from the alert in the thread, else from when
  the query was made. `temp check … since 9am PT` (or `since 10/28 9am`, any US zone) sets it ("Since 9am PT on 10/28
  there have been …").
- **Updates:** `refresh` (or `update`, or `temp check` again) in the same thread emails the update on the same email
  thread ("Since the last update at 9am PT, there have been N new mentions (M total mentions)…"), still counted from the
  issue's start. One request a thread at a time: another `temp check` there while one waits is left to it (one naming a
  query or a time takes its place), so the thread never gets two.
- **No query named:** the bot lists the newest `[G EVENT]` queries to copy (in the thread); a name no query has gets the
  closest ones; several matches get the list.
- **Concern level:** not yet. It needs the 12-month benchmark of past `[G EVENT]` queries (the next step); until then
  the email keeps the template's own words (`Volume is currently [#], …`) for the analyst to fill in, never a guess.
  Where Gemini gives nothing, the template's placeholders for the drivers and themes stay too.
- **BW source:** "Link" opens the [SLRR] Private project's queries in Brandwatch (the bot doesn't know the team's
  dashboard for the issue), with the query's name beside it.
- **Brandwatch is only read**, with the shared token (the bot never makes, edits or deletes a query or dashboard). The
  counts come from Brandwatch's totals (nothing downloaded); at most 35 posts are read a temp check, reposts excluded
  (the export rules: X's allowance is shared by every Google team); X posts' words come from X's public embed data, and
  their engagements are X's likes plus replies. When Brandwatch is busy (the shared login's call limit, which other
  tools use too) the request waits, tried again every minute for up to 30 minutes, and its thread is told once.
- **Each email goes once**, only to the testers (Mail.gs's guard); Gmail refusing it is tried again next run.
- **Never Burson's:** a `temp check` request is never relayed to S-F Burson (or the Burson test copy), and the bot
  posts only in the request's own thread, never in S-F Burson, the test copy or a space people outside Google can join.
  OFF (as it starts), nothing changes: such a message is an analyst's message like any other.
- C36 says how the last one went.

### The switches: what the bot may do on its own (rows 11-24, 27-29, 32, 34, 36, 37)

Rows 11-24, 27-29, 32, 34, 36 and 37 are ON / OFF switches (a dropdown in column B). Each starts **OFF**, and with every switch OFF the bot works
exactly as the rest of this README describes (in S-F Burson itself, it posts nothing: row 24). Column C says what OFF
means, or what an ON switch is doing (its counts today and its last check). The bot rewrites column C every run, paused
or not.

| Row | Switch | OFF (the default) | ON |
|---|---|---|---|
| 11 | Auto-send Social Alerts | A Gmail draft for a person to send (in Testing, the email goes only to the testers in B30) | The bot sends the Social Alert itself (to real recipients when LIVE; only to the testers in B30 when Testing) |
| 12 | Auto-submit T&S form | The pre-filled T&S form link, for a person to submit | The bot submits the form itself (the test copy while Testing; the real form when LIVE), and the urgent email when it's urgent |
| 13 | KB & Guidance can start alerts | The Resources documents and the Guidance tab can only stop an alert or correct it | They can also start a Social Alert the rules wouldn't, when Gemini quotes a Guidance row or a document and the quote checks out |
| 14 | Auto-find missing links | A missing link or author is asked of Burson | Looked up in the listening feeds (BigQuery) first |
| 15 | Direct BigQuery alerts | Only the alerts posted in Chat are reviewed | Sprinklr, DSD / Brandwatch and Sonar posts are taken straight from BigQuery too (test feed and Mirror only) |
| 16 | Write back to SLRR BigQuery | Nothing is written to BigQuery: Burson and shared dashboards can't see the bot at work | When LIVE, finished alerts and sends are written to the shared SLRR tables, marked as the bot's (in Testing, writes only to `TEST` or skips shared tables) |
| 17 | Learn from IM calls | No learning | The IMs' different calls go on a Learned precedents tab, and Gemini sees the similar ones |
| 18 | Watch sent alerts (24h) | The bot stops once the Social Alert is sent | For a day it re-checks the post and replies on the email thread on a surge, a deletion or press pickup |
| 19 | Early wave & velocity check | One post at a time | Every 15 minutes it builds open-world clusters and velocity spikes itself from the approved source tables in BigQuery (read-only), reviews each (web search, knowledge base, guidance) and posts ONE story card with the posts linked, next steps and a picture in the Mirror space (40 a day at most; never relayed or forwarded to Burson) |
| 20 | Check outage & comms docs | The standard review | Gemini checks outage claims and the email gets the approved holding statement |
| 21 | Track post-alert outcomes | Nothing is read after the Social Alert is sent | Replies and T&S confirmations are read for a week, the outcome is logged, and the **Follow-up** tab is kept up to date |
| 22 | Relay with S-F Burson | The Mirror space gets Zapier's alerts only; nothing is posted in S-F Burson | Analysts work in the Mirror space only: everything in S-F Burson comes over in its own order (Zapier's alerts, everyone's replies, messages and emojis); the analysts' (never the bot's) go straight to the Burson test copy (B26) when it's set, or wait on the Burson outbox when LIVE and Post in S-F Burson is ON |
| 23 | Never wait on Burson | A wrong alert gets ⬇️ and a request to fix and resend it, and waits for the resend (no ❌, T&S form or decision until then); a missing link or video timestamp is asked of Burson | The bot decides a corrected alert at once (the Social Alert, ❌ or the T&S form) and tells Burson what it changed; a long video's missing timestamp is the one Gemini found; Burson's resend anyway is the same alert |
| 24 | Post in S-F Burson | Nothing is posted, replied or reacted in S-F Burson (or the Burson test copy by the bot itself): it's held back and never sent later | In Testing with B26 set, the bot's own Burson replies and legend emojis in the Mirror space go straight to the Burson test copy (B26). When LIVE, each post, reply and reaction (from the bot or the Relay) waits on the Burson outbox tab, Pending; only a row a person sets to Send is posted to S-F Burson, once |
| 27 | Draft follow-ups | Overdue Social Alerts are shown on the Follow-up tab, with no email drafted | With row 21 ON, creates a Gmail draft on the Social Alert's thread when no team has replied by the deadline (`B5:B7` on the Follow-up tab), and one more a day later while it isn't resolved (never sent; addressed only to the testers in B30 while Testing) |
| 28 | Draft answers to questions | Questions teams ask on a Social Alert's thread are shown on the Follow-up tab, with no answer drafted | With row 21 ON, Gemini drafts a Gmail reply on the thread from the alert, the bot's review, the Resources documents and the Guidance tab when it can answer with 90%+ confidence; when it can't, no draft is made and the Follow-up tab says it needs an IM |
| 29 | Safety valve | **B26 decides:** when B26 is set, the bot is in **Testing**; when B26 is blank (and S-F Burson B25 is found, with alerts coming from it), the bot is **LIVE** | Always **Testing**, even when B26 is blank: every email/draft goes only to the email addresses in `Control!B30` and nothing goes to S-F Burson |
| 32 | Work directly in B25 (Google-only) | B25 is the real S-F Burson: the bot posts nothing there itself (only Burson outbox rows a person sets to Send) | When only Google people can join B25, the bot works right in it as in the Mirror space: it reviews every alert there (Burson's format, or **any other format**, which gets its own triage) and posts its notes, replies and emojis there directly. Always **Testing**. With people outside Google able to join B25, it does nothing |
| 34 | Proactive watch | The bot reviews only the alerts posted in Chat | Every 5 minutes Gemini (inside BigQuery) checks what's new in each source, read-only (Sonar, Brandwatch, Sprinklr, Tubular, the DSD story selection feed, the Other alerts space's alerts and the Brandwatch query "2026 Election Alerts" straight from Brandwatch's API), against the watches ON on the Watches tab, and what it would flag goes on the Watch detections tab, with a scorecard against Burson's alerts; the Watch sources tab says which sources are live. Nothing is posted or emailed unless **Watch alerts** (row 35, not a switch: `OFF`, `Other alerts space (B33)`, `Mirror space (B9)` or `Auto-correct space (B10)`) says where its flags go; nothing is written to BigQuery |
| 36 | Temp checks | Temp checks are done by hand; a `temp check` message is an analyst's message like any other | `temp check <Brandwatch query name>` in a thread of the Mirror space or B33 gets the team's temp check write-up in that thread after the run's alerts (above); never relayed to S-F Burson; Brandwatch only read |
| 37 | Group test emails | When LIVE, Social Alerts go to the live Google Group emails in column B of the Brand safety groups tab; the test emails in column C are ignored | Puts the bot in **Testing** and sends each Social Alert to its group's test email in column C of the Brand safety groups tab; a group with no test email is skipped and logged |

What holds for every switch:

- **ON only when it says so.** A switch is ON only when its row has the switch's own label and column B says ON. The
  bot never sets a switch ON: a row whose label is missing or changed is put back OFF. A Control tab from before the
  switches gets rows 11-24, 27-29, 32, 34, 36 and 37 on the next run (no need to run `setup()`), all OFF, row 25 (S-F Burson space) blank, row 26 (Burson test copy) blank, row 33 (Other alerts space) blank and row 35 (Watch alerts) OFF.
  The values in B2:B10, B25:B26, B30:B31, B33, B35, and any switch someone already set, are kept, and "How it works" moves to row 39.
- **Testing vs. LIVE is decided on the Control tab every run (`Main.gs` `runMode_`).**
  - The run is **LIVE** only when **Safety valve (row 29)** and **Group test emails (row 37)** are `OFF`, **Burson test copy (B26)** is blank, and **S-F Burson (B25)** is set and found (with alerts coming from S-F Burson via B3 or Mirror B9). While LIVE, Status (B5) starts with the LIVE badge, emails/drafts use real `Brand safety groups` recipients, the real T&S form is used, leads receive DMs, SLRR BigQuery write-back (row 16) writes to the shared tables, and the **Burson outbox** can send rows marked `Send` to S-F Burson.
  - Everything else (Safety valve `ON`, or Group test emails `ON`, or B26 set even if failing checks, or B25 blank/not found, or row 32 working directly in a Google-only B25) is **Testing** (fail closed): every email or draft goes only to the email addresses in `Control!B30` (`Testing: send to`; nothing is sent while `B30` is blank), except that with Group test emails `ON` each Social Alert goes to its group's test email in column C of `Brand safety groups` (a group with none is skipped and logged); only the test copy of the T&S form is submitted, and nothing is ever queued for or sent to live S-F Burson (any outbox row set to `Send` while in Testing is reset to `Pending` with a note). The **Auto-correct space (B10)** and the **Other alerts space (B33)** always stay in Testing even when the Mirror run is LIVE.
- **Nothing reaches S-F Burson unless a person sends it.** Only Post in S-F Burson (row 24) while LIVE lets anything be posted
  there, and then only the Burson outbox rows a person sets to Send (re-checking the Safety valve and B26 right before each row). No other switch posts or reacts in S-F Burson.
  Nothing Burson can see mentions the analyst space, the listening feeds, BigQuery, write-backs or automation.
  New posts go to the analyst space (in the alert's thread, or top level for early warnings).
- **Never twice, never in the way.** Each switch remembers what it did (the Alert log's `tns_submitted`, `bq_written`,
  `outcome` and `ingested` columns, `email_input.watch_state`, and script properties), so a retry, a resend or the other
  test space never repeats a send, a form, a write or a warning. A switch that fails is logged and retried later where
  that's safe; it never stops the run.
- **Thresholds are constants** at the top of the `.gs` file that owns the feature (no YAML, no rebuild): for example
  `BQ_LINK_*` (row 14), `BQ_POLL_MAX_PER_RUN_`, `BQ_BSIP_MIN_ENGAGEMENTS_` and `BQ_BSIP_MAX_AGE_H_` (row 15) and row
  19's queue and daily caps (`EW_*`, `ED_QUEUE_*`) in `BigQuery.gs`, row 19's detection thresholds (`EWS_*`: the
  low-tier gates, the similarity bars, the promotion and velocity rules) in `EarlyWaveSource.gs`, and the watch and
  outcome timings in `Watch.gs` and `Outcomes.gs`.
- **Check BigQuery before turning on rows 14, 15, 16 and 19.** Their tables' columns couldn't be checked from here:
  run `bq show --schema` on the tables named below first. A query that fails does nothing (the bot carries on as with
  the switch OFF); a write can't be taken back for a while (row 16).

#### Row 11: Auto-send Social Alerts

- **OFF** (the default): as described above. While testing the bot sends each Social Alert itself, only to `Control!B30`;
  with real distros it leaves a Gmail draft for a person to send.
- **ON while testing**: nothing changes. Every Social Alert still goes only to `Control!B30`, and
  C11 says so.
- **ON live** (the real Burson space, not the Mirror or Auto-correct space): the bot sends the email the
  draft would have been, to the same people, as soon as the alert is escalated. Then it marks the sent and team badges for
  who it went to, posts "Social Alert sent" under the forwarded alert (with the T&S form details when T&S should see
  it), and C11 shows how many went out today. With no draft left, analysts' reactions on the forwarded alert
  no longer change the email.
- **Never twice:** the bot notes each alert before sending it. If Gmail refuses the send, or a run stops partway, that
  alert gets the usual draft instead, with a warning to check Sent in Gmail first and not to send it again if it went.
  If the send did go out, the bot finds it in Sent (for half an hour, and again if someone deletes the draft), marks
  the alert sent and removes the draft, so it's never taken for No action taken.
- **Stays a draft:** an alert whose product has no alert contacts on file, an alert still waiting on Burson for
  something only they can fix (a missing link, a tag not on the list, a bad post date), and an alert whose link the bot
  found itself (row 14), until a person checks it's the right post. The note says why.
- **Results tab:** the IMs have nothing left to do on an alert the bot sent itself, so their call on it is "Bot sent
  it" (unless they drafted, sent or logged one too) and "Same call?" says "Can't tell". It's in neither "only" list and
  never goes on the Learned precedents tab (row 17).

#### Row 12: Auto-submit T&S form

- **OFF** (the default): when T&S should see an alert, the note under it has the pre-filled T&S form link for a person
  to submit (see "T&S pre-filled link" below), and the bot marks confirmed when the confirmation email comes in.
- **ON while testing**: the bot submits the
  **test copy** of the form in the tester's Drive itself, with the answers the link would have filled in, before the
  Social Alert goes out (so the email says T&S: Yes). When the alert
  is urgent (P0, HIGH or VIRAL KOF engagement, child safety), the urgent email goes **only to `Control!B30`**.
  The real form and the T&S urgent alias are never touched while testing.
- **ON live**: the bot submits the **real form**, and emails
  the configured T&S urgent alias when it's urgent. FormApp can't open the form by its public link, so first put the
  form's editor id (from its `…/forms/d/<id>/edit` link; the bot's account needs edit access) in the script property
  `TNS_LIVE_FORM_ID`. Until then the note keeps the link for a person, and C12 says why.
- **Never twice for a post:** the bot notes each post before it touches the form (script property `TNS_AUTO_LINKS`,
  which every space's run reads, and the Alert log's `tns_submitted`). Another alert on the same post, or the other
  test space, gets "already submitted", and a post someone already marked ✍️ isn't submitted again. The bot's own ✍️
  for the test copy doesn't count once live: a post tested on the real Burson space gets the real form when it comes
  again after go-live. If the form refuses it, or the run is out of time, the note has the link again with a line
  saying why, and the bot never tries that post again. C12 shows how many it submitted today.
- **Urgent later:** the urgent email only goes with the bot's own submit. When a post T&S already has turns urgent
  (a new alert with HIGH engagement, say), the note under the new alert asks a person to send the urgent email.
- **Turned OFF after a submit:** an alert whose form the bot already submitted keeps saying so (its email's retry,
  a Social Alert that fails for good), so nobody is asked to submit it twice.

#### Row 13: KB & Guidance can start alerts

OFF, the Guidance tab and the Resources
documents can only stop an alert or correct its fields, exactly as before. ON, they can also start a Social Alert the
rules leave below the bar (under 2,000 engagements, or an ongoing issue with no KOF author): Gemini must be at least 90%
sure, name the Guidance tab row or the document that says posts like this get a Social Alert, and quote it, and the bot
checks the quote word for word against that row or document. The quote's sentence must say to alert (escalate, a Social
Alert, send an email): a sentence that only mentions the topic doesn't count. A lead's email can't start one, and neither
can a row or document that says to hold, skip or not alert on posts like these ("Social Alerts are not needed", "no Pixel
alerts", "stop escalating", "monitor only"), or a row whose Applies to names only other products than the alert's. It
never overrides an exclusion, the YouTube protocol, a no-alert check or an alert that already went out, and never sends
the 🧑‍💻 DM. Analysts see `Why: Escalated per Guidance: "…"` (or the document's name) in the draft note (while testing,
in a note under the alert once it's sent to the stand-in) and on the Results tab; the email and Burson never see it.
While testing (a stand-in), the Social Alert goes only to the stand-in, like any other. Column C counts the alerts it
started today.

#### Row 14: Auto-find missing links

- **OFF** (the default): an alert without its link or author is asked of Burson, as always.
- **ON**: before asking, the bot looks the post up in the listening feeds: one read-only BigQuery query (`us-central1`)
  over Pendulum's posts (`sonar_raw`) from the last 48 hours and a small `US` check of the SLRR log (`slrr_alerts`, same issue name). It takes a link only when one
  post clearly matches: same network, never another author, posted within a day of the alert's time, a similar
  engagement count, and no second post close to it. When the alert names its author, a post the feeds have no author
  for isn't enough on its own. A post the bot already alerted in the last 14 days is never taken (it may be the same
  author's newer post that the feeds don't have yet). Otherwise Burson is asked as before. An alert with its link but
  no author gets the author from Pendulum's entry for that post.
- **Resends**: Burson's resend of an alert whose link the bot found is still recognized as the resend, as with the
  switch OFF: with or without the link, and also when nothing else was asked. When Burson was asked to fix something
  else and the resend still has no link, it keeps the one found, so Burson isn't asked for it then either.
- **What people see**: analysts get the alert with the link on its `[Link]:` line, "QA corrected: Link is now …" and a
  note saying it was found in the feeds and how sure the bot is. The post lookup, the enrichment, Gemini's review and
  the Social Alert email all use the link. Burson isn't asked for it and is never told; nothing new is posted in the
  Burson space. Column C shows `found N of M today`.
- **With the other switches**: a link the bot found is a guess until a person checks it, so Auto-send (row 11) leaves
  that alert a draft with a note to check the post, and Auto-submit T&S form (row 12) never puts it in the real T&S form
  (a person submits it from the pre-filled link; the test copy is still filled in while testing).
- **Sandbox**: the switch sends nothing and writes nothing to BigQuery, so the stand-in rules don't change. It works the
  same in the Mirror and auto-correct spaces.

#### Row 15: Direct BigQuery alerts

- **OFF** (the default): the bot reviews only the alerts posted in Chat. No BigQuery query is made for it.
- **ON**: at most every 5 minutes, before reviewing the Burson space, the bot reads new posts straight from BigQuery
  (read-only) and posts each one it hasn't seen, as a Zapier-format alert, in the space it reads as Burson's, so it
  reviews and actions it like any alert (at most 2 a check, `BQ_POLL_MAX_PER_RUN_`): **Sprinklr** owned posts with 30+
  comments and 30%+ negativity, and **DSD story selection / Brandwatch mentions** (`DSD.DSD-story-selection` HIGH/KOF
  plus `raw_data.brandwatch_raw_mentions_base` negative/KOF earned posts), each its own US query,
  so one that fails doesn't stop the other; **BSIP** (`sonar_raw` + `tubular_videos`): posts Pendulum tagged and saw in the lookback window, posted at most 48
  hours ago, with 500+ engagements or KOF, the most engaged first (`BQ_BSIP_MIN_ENGAGEMENTS_` and `BQ_BSIP_MAX_AGE_H_` in BigQuery.gs), a `us-central1` query plus a small US check of
  the SLRR alert log. A post is never posted twice: not if the bot already has it,
  took it before, the SLRR alert log has it from the last 7 days (under any link to it), or Burson's alert of it is
  already in the space waiting to be reviewed. The alert gives the post's time in UTC (`2026-10-14 11:40 UTC`), as
  BigQuery has it.
- **Burson's alerts come first**: a check is skipped, and column C says why, when the last run ran out of time or while
  3 or more of the posts it took still wait to be reviewed (`BQ_DIRECT_MAX_WAITING_`). The space is read first: when
  that fails, BigQuery isn't queried.
- **Cost**: the Sprinklr query reads about 3.3 GB a check, so up to about 0.95 TB a day at one check every 5 minutes
  (less when checks are skipped). It's billed only while the switch is ON.
- **Where**: only in a test feed or the Mirror space. It does nothing (column C says why) when the Burson space is the
  live one, a space people outside Google can join, or in a dry run, so nothing new ever reaches Burson. "Into the
  analyst/test space" therefore means the test feed or the Mirror training space: the bot reviews only the space it
  reads as Burson's, and from there analysts get the alert as usual.
- **Results tab**: these alerts weren't Burson's, so they're left out (their Alert log rows carry `Sprinklr`, `BMIE`
  [legacy code for DSD / Brandwatch] or `BSIP` in the `ingested` column). When Burson then alerts the same post and the bot ❌s it as already alerted, the
  bot's call on Burson's alert is the Social Alert it sent from BigQuery (its email time, 0 minutes when it went out
  before Burson posted, and its reason). Column C shows `last check … · N posts today`.
- **Sandbox**: emails, DMs and forms for these alerts follow the same stand-in rules as any alert. Nothing is written to
  BigQuery.

#### Row 16: Write back to SLRR BigQuery

- **OFF** (the default; keep it OFF until the checks below are done): the bot writes only to this sheet. It never
  writes anything to BigQuery.
- **Known issue: keep it OFF.** Its writes can't succeed today: `alert_sends` requires `send_id` and `slrr_alerts`
  requires `sheet_row_number`, and the bot sends neither. While it was ON on Oct 21, BigQuery refused the bot's
  `alert_sends` rows (testing writes nothing to `slrr_alerts`), so none of the bot's rows are in either table. Adding
  the columns needs the table owners' agreement first.
- **ON while testing** (a stand-in set, as now, or in the Mirror, Auto-correct or a test space): each Social Alert the
  bot sent goes in `slrr_feedback.alert_sends` as one row with `environment` TEST. Nothing goes in
  `slrr_alerts.slrr_alerts` (that log has no test flag), and alerts with no email write nothing. C16 says so.
- **ON live** (the real Burson space, no stand-in): every alert the bot finishes goes in `slrr_alerts.slrr_alerts`:
  sent, ❌, T&S form only, YouTube left for a person, a draft deleted unsent or ❌'d, or an email that failed for good.
  A sent one also goes in `alert_sends` as PROD. Each row has the bot's mark (`burson-qa-bot` in `drafted_by`,
  `identifier_analyst` and `source_tab`). From the bot's first write on, the Results tab and the bot's own "already
  alerted" checks leave those rows out, so the bot never takes its own rows for the IMs' (until then those reads are
  exactly as before). Nothing about it is posted in Chat.
- **Never twice:** each alert is written once (the Alert log's `bq_written`, the bot's memory, and BigQuery's insertId
  `<alert_id>:<kind>`). If BigQuery refuses a row, the bot tries again 5 minutes later, 3 tries in all. After that it
  gives up, and C16 and the Status say so (and which table has it already). If BigQuery's answer is lost (a dropped
  connection or an HTTP 5xx: it may have the row), the bot sends it once more right away, while BigQuery still drops a
  repeat; if it's still unsure, the next try first looks for the row and sends it only if it isn't there. A retry
  writes the alert as the run that finished it was (live or testing), and one still waiting after 2 days (the switch
  was OFF meanwhile, say) is given up, not written. It never stops the run.
- **Before turning it ON:** check both tables' columns with `bq show --schema --format=prettyjson
  brand-social-central-data:slrr_alerts.slrr_alerts` (and `:slrr_feedback.alert_sends`). The bot writes only columns
  the code already reads, each as text. Also check with the table owners that rows streamed in are kept (for example,
  that `slrr_alerts` isn't reloaded from the SLRR sheet in a way that drops them).

#### Row 17: Learn from IM calls

OFF, there is no Learned precedents tab and the review is
exactly as before. ON, each Results tab rebuild copies the alerts where the bot and the IMs made a different Social
Alert call (the IMs sent one and the bot didn't, or the other way round once a day has passed) to the bot's own
**Learned precedents** tab, right after Results: Date · Post · Product · Exposure Tag · Engagements · KOF · Bot call ·
IM call · Lesson / Why (the bot's reason) · Active, the latest 100. Calls that wait on Burson's fixes, have no reason
or were left for a person (YouTube) aren't copied. Live (no stand-in, not the Mirror space), neither is a Social Alert
the bot sent: it went to the team, so the IMs not sending a second one isn't a different call. Set **Active** to No to
leave a row out (blank means Yes); the bot keeps it, and puts back its own text in the other columns. Deleting a row
doesn't remove it: while its post is on the Results tab (7 days) the next rebuild puts it back. It writes the tab only
when something changed, and not while the IMs' side is from an older BigQuery read. Columns people add after L would
end up next to other rows, so while there are any the bot leaves the tab as it is (column C says so). Each review
then shows Gemini up to 5 active rows about the same product or exposure tag (never the same post) as "past IM
decisions", so it makes the IMs' call; analysts see which in the run log. No extra Gemini call, nothing new in Chat or
email, and Burson never sees any of it. It needs the Results tab (`speed_tab`). The bot never reads or writes a tab
with that name it didn't make (column C says so). Column C shows how many rows the tab has.

#### Row 18: Watch sent alerts (24h)

**OFF:** the bot stops once the Social Alert
is sent, as it always has. **ON:** for a day after a Social Alert is sent, the bot re-checks the post every 30 minutes
(at most 3 alerts a run) and, once for each, replies with one line on the Social Alert's email thread (with the post's
link, as a thread can also carry follow-up alerts about other posts) and notes it under the alert in the analyst space
when:

- the engagement passes 50,000 and is at least 3x the count the alert went out with (the higher of the post's own likes
  and replies on X and Bluesky, and Sonar's count in BigQuery);
- the post is deleted or taken down (X, Bluesky and YouTube; checked twice, 10 minutes apart, after the bot saw it up);
- the press picks it up (Gemini with the web search, once every 3 hours per alert; never without the web search).

Alerts sent in the last day before the switch was turned on (or while it was OFF) are watched too: the bot looks for
them in the Alert log on its first run with the switch ON, then at most every 3 hours.

While testing (`escalation.stand_in` set, as now) the reply goes only to the stand-in, in every space. Live (the real
Burson space, no stand-in) it goes to everyone the Social Alert went to, as Gmail shows it sent (anyone the IM took off
stays off); when Gmail can't say, no reply goes out. No reply goes on a thread where a follow-up Social Alert is still a
draft either. A reply that isn't sent is never tried again: the note asks the IM to send the update. Nothing is posted
in the Burson space. What was reported is kept in the Alert log (`email_input.watch_state`), so no update goes out
twice, and a newer alert on the same post, on the same thread, doesn't repeat a press pickup. C18 shows how many alerts
it's watching, the last check and today's updates (the main run's, not the auto-correct space's). The code is in
`Watch.gs`.

#### Row 19: Early wave & velocity check

- **OFF** (the default): no early-detection read, review or card.
- **ON**: open-world early detection over low-tier posts. The bot builds the signals itself (`EarlyWaveSource.gs`): it
  clusters small accounts' posts by meaning and spots fast-rising topics without knowing the topic in advance. After
  each run's alerts, at most every 15 minutes, it reads what is new in the approved source tables, read-only, with one
  BigQuery job per location (`US` and `us-central1`): Sonar's posts and Sprinklr's comments in real time; Brandwatch
  and Tubular later, only to join a story that already exists. It embeds the posts it hasn't seen (Vertex AI
  `text-embedding-005`), clusters them and checks their velocity in Apps Script, and **queues** the new signals (script
  properties). Nothing is posted at that point and nothing is written to BigQuery.
- **Review, then one card**: every run (after the alerts, never while they catch up, within the API guard's background
  budget) the bot reviews up to 2 queued signals. Each gets ONE Gemini review with the web search on, the knowledge base
  documents (Resources tab), the guidance rules, the playbook, earlier alerts and known issues, and a still of the main
  post at most (never its video). Only then does it post ONE story card in the Mirror space (or the Google-only test
  feed):
  - a headline saying exactly what people are posting about, the call (📦 Social Alert / 👍 monitor / ❌ no action), how
    many accounts on which platforms and when (ET);
  - a short story with the posts linked inline (only links to the signal's own posts: anything else Gemini writes is
    dropped), what the web says with its sources linked, and suggested next steps inside the escalation process;
  - every post as a link, and the picture of the post that best shows the topic (Gemini picks it; else the main post).
  The review note (why, SLRR classification, Temp Check query, T&S) goes in the card's thread, with the marks and any
  Social Alert / T&S draft behind human review, as for any alert. With no AI review, the card tells the story from the
  posts themselves.
- **One story, one card** (same-story dedup), within 24 hours. A signal tells the same story as a card already posted
  when it has the same cluster, the bot's own producer marked it as an update of that card's alert, or it shares 2+ of
  the card's posts (the producer, `EarlyWaveSource.gs`, also holds back a story whose centroid is within
  `EWS_STORY_SIM_` of one it signalled in the last 24 hours, unless it grew). The rules:
  - **Nothing new:** it is held back without a review. "New" means 2x the accounts on the last card and 3 more, or a
    platform the card wasn't on.
  - **The story grew:** it is reviewed (Gemini sees the earlier card and what changed). Its card goes in the earlier
    card's thread as `📈 *Early Detection Update: …*` with a `*What's new:*` line ("14 accounts now, up from 6; now also
    on Reddit"), without a picture.
  - **Already alerted:** a review that finds the issue already alerted, with nothing materially new, posts no card.
  - **Covered by another alert:** a signal whose main post another alert (Burson's, Direct BigQuery's) covered in the
    last 24 hours is skipped.

  The check runs when signals are queued and again right before each review, so two signals on one story never both
  get a card. Column C adds `· N repeats held back` to its count of the day.
- **Ceilings** (constants in the early detection section of `BigQuery.gs`): 5 signals queued a check, **40 a day** (then
  not even the BigQuery read until tomorrow), 2 reviews a run, at most 12 waiting, each signal reviewed at most twice (a
  run that dies mid-review counts) and dropped if not reviewed within 3 hours. So early detection costs at most 40
  Gemini reviews and 40 cards a day (80 reviews in the worst case of failed retries), plus what producing the signals
  takes each check (`EWS_*` constants in `EarlyWaveSource.gs`): two read-only BigQuery jobs (BigQuery refuses one that
  would read more than 5 GiB) and at most 400 new embeddings, 20,000 a day. Column C shows `last check … ·
  N waiting for review · N cluster, M velocity alerts today` and says when the daily cap is reached.
- **Where**: only the Mirror space (B9) or a Google-only test feed: never S-F Burson (B25), the Burson test copy (B26),
  a space people outside Google can join, the auto-correct space, row 32's direct mode, or a dry run. The cards'
  `client-zeda-` ids keep the Relay from ever sending them to S-F Burson.
- **Sandbox**: the card itself sends no email, DM or form and writes nothing to BigQuery; a Social Alert draft or T&S
  intake it leads to follows the usual Testing rules (stand-in / B30 testers only).

#### Row 20: Check outage & comms docs

OFF, the review is exactly as before. ON, for a
post about a Google outage, a widespread bug or a policy issue, Gemini uses its web search (already on for every review)
to check whether Google has confirmed it or posted a status update, and copies the approved holding statement from a
Resources document when one covers it (in the knowledge-base search, a passage with "holding statement", "reactive
statement", "talking points", "known issue" or "status update" ranks higher; every other passage, and so what Gemini
reads about an unrelated alert, is as with the switch OFF). The bot trusts the "confirmed" call only when Gemini's
answer came with web sources (otherwise it says "searched; no web sources returned" when Gemini searched and got none,
"not checked" when it didn't search, and "unclear" when it had sources but couldn't tell), names the
source without a link (not even a bare web address), and keeps the statement only when it is word for word in that
document: it never writes or rewords one. Analysts see one `Comms / Status Context: …` line under the forwarded alert
(in the auto-correct space, in the change note), and analyst answers know it. The Social Alert email gets a
**Comms / Status Context** section under the Alert Details (Google's status when it was checked, and the holding
statement); while testing it goes only to the stand-in, like any other. Burson never sees any of it. No extra Gemini
call. Column C counts the posts it found context for today, with the last one.

#### Row 21: Track post-alert outcomes

**OFF:** the bot doesn't read anything after the Social Alert is sent, and the Results tab is as it was. **ON:** for a
week after a Social Alert is sent, the bot reads the replies on its email thread (every 30 minutes the first day, then
every 2 hours; at most 5 threads a run) and writes what came of it in the Alert log's `outcome` column, with a short note
under the alert in the analyst space:

- **Resolved**: a reply says it's resolved, fixed, mitigated, rolled back or taken down (not "will be", "not yet", "if"
  or a question; "…and will keep monitoring" or "…, no further action needed" after it is fine);
- **T&S confirmed**: the T&S "WD Intake Request" confirmation email for the post came in;
- **Comms replied**: someone on a comms team (GCPA, People Comms, Exec Comms, Stop Leaks, crisis) or the standard CC
  list replied;
- **Product replied**: the product's own alert contacts (its PAs, gUP, execs) replied.

An alert can have several (`Resolved · Comms replied`, strongest first), and one is never taken back. The bot's own
messages, out-of-office replies (by their subject, or a reply that opens with it, after a greeting at most) and bounces
never count; anyone else's reply counts only when it says it's resolved. When the switch is turned on, the alerts sent in the last week are tracked too,
including any sent while it was OFF, and the list is checked against the Alert log once a day. With it ON, the Results
tab's EVERY ALERT table has an **Outcome** column after "Bot alert ids". It only reads (Gmail's first words of each
reply, never sends anything), so testing and live behave the same; nothing is posted in the Burson space. C21 shows how
many alerts it's tracking, the last check and today's outcomes (the main and auto-correct spaces together). The code is
in `Outcomes.gs`.

#### Row 22: Relay with S-F Burson

**OFF** (the default): the Mirror space (B9) gets Zapier's alerts only, and the bot never posts or reacts in S-F Burson.
**ON**, with the Mirror space set, analysts can work from the Mirror space only, while the bot keeps working every alert
there exactly as before. Every minute, before the bot's own pass (each step with a few seconds of its own; the rest waits
for the next run):

- **From S-F Burson into the Mirror space**: everything, as anyone in S-F Burson sees it, in S-F Burson's own order (an
  item that can't come over yet holds back the ones after it; copies show the time they were posted, up to about a
  minute after S-F Burson's):
  - Zapier's alerts, in their place among the messages, copied exactly as the Mirror copies them (while the relay runs,
    the Mirror's own copying waits for it; C9 says so). An alert that can't be copied holds back what came after it:
    C9 says why and the run fails, as when the Mirror's own copying fails, and it's tried again every run. Still
    failing after an hour, it's given up on, with a note in the Mirror space and a Relay tab row;
  - a reply under a Zapier alert goes under the same alert in the Mirror space, as `Alice Smith (Burson): text`;
  - a message of its own comes over as a message of its own; a reply under it, or under a message an analyst sent,
    lands in the matching thread. A reply in a thread the Mirror space doesn't have (its first message is from before
    the relay was on, or was deleted) comes over as a message of its own, saying so;
  - everyone's, shown as `Name (Burson)` or `Name (Google)` when the **Relay names** tab says, the name alone while it
    doesn't (nothing waits on that tab). A file is named in the text, to open in S-F Burson. An alert a person pastes
    is brought over but never answered (as in S-F Burson).
- **From the Mirror space toward S-F Burson** (when **Burson test copy**, B26, is blank; only while Post in S-F Burson, row 24, is ON as well): nothing goes
  straight there. Each analyst message, reply and emoji becomes a row on the **Burson outbox** tab with the analyst's
  name, Pending, and goes only once a person sets it to Send (see row 24). With Post in S-F Burson OFF, Burson's side
  still comes over, but nothing the analysts write or react is queued, then or later.
  - **When a Burson test copy (B26) is set:** the analysts' messages, replies and emojis go **straight to the Burson test copy (B26)** instead of the Burson outbox (Post in S-F Burson, row 24, can stay OFF), and **nothing is ever written to or queued for real S-F Burson (B25)**.
  - an analyst's reply under an alert (or any message that came from S-F Burson) goes under the same
    message in S-F Burson (or its copy in B26), as `Dana Lee: text`, from the bot's account (Chat can't post as someone else). This works
    for alerts copied before the relay was on too. A reply under an analyst's own message still on the outbox goes
    under it once both are sent;
  - an analyst's message of their own goes as a message of its own, unless it starts with `internal:` or
    `[internal]`: then it stays in the Mirror space, and so do the replies under it;
  - a message that would show internal details isn't sent or queued: the analyst space or the test space (by name, id, or as
    "mirror/test/training space"), forwarding, internal emails, go/ links… The bot says so in its thread, and the
    analyst can post it again. Replies in a thread S-F Burson (or the test copy) doesn't have (under one of the bot's own posts) stay in
    the Mirror space, with one note per thread.
- **Emojis, both ways**, on messages posted since the relay was turned on: everyone's emojis in S-F Burson come over onto the
  matching message in the Mirror space; an analyst's emoji goes straight to the matching message in the Burson test copy (when B26 is set) or is queued on the outbox for the matching message in S-F
  Burson (once that message is there). It shows as the bot's account; the Relay tab says who added it. The bot never
  takes an emoji that came over from S-F Burson for an analyst's action (❌ or ✍️ on a copy); if the Relay tab can't be read, it acts on no
  emoji until it can. An analyst's 👎 ("the bot got this wrong") is never sent or queued.
- **Never relayed:** the bot's own work (its notes, answers and emojis stay in the Mirror space), even when it was done
  under another account (for example `poll()` run from the editor): the bot notes each message and emoji it makes.
  The bot doesn't answer the analysts; it may answer Burson's questions in the Mirror space, for the analysts to use or
  not.
- **It starts from the moment a run sees it ON**, and says so in the Mirror space. Only what analysts write from then
  on is sent or queued; nothing written while it was OFF or paused ever is, and OFF is noticed by the very next run (in the
  middle of a run, nothing written after that run read the switch is sent or queued, and no emoji once it's OFF). Into the
  Mirror space, Burson's last 15 minutes come over when it starts. If runs fail before the relay runs (even for a few
  minutes), or no run relays for 10 minutes (the bot wasn't running, or runs came from another account), it starts
  again from then and says in the Mirror space that what was written in between wasn't relayed. When the S-F Burson
  space (B25) or the Burson test copy (B26) changes, it starts again on the new space as when it's turned on; analysts' replies under alerts from the
  old space stay in the Mirror space.
- **When something fails**: an outbox row that fails when sent is Failed with the reason and never tried again by
  itself (set it to Send again to retry). Anything else is tried again every run, in order, and C22 shows the error; one
  that fails 5 runs in a row is given up on: the bot says so in its thread (or in the Mirror space, for one from S-F
  Burson), and the Relay tab has it. A Zapier alert from S-F Burson is tried for an hour instead (above).
- **The Relay tab** (made the first time the relay runs) logs every item: when, which way, what, who, the text, sent or
  why not, and the message on each side. It's also how the bot knows which thread on one side is which on the other,
  and that nothing is relayed twice. C22 says when it last relayed.
- **The Relay names tab**: Chat doesn't give the bot people's names (it signs in as a person, not as an app). Everyone
  the relay or test copy sees gets a row there (their Chat id, where they were seen, an example), with `org` left blank for people seen in S-F Burson. Type `Burson` or `Google` in `org` once, and their name in the `name`
  column: that's how they show on what's copied from then on (`Name (Burson)`, `Name (Google)`, or the name alone while
  `org` is blank). It only sets how people show: everyone's messages come over either way, and nothing waits on it.
  Until a name is typed in `name`, people from S-F Burson show as `Someone` (`Someone (Burson)` once marked) and
  analysts as `Google team`.
- **Before turning it ON:** the relay only runs as the account in "Runs as" (B8). What that account's person types in
  the Mirror space themselves (messages, replies, emojis) is relayed like any analyst's; the bot's own posts and emojis
  never are (it knows them by its message ids, its 🤖 and its record of what it posted), nor an alert pasted there for
  the bot to review. While it can't tell them apart (Chat refusing the bot's message ids, or the emoji pass starting
  over), nothing from that account goes. It needs the Mirror space (B9) and the S-F Burson space (B25): without either
  it doesn't relay, and C22 says so.
  Edits, deletions and removed emojis aren't relayed. The code is in `Relay.gs` and `TestCopy.gs`.

#### Row 23: Never wait on Burson

- **OFF** (the default): as the rest of this README describes. A wrong alert gets ⬇️ and a reply in its thread that
  lists each fix and asks Burson to update and resend it. It waits for Burson's resend: no ❌, T&S form or decision
  until then (an alert that needs a Social Alert still gets it). The resend is then decided. Something only Burson can
  supply (a missing link, a long video's timestamp) is asked for in the thread.
- **ON**: nothing waits on Burson. The bot fixes the alert itself and processes it right away, as it would a correct
  alert: its action emojis, the Social Alert, ❌ or the T&S form. A reply in the alert's thread lists what was wrong and
  what the bot changed, and says the alert was processed, so there's no need to resend it. There's no ⬇️ (no updated
  post is waited for).
  - A long video with no timestamp gets the `[MM:SS]` where Google comes up (Gemini watched it), as the bot's own
    correction: a `[Timestamp]:` line on the corrected alert, a line in the Social Alert email and in the T&S form.
  - Something only Burson knows (for example the link) doesn't hold the alert up: it's processed without it, the thread
    says it was missing, and analysts see `🤖 QA: Link missing (processed without waiting for Burson; Burson was told)`.
  - Burson's resend anyway is the same alert: ⬇️ on the original, and it isn't processed twice (no second ❌, Social
    Alert or T&S form). A resend whose priority or engagement went up is forwarded as a new alert and decided again.
    An alert asked of Burson while the switch was OFF is processed on its resend.
  - Today (B7) counts the alerts corrected (Burson told); the auto-correct space's note lists what was missing as
    "Processed without waiting for Burson"; the Results tab says the bot fixed the mistakes itself and went on without
    the missing details; answers to Burson say what the bot changed. Auto-send (row 11) still leaves an alert missing
    something only Burson knows a draft for a person, saying why.
- **Turning it OFF** while an alert decided with it ON could still be resent (48 hours): Burson was told not to resend,
  but if they do, the resend is handled as with the switch OFF, so it can be decided again.
- **In S-F Burson**, what it tells Burson (with the switch OFF or ON) is posted only through Post in S-F Burson (row
  24), like everything else.

#### Row 24: Post in S-F Burson

- **OFF** (the default): nothing is posted, replied or reacted in S-F Burson (the real Burson space, B25) by any
  part of the bot: the fix requests, answers and emojis of the main flow, the analysts' emojis copied over, or the
  relay. Each one is held back: nothing is written or queued, the alert carries on as if it was done (nothing fails
  or is retried), and the run log counts what was held back, for example `S-F Burson: withheld this run (Post in S-F
  Burson is OFF, so nothing was posted or queued): 1 reply, 5 reactions`. Turning it ON later never sends what was
  held back. Analysts get everything as usual: the copies, the emails (the stand-in while testing), the logs.
- **ON**: still nothing goes by itself. Each post, reply and reaction waits as one row on the bot's **Burson outbox**
  tab: Queued (ET) · Kind (post, reply or reaction) · Where (a link to the thread or message) · Text or emoji · From
  (`bot`, or `relay: ` and the analyst's name) · Status · Note. Its Status is **Pending**. Set it to **Send** to post
  it, or **Skip** to never post it. The next run (within a minute) writes it once, from the bot's account, as its Text
  cell says then (so you can edit it first), top to bottom, and sets it to:
  - **Sent**, with the time and a link;
  - **Blocked**, with the reason, when the text names anything internal (the analyst, Mirror or auto-correct space, the
    relay, Zapier, the stand-in, write-backs, automation, "the bot", the Control, Relay, Results or outbox tab, …) or a
    reaction isn't a single emoji Burson may see (👎 never is). Edit the text and set Send again;
  - **Failed**, with Chat's error. It's never tried again by itself: set Send again to retry.

  A Sent row set to Send again never goes twice, and the same post or emoji is never queued twice.
- **Checked right before each write:** Post in S-F Burson and Bot (B2) are read again before every row is written.
  Turned OFF, sending stops at once, and rows still set to Send go back to Pending with a note. A run from another
  account (for example `poll()` run from the editor, not the account in "Runs as") sends nothing: the rows wait, and
  C24 says why. A dry run sends nothing either (the run log says so).
- **The tab is the bot's own:** it's made the first time something is queued, protected with a warning, with a
  Pending / Send / Skip dropdown in each Status cell. A tab named "Burson outbox" that the bot didn't make is never read
  or written: nothing is queued, and C24 says to rename it. Each run sends at most 20 rows (or 20 seconds' worth); the
  bot reads the latest 2,000 rows.
- **C24** says OFF, or ON with how many rows are waiting.
- **Only to the S-F Burson space in B25:** each row remembers the S-F Burson space it was queued for. While B25 is blank
  or can't be found, nothing is sent or queued: rows set to Send wait, and C24 says why. After B25 changes, a row queued
  for the old space is Blocked ("queued for a different S-F Burson space") and never sent to the new one.
- **Never from the test spaces:** the Mirror and auto-correct spaces never write in S-F Burson or queue anything for
  it, even with the switch ON. As a backstop, `Chat.gs` refuses any write to S-F Burson (this run's B25) except an
  outbox row being sent. The code is in `Outbox.gs`.

#### Rows 27 & 28 (with Row 21): The Follow-up tab, Draft follow-ups, and Draft answers to questions

When **Track post-alert outcomes (row 21)** is `ON`, the bot maintains the **Follow-up** tab (right after `Results`),
tracking every Social Alert the bot sent in the last 14 days from both the Mirror/main space and the Auto-correct test
space (`FollowUp.gs`):

- **The tab is the bot's own:** its title is in A1. A tab named "Follow-up" that the bot didn't make is never read or
  written: C21 says it's in the way, and once it's renamed the bot makes its own.
- **Editable follow-up timeframes (`B5:B7` on the Follow-up tab)**:
  - `B5` (**P0**): defaults to `1 hour`
  - `B6` (**P1**): defaults to `4 hours`
  - `B7` (**P2**): defaults to `1 business day` (same ET time on the next weekday)
  - You can edit `B5:B7` to any timeframe between 1 minute and 7 days (e.g., `30 minutes`, `2 hours`, `2 days`, `2 business days`). Your edits are never overwritten by the bot, and `C5:C7` shows how the bot reads each cell.
- **Per-team attribution & testing (`[Team]`)**:
  - Each alert lists every team from its recipient plan (`Search alert POCs`, `GCPA`, `People Comms`, `Regional Leads`, etc.) and whether/when each team replied (`GCPA ✓ 22 min · Search alert POCs —`).
  - While testing, Social Alerts only go to the addresses in `Control!B30`, so you can simulate a team reply by replying on the email thread starting with the team name in brackets (e.g., `[GCPA] On it, drafting a statement` or `[Search] Resolved, we rolled back the change`).
- **Status & concrete Next step**:
  - Every alert gets a status (`Waiting`, `Overdue`, `Question waiting`, `Answered`, `Resolved`, `No reply in 7 days`, or `Not checked yet`) using honest wording (*"no reply seen on the thread"*, never *"nothing done"*), plus a rule-based **Next step** (e.g., following up with silent teams, escalating an overdue P0/surged/press-covered alert to the on-shift lead, answering a team's question, asking for an update after 24 hours, or checking an unconfirmed T&S submission after 2 hours).
- **Row 27: Draft follow-ups (`ON` / `OFF`, starts `OFF`)**:
  - With row 21 `ON`, when a Social Alert passes its `B5:B7` timeframe with no team reply (`Overdue`), the bot creates a Gmail draft on the thread asking the silent teams for a status, plus one second draft a day later while the alert is still unresolved.
  - Drafts wait in Gmail Drafts for an IM and are **never sent by the bot**. While testing, drafts are addressed only to `Control!B30`.
- **Row 28: Draft answers to questions (`ON` / `OFF`, starts `OFF`)**:
  - With row 21 `ON`, when a team asks a question on a Social Alert thread and nobody on our side has replied since, Gemini reads the full question and checks whether the alert, the bot's review, the `Resources` documents, and the `Guidance` tab clearly answer it.
  - When Gemini can answer with $\ge 90\%$ confidence, it creates a Gmail reply draft on the thread (never sent; addressed only to `Control!B30` while testing). When it cannot answer from the bot's context, no draft is made and the `Next step` column says `needs an IM: ...`.

#### Row 32: Work directly in B25 (Google-only), and alerts in other formats

To try the bot on another space and its alerts (for example a campaign space where a monitoring tool posts
`🚨 X Alert: 2026 Midterm Elections / Civics - Negative 🚨` alerts), paste that space in **B25** and set row 32 `ON`
(`Main.gs` `directB25For_`, `directCfg_`). This works that space *instead of* the Burson side; to keep the Mirror
space working S-F Burson's alerts at the same time, use **Other alerts space (B33)** instead (above).

- **Only in a Google-only B25.** Every run the bot checks who can join B25. When only Google people can, the bot works
  right in B25 as it does in the Mirror space: it reads every message, reviews every alert, and posts its notes,
  replies and emojis there directly (no Burson outbox). When people outside Google can join it (the real S-F Burson),
  row 32 does nothing, C32 says so, and everything in "S-F Burson space (B25)" holds. B25 blank or not found: nothing
  runs, and C32 says it's waiting (fail closed).
- **Always 🧪 Testing.** A Google-only B25 is never LIVE (`runMode_`): every email goes only to the testers in B30
  (blank: the stand-in), the T&S form is the test copy, and nothing is queued for S-F Burson. C29 and Status say so.
- **What waits meanwhile.** B3, B4, B9, B10, B26 and the Relay (row 22) aren't used; Direct BigQuery alerts (row 15)
  and the Early wave check (row 19) don't post. Set row 32 `OFF` (or point B25 back at S-F Burson) and all of it
  resumes as before.
- **Burson's alerts keep their review.** An alert in Burson's format (the SOCIAL ALERT layout, the `[Name]` /
  `[Exposure Tag]` lines, or posted by Zapier, Burson or Sonar) gets exactly the SLRR review it gets everywhere.
- **Questions** in an alert's thread are answered there, from the whole knowledge base and the alert's triage. An
  alert someone pastes at the top level is reviewed as an alert, never answered as a question.

**Alerts in other formats** (in the Other alerts space, B33; in B25 with row 32 ON; or in the Mirror space) get their
own triage (`OtherAlerts.gs`). An
alert here is a top-level post with a header (like `X Alert: …`) and labelled lines (Author, Followers, Engagement,
Sentiment, Text, a link) that isn't in Burson's format. One Gemini call reads the post itself (text, media, public
data), the listening feeds (BigQuery), earlier alerts, the Guidance tab, the Resources documents and the web. Then:

1. **SLRR first.** When Gemini is 80%+ sure it's a post SLRR covers (an exposure tag, product and Sensitive Topics),
   the SLRR rules decide, exactly as for Burson's alerts: SLRR's collection threshold (100+ engagements; P0 tags and
   KOF authors have no minimum), the escalation rules and the AI veto. Escalated: a Social Alert with SLRR's routing,
   the 🧑‍💻 protocol and the repeat rules. When the rules would escalate it but the bot can't tell the engagement
   count (a range like `Very Low (0-199)`), or Gemini is only 50-79% sure of the SLRR view: 👍 for a person to check.
2. **Then the stream's own call.** Gemini says what the post is, why it matters to the alert's topic, its risks and
   severity, and calls escalate, flag or no action. Escalate at 90%+ confidence: a Social Alert (its Why says
   `Stream triage: …`). A less sure escalate, or a flag: 👍 (worth a person's look). No action: ❌, or the T&S form
   details when T&S should see it.
3. **Never twice, never a guess.** A post already escalated gets no second email unless the stakes rose. If Gemini
   fails, the alert gets 👍 (needs a person), never ❌ or a Social Alert. KOF status comes only from the alert or the
   listening feeds, never from Gemini.

Each one gets a note in its thread: `🤖 *Triage: ❌ No action* · low`, then *What it is*, *For 2026 Midterm Elections /
Civics*, *Risks*, *Why*, *SLRR view* (the tag, and what the SLRR rules say about it), and the teams, T&S or what to
watch for. The Alert log row says `ingested: Other alert`: the Results tab leaves it out (Burson didn't post it), and
Write back to SLRR BigQuery (row 16) never writes it.

**To steer the triage**, add Guidance rows whose **Applies to** names the stream (for example `2026 Midterm
Elections`), or a criteria document on the Resources tab: Gemini is told they decide the stream's call. The SLRR
rules still decide the posts SLRR covers.

## One-time setup (whoever installs it)

1. The Apps Script project (`.clasp.json`) must use the Cloud project `brand-social-central-data` (**Project
   Settings → Google Cloud Platform project**). That project needs the **Google Chat API** and the **Vertex AI API**
   enabled. Both are already used there.
2. Push the code:
   ```sh
   cd apps-script-chat-bot && clasp push
   ```
   This replaces the old prototype in that Apps Script project. To bring the prototype back, see
   [`archive/apps-script-prototype/`](../archive/apps-script-prototype/README.md).
3. In the Apps Script editor, run **`setup()`** and approve the permissions. Until you do, the prototype's old
   triggers fail every minute. `setup()`:
   - creates the sheet, with the Control tab pre-filled for testing (SLRR Test Feed (Burson Sim) → SLRR Triaged
     Alerts) and S-F Burson space (B25) blank: paste S-F Burson's link there (see "S-F Burson space (B25)");
   - removes the prototype's triggers and everything it left in the script properties, then starts the every-minute
     check;
   - posts a one-line hello, with the sheet's link, in the analyst space;
   - logs the sheet's link, the two spaces, and whether Gemini works.

   It's safe to run again: nothing is posted twice, and the Control tab keeps what people set.

Other functions in `Main.gs`, for whoever installs it:
- `status()` prints the Control tab plus details of the last run, and what the knowledge base could read.
- `listMySpaces()` prints every space the account is in, with links to paste into the Control tab.
- `tryAlert()` shows what the bot would say about `TRY_ALERT_TEXT`, without posting anything, and which documents the
  review got.
- `refreshKnowledge()` (`Knowledge.gs`) reads every document on the Resources tab now and logs what it found.

For production, run `setup()` from a dedicated account rather than a personal one. The bot posts as that account, and
treats that account's own replies in alert threads like anyone else's.

## Testing in the test feed

Paste real Burson alerts into **SLRR Test Feed (Burson Sim)**. Within a minute you should see the following:

1. **A correct alert**: 👍 on it, and the same text in SLRR Triaged Alerts.
2. **An alert with mistakes** (try `TRY_ALERT_TEXT` from `Main.gs`): 👍, a numbered fix list in its thread, and the
   corrected alert plus a `🤖 QA corrected:` line in SLRR Triaged Alerts.
3. **A question** in that thread ("why is the product wrong?"): an answer in the thread.
4. **The fixed alert pasted again**: 👍 on it, ⬇️ on the original, and nothing new in SLRR Triaged Alerts.
5. **✍️ on the forwarded copy** in SLRR Triaged Alerts: ✍️ appears on the alert in the test feed.

Pasting from your own account works: the bot tells its own posts apart by message id and the 🤖 prefix, not by
sender.

**Emails while testing.** While in Testing mode, enter your email address in `Control!B30` (`Testing: send to`) so every Social Alert goes out
from the bot only to `Control!B30` (nothing is sent while `B30` is blank). The Gmail client itself refuses any email addressed to anyone else (To, Cc or Bcc;
sends, drafts and draft updates), so no code path can reach a distro, and the Workspace form is never submitted.
The switches keep to this: an auto-sent alert, the urgent T&S email, a watch update or anything else a switch sends goes
only to `Control!B30`, and an auto-submitted T&S form is the test copy.

## What the bot is doing: the Results tab

The **Results** tab of the bot's sheet (it used to be the Speed tab, and an existing Speed tab is renamed) shows, in
plain numbers, what the bot did with the alerts Burson posted in the last 7 days, next to what the IMs did with the
same alerts. One alert is one Burson post: the Mirror space's and the auto-correct space's reviews of it are counted
together (the bot sent a Social Alert when either space did; its time is the first email), and a resend counts with the
alert it resends. It's matched with the IMs' Social Alert on the post's link, never the subject line. Rows from old
test feeds are left out.

From top to bottom:

- **What's happening**: 4 to 6 plain sentences Gemini writes from the numbers below. Every number in them must be one
  of the tab's numbers; otherwise (or when Gemini is down) the tab shows a summary computed from the same numbers, and
  says so.
- **Headline numbers**, last 24 hours and last 7 days: alerts, alerts with mistakes, the mistakes the bot fixed, what
  only Burson could add (e.g. a missing link), Social Alerts sent by the bot and by the IMs, how often they made the
  same call, the alerts only one of them sent, minutes from Burson's post to each side's email, who sent first and by
  how much, and the T&S forms the bot prepared.
- **What Burson got wrong**, by field (Product, Exposure Tag, Summary rewritten, Link missing, …), with an example.
- **The two test spaces** side by side: the Mirror space (the bot asks Burson to fix) and the auto-correct space (the
  bot fixes it itself), and any alert where they made a different Social Alert call.
- **By day**, the last 7 days.
- **Where the bot and the IMs differed**: the latest alerts only the IMs sent, and only the bot sent, with the bot's
  reason.
- **Every alert**, one row per Burson post.

Minutes count from when Burson posted the alert in the live space; the speed numbers use only the alerts both the bot
and the IMs sent a Social Alert for. The IMs' time is their email from brand-social-sends@ for the same post, in this
mailbox, else their SLRR Assistant draft (`slrr_feedback.alert_sends`). The IMs sent a Social Alert when there's a draft,
an email, or the post is in the SLRR alert log; no sign of one a day later means they didn't. When the bot sent the
Social Alert itself (Auto-send, row 11) their call is "Bot sent it".

The tab updates right after a run that handled an alert or sent an email (at most once a minute), and every 10 minutes
otherwise. Run `refreshResults()` to rebuild it now (`refreshSpeed()` still works). Settings: `speed_tab`,
`speed_days`, `speed_im_table`, `speed_log_table`, `speed_im_sender`, `speed_gmail`.

## T&S pre-filled link

When T&S should see an alert, the note under it has a link that opens the T&S Intake Form with the answers already in.
The analyst checks them and clicks Submit; the bot never submits it (unless the Auto-submit T&S form switch is ON: see
above).

| Question on the form | What the bot puts in |
|---|---|
| [Title_Prefix] WD Intake Request | Marketing ("so we get credit") |
| Google Product: | The alert's product as one of the form's choices: AI Overviews is Search (AI Overviews), Gmail is Workspace, Maps/Geo is Geo (Maps), and so on; Other when the form has no choice for it |
| Topic Impacted: | From the Sensitive Topics and exposure tag, first match: Child Safety; perceived bias; violence, hate or crime; scams, privacy or malware; politics (Geopolitical Dynamics for wars, countries and borders, else Major Civic Events); wrong, dangerous or offensive results; else Miscellaneous |
| Link / URL(s) in question: | The post's link |
| What's the Issue? | The summary, the engagements and network, and the video timestamp if the summary lacks it |
| Additional screenshots/notes etc: | The screenshot's link (Burson's, except of a sign-in prompt; else an image or frame from the post) |

The link stays under 2,000 characters (What's the Issue is shortened first), so the Chat note is never cut. The question
ids are in `TnsForm.gs` (`TNS_FORM_FIELDS_`), read off the form on Oct 18, 2026. If T&S changes the form, put the new
ids in the script property `TNS_FORM_ENTRIES` as JSON (for example `{"url": "entry.123"}`). To read them without being
an editor of the form, open it, open the browser console (Cmd+Option+J) and run
`copy(JSON.stringify(FB_PUBLIC_LOAD_DATA_[1][1].map(q => [q[1], q[4] && q[4][0] && q[4][0][0], ((q[4] && q[4][0] && q[4][0][1]) || []).map(o => o[0])])))`.
(The old link's `entry.290320498` for Marketing is no longer a question on the form.)

**While testing** (a stand-in set, as now) the link opens a **test copy** of the form instead, never the real one:

- The bot makes it in the tester's Drive the first time it needs it: "T&S Intake Form (test copy, only you)", with the
  same questions and choices. It isn't shared with anyone. To make it now and get its links, run `setupTnsTestForm()`.
- Submitting it sends nothing to Trust & Safety. The tester gets a stand-in for T&S's confirmation email,
  "Issue [#TEST-…]: WD Intake Request (test copy)", and the bot marks ✍️ just as it would for the real one.
- If the copy can't be made, the note says so and has no link (the bot tries again an hour later).
- Going live (no stand-in), the same notes link the real form. The test copy stays in your Drive; delete it whenever.

## Going live

Paste the link of **[S-F] Burson Automated Alerts V3** into **S-F Burson space** (B25), if it isn't there already, and
into **Burson space** (B3). If the analysts move to a new space, paste its link into **Analyst space** (B4). The bot
then reviews S-F Burson's alerts, but it posts nothing there: Post in S-F Burson (row 24) decides, and even ON, only
the Burson outbox rows a person sets to Send go. With the link in B3 but not in B25, the bot isn't live: it only reads
there, and C3 and Status say why.

- The bot starts with the last 15 minutes of the new space, not its whole history.
- Test and live alerts are tracked separately, so the switch never mixes them.
- To go back to testing, paste the test feed's link (or its name) back into B3. Leave B25 as it is: the Mirror,
  Auto-correct and Relay read it.
- The switches (rows 11-24) don't change when the space does. While `escalation.stand_in` is set, everything they send
  still goes only to the stand-in, even in the live space; see "The switches" for what each does live.

## What Gemini can change

The bot's own rules fix renamed tags and topics, removed products, network vs link, priority vs tag, engagement vs
count, KOF lists and "already reported". Gemini also reads each alert and checks six fields: **exposure tag, product,
Sensitive Topics, KOF, issue name and summary wording**.

- At **90% confidence or more**, the bot fixes the field for analysts and asks Burson to change it.
- Below 90%, analysts get a `🤖 QA check:` line to double-check, and nothing goes to Burson.

To change this, edit the `burson_qa:` section of `config/default_config.yaml`:
- `llm_min_confidence: 0.9` is the confidence needed.
- `llm_fix_severities: [blocking, warning]` covers all six fields. Set it to `[blocking]` to limit Gemini to exposure
  tag, product and Sensitive Topics. KOF, issue name and summary then become double-check notes.

KOF comes from Burson's own lists: `[KOF]: Viral KOFs (KOFs)` or `[KOF]: CAM Tech/AI (INFs)` means the author is a KOF,
whatever the engagement, and the Engagement line keeps the level for the count (that's how Burson writes them and how
the SLRR log records them). Gemini can't turn a listed author into "No".

**Web search.** When reviewing an alert or answering an analyst, Gemini can search the web (Vertex AI's Web Grounding
for Enterprise) for what Burson's write-up doesn't say: news coverage, whether a claim or incident is real, who the
author is, and whether Google has responded. Answers to Burson never search. `web_grounding: enterprise | google | off`
switches it; if Vertex AI refuses the tool, the bot retries without it and leaves it off for 6 hours. The searches and
sources Gemini used are in the run log.

**Earlier alerts.** Gemini also sees earlier alerts: the bot's own from the last 14 days and the SLRR alert log's, for
the same author (90 days), for the same post, and for any post this one replies under or quotes (whoever posted it),
with the teams the Incident Manager sent each one to. It uses them to tell whether a post is a follow-up on an alert
that already went out (`follow_ups`, `follow_up_min_confidence`), and to route the same story the way the IM did. A
reply under an alerted post is a follow-up for certain (the thread comes from the post's public data, not a guess);
whether it adds anything new is Gemini's call.

**The post itself.** Before the review the bot looks up the post (`post_lookup`): on X (the data X serves for
embedded posts) and Bluesky (its public API), its own words, the posts above it in its thread, the post it quotes, and
its video and photos; on TikTok, the caption and the video's cover image (TikTok shows the video only to people signed
in); on Instagram, the caption and the first image (a reel's cover), from the public page Instagram serves for embedded
posts, when Instagram shows it to Google's servers (it can refuse); YouTube videos Gemini watches directly. Reddit and
Facebook show posts only to people signed in (Burson can't open them either: its alerts say "screenshots are not
available" for them), so there, and when Instagram refuses, the review checks Burson's write-up against **the post as
the listening feeds captured it**, the same text Burson writes from:
- Pendulum's pieces of the post's text: the caption, text read off its images and video frames, a transcript, a machine
  description of the image, plus Pendulum's own summary and issue name (`bsip-s-bsip-gg-26-2cf3.google_bg.sonar_raw`);
- Brandwatch's snippet of the post, from the DSD story selection feed (`DSD.DSD-story-selection`) and Brandwatch raw
  mentions (`raw_data.brandwatch_raw_mentions_base`).

Gemini gets this for any post the feeds have, on any network; where the bot has the post's own data, that wins. It's
all read from BigQuery: the bot never calls the Brandwatch API on alert reviews, so none of it counts against Brandwatch's mention
allowance. The run log notes what the review had, for example `feed text: Pendulum: description, ocr · Brandwatch`.

**Video and audio.** Gemini watches and listens to the whole video, start to finish (every second, sampled at one
frame a second with the full soundtrack), and reports its length, what happens across it, the key words spoken, the
on-screen text, and where Google comes up. Vertex AI reads a video from its link only up to 15 MB, so the bot picks the
largest file of the post's video under that; a longer video is copied to Cloud Storage (`media_bucket`, under
`burson-qa-bot/staging/`, up to 50 MB: about 45 minutes of an X video, Gemini's own limit with audio) for the review and
deleted right after (a 38-minute X video took Gemini 83 seconds). The copy goes from the download to Cloud Storage
without ever being read into the script (reading a 17-50 MB video into it ran Apps Script out of memory, Oct 24-26), and
a Bluesky video, whose size its post record gives, is never downloaded just to learn its size. If Gemini can't open a
video (too long, private, blocked), it looks at Burson's screenshot or a frame of the video instead, and then the alert
text alone. Analysts see a
`🤖 QA: Gemini watched and listened to the post's video (3:13 long): …` line under the alert.

**The run's time.** A review with a video or audio clip is started only with 90 seconds of the run left: a clip can
make it run long, and a call can't be stopped once started. Pictures (photos, a frame, a cover, Burson's screenshot)
go whatever time is left: a review with them takes no longer than one without (Oct 21-24: median 37 s and p95 80 s
with photos, 46 s and 133 s from the text alone). When a run is too short for an alert's video, the alert waits for the
next run, which reviews it first, with its video (about one run later: 4-5 minutes while alerts are coming in); the run
log says `held … for the next run`. It doesn't wait when that wouldn't help or could pile up: never the first message
a run handles (every run reviews at least one), not in a pass that didn't have the time for a video review when it
started (the auto-correct space, while the main flow is busy), not twice, and not once it's been in the Burson space 10
minutes (a backlog isn't slowed down). Then Gemini gets a still of the post instead, and the alert says
`🤖 QA: The bot was short of time, so Gemini didn't review the post's video (…) and had only a still of the post. Check
the post yourself`. A post whose media Gemini couldn't review says so too (`🤖 QA: Gemini couldn't review …`). Until Oct
26, a review that started with under 90 seconds left the post's media out altogether, photos included, and nobody was
told: 89 reviews in Oct 21-24.

**KOF alerts.** Gemini may ❌ an alert escalated only because the author is a KOF (`kof_no_alert`), the way IMs do,
when it's at least 90% sure and one of its no-alert checks holds that the bot can back up: a duplicate of an alert that
went out, a comment on (or reply under) an alerted post, the same story already alerted another way (the bot's own
alerts or the SLRR alert log, tied to this post by the thread, the same post, Burson's wording, or Gemini 80%+ sure),
or the leads' current guidance (the Guidance tab or their emails). It also checks whether the alert is a mistake (not
about Google, the claim isn't in the post, wrong author, not negative) or has nothing actionable, but that reading
alone doesn't ❌ a KOF alert unless `kof_no_alert_judgment` is on: on 24 KOF alerts from May–June it called 15 a
mistake or not actionable (90%+ sure) and the IMs had sent 8 of those 15. When a KOF alert goes out anyway, Gemini's
reading goes to the run log; P0 and Sensitive Topic alerts are always escalated.

**The leads' guidance.** The **Guidance tab** of the bot's sheet holds the SLRR leads' current instructions (one per
row: **Guidance**, **Applies to**, **Until**, **Added by**). A row whose Until date has passed is ignored. Gemini also
reads the leads' (Kelsey's and Jon's) emails from the last 7 days about alerts or escalation in the mailbox the bot runs
as (`guidance_from_email`, `guidance_email_days`).

**Switches that change the review.** KB & Guidance can start alerts (row 13), Learn from IM calls (row 17) and Check outage & comms docs (row 20) change what Gemini is asked and what the bot does with its answer; each is OFF unless turned ON. See "The switches" above.

**Screenshots.** The Social Alert email shows a picture of the post under the summary, linked to the post: Burson's
screenshot of the post when the alert has one (X, Bluesky and others), else the post's own photo, a frame of its video,
or the video's cover image. If it can't be fetched, the email goes without it. Burson's screenshot of Instagram,
Facebook, Threads, LinkedIn, TikTok, Reddit or YouTube is never used, in the email, in Gemini's review or in the T&S
form: those sites show anyone not signed in (Burson's screenshot service too) a welcome or sign-in prompt over the post.
The email shows the post's own image instead when the bot has it (on Instagram, the first image or a reel's cover), else
no picture. The run log says when Burson's screenshot was skipped.

**Team emojis.** ⚖️ Civics follows a Sensitive Topic when the topic (or a KOF author) is why the alert is urgent: under
2,000 engagements, IMs add Civics to ~90% of those. For an alert escalated on 2,000+ engagements alone, they add it to
only ~30% (Politics, Privacy, Child Safety), so there it's Gemini's call (a real political, legal or government angle);
Medical and Violence topics still get it at any engagement. 💬 gUP also takes privacy posts about people's own Google
accounts and settings, even when the product is Brand.

## Settings

Behavior settings live in the `burson_qa:` section of `config/default_config.yaml`: reactions, copying analyst
emojis, dry run (nothing posted in the Burson space), the Gemini settings above, and the 48-hour window for matching
a resend. The taxonomy and emoji legend are in the same file.

The switches on the Control tab need no YAML and no rebuild; their thresholds are constants in the `.gs` files (see
"The switches"). After any change to the YAML, regenerate the bot's data file, then push:

```sh
.venv/bin/python -m scripts.build_apps_script && (cd apps-script-chat-bot && clasp push)
```

## Files

| File | What it is |
|---|---|
| `Main.gs` | `setup()`, `status()`, `listMySpaces()`, `tryAlert()`, and `poll()`, the every-minute run (one at a time: a run that finds another still going skips) |
| `Control.gs` | The Control tab (with its switches, rows 11-24, 27-29, 32, 34, 36 and 37, and the S-F Burson space, row 25), and the Resources and Guidance tabs |
| `Knowledge.gs` | The knowledge base: reads the Resources tab's documents, keeps them current in the bot's own hidden "Knowledge cache (bot)" tab, and picks the parts that bear on each alert or question |
| `Config.gs` | Fixed settings: the Cloud project and what a new Control tab starts with; and this run's S-F Burson space, as the Control tab's B25 names it (no S-F Burson id is in the code) |
| `Bot.gs` | One pass over the Burson space: alerts, resends, replies, copying analyst emojis |
| `Mirror.gs` | The Mirror space (B9): live Zapier posts copied, unchanged, into a training space |
| `Relay.gs` | Relay with S-F Burson (row 22): S-F Burson into the Mirror space in its own order (Zapier's alerts, everyone's replies, messages and emojis), and the analysts' onto the Burson outbox; the Relay and Relay names tabs |
| `Outbox.gs` | Post in S-F Burson (row 24): everything bound for S-F Burson held back (OFF) or queued on the Burson outbox tab (ON), and only the rows a person sets to Send posted, after the wider check |
| `AutoCorrect.gs` | The auto-correct space (B10): live alerts posted there already corrected, read-only on the live space |
| `OtherSpace.gs` | The Other alerts space (B33): a Google-only space with other alerts, worked directly every minute beside the Mirror space, always Testing, never connected to S-F Burson |
| `WatchAlerts.gs` | Watch alerts (row 35, OFF to start): the Proactive watch's flags at a watch's bar posted as the bot's own "🔭 Watch alert" text messages in the Other alerts space (B33), the Mirror space (B9) or the Auto-correct space (B10), a few a run, each once; the space's flow works them like any alert (❌ for a repeat, else a Social Alert). Never in S-F Burson, the Burson test copy or a space people outside Google can join |
| `TempCheck.gs` | Temp checks (row 36, OFF to start): "temp check <Brandwatch query>" in a thread of the Mirror space or B33, queued by its flow (never relayed to S-F Burson) and worked after the run's alerts: the query found by name, link or id in [SLRR] Private, counts by hour, sentiment, sources and mention types from Brandwatch's totals (GETs only), at most 35 posts (reposts excluded; X's words from X's embed data), Gemini's summary, drivers and themes, and the team's write-up in PT posted in the request's thread; "refresh" for the update; Brandwatch busy: waits up to 30 minutes |
| `ProactiveWatch.gs` | Proactive watch (row 34): a watch over every source's new rows, read-only in BigQuery (two jobs, us-central1 and US: Sonar, Tubular, Brandwatch raw mentions, Sprinklr owned posts and comments, the DSD story selection feed, the Other alerts space's alerts from the Alert log, and the Brandwatch query "2026 Election Alerts" from Brandwatch's API, its X posts' text from X's embed data), Gemini's AI.IF, AI.SCORE and AI.CLASSIFY run inside BigQuery for each watch on the Watches tab, what they'd flag on the Watch detections tab, its scorecard against Burson's alerts, and the Watch sources tab; posts nothing itself (Watch alerts, row 35, post its flags only where B35 says) |
| `Alert.gs` | Parses Burson's alerts and rebuilds the corrected copy in Burson's exact format |
| `OtherAlerts.gs` | Alerts in other formats (in the Other alerts space, B33; in B25 with row 32 ON; or the Mirror space): spots them, triages each with Gemini (the SLRR rules first, then the stream's own call), and posts the triage note, the Social Alert, 👍 or ❌ |
| `Review.gs` | The rule checks plus Gemini's judgment |
| `Escalate.gs` | Whether an alert needs a Social Alert and who gets it (the protocols, the distros) |
| `Drafts.gs`, `Email.gs`, `Mail.gs` | The Social Alert email (draft, stand-in send or auto-send), its notes and emojis, T&S notes and auto-submits; the email itself; the Gmail client and its stand-in guard |
| `BigQuery.gs` | The listening feeds and the SLRR log in BigQuery: each alert's enrichment, and the switches that use BigQuery (find missing links, direct alerts, write-back, early waves) |
| `Post.gs` | The post itself: X, Bluesky, TikTok, Instagram and YouTube public data, and the screenshot for the email |
| `Media.gs` | The post's video, audio and images for Gemini (the Cloud Storage copy of a big video) |
| `Voice.gs` | Everything the bot writes, and the guard |
| `Chat.gs`, `Gemini.gs` | The Google Chat API and Gemini on Vertex AI |
| `Sheets.gs`, `Store.gs` | The sheet's log tabs ("Alert log", "Message log") and what the bot remembers. No cell the bot writes goes over 49,000 characters (Sheets refuses 50,000); a JSON column is shortened so it still reads back |
| `Speed.gs` | The Results tab: what the bot did with Burson's alerts next to what the IMs did, with Gemini's summary of the numbers; the Learned precedents tab (row 17) |
| `TnsForm.gs` | The pre-filled T&S Intake Form link (the real form live; while testing, a test copy in the tester's Drive) |
| `Watch.gs` | Watch sent alerts (24h), a Control tab switch: re-checks sent alerts' posts and replies on the email thread |
| `Outcomes.gs` | Track post-alert outcomes, a Control tab switch: reads replies to sent alerts and logs what came of them |
| `Generated.gs` | Taxonomy, emoji legend and settings, **generated** from `config/default_config.yaml`. Don't edit it |
| `test/` | Node tests that run the whole bot against fake Chat, Gemini and Sheets |

The log tabs have one row per alert (status, what was asked, analyst 👎 feedback) and one row per message. They're
protected with a warning. Don't sort them; use a filter view. The switches add columns to the Alert log as they're needed
(`tns_submitted`, `bq_written`, `outcome`, `ingested`); rows from before keep them blank. Learn from IM calls (row 17)
adds the bot's own **Learned precedents** tab, where only the Active column is yours to edit.

## Known limits (V1)

- **Edited alerts aren't seen.** Burson resends instead, as the bot asks them to.
- **How a resend is matched.** A resend is matched to its fix request by the post link within 48 hours. If the
  original had no link, it's matched by a near-identical issue name from the same author.
- **"Already reported in the last 14 days"** only knows the alerts the bot itself has seen in that space.
- **Analyst emojis** are copied for forwards up to 3 days old.
- **Failures** are retried. An alert that fails 3 times is forwarded to analysts as received, never dropped. A try
  that Apps Script cuts short (out of memory, its time limit, an internal error: nothing the bot can catch) counts as a
  failed try too, as the bot notes which message it's on before each one. When it was cut short in the alert's review,
  the next review gets less of the post: a still of it (Burson's screenshot or a frame of the video), then the alert
  text alone, and the forwarded alert says `🤖 QA: The post's own media wasn't reviewed: …`. The minute after a run is
  cut short, the next run takes over (it no longer waits 25 minutes), and five such runs in a row tell analysts, as
  five errors in a row do.
- **The switches are untried live.** Their BigQuery tables' columns, the live T&S form's editor id (`TNS_LIVE_FORM_ID`),
  `brand-social-sends@` as the bot's send-as address (auto-send and watch replies, live), and how X, Bluesky and YouTube
  answer for a deleted post were all checked against the code only. Direct BigQuery alerts work only in a test feed or
  the Mirror space.

## Tests

```sh
node apps-script-chat-bot/test/run_tests.js     # the bot, end to end against fake Google services (each switch's
                                                # tests are in test/switch_*.test.js, loaded by run_tests.js)
.venv/bin/python -m pytest -q                   # includes the above, Generated.gs freshness and Python parity
```
