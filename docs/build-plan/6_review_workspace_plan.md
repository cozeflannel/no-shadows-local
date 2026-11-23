# Plan 6: the QA chatbot run from the Console, and Review as the workspace

The owner's request of 23 Nov 2026 (04:58 ET). In his words: "I need it to work exactly as it does now but controlled
from the web app", "think crm with this", and "prioritize the chatbot working and that streaming through the web app
so that the analyst could transition out of the chat and so the chatbot could take over for the analyst within the
chat space."

Two names, kept apart: the **QA chatbot** works the Chat spaces. The **Console chat agent** is Gemini inside the Console.

## Where things stand (main at a3aec81)

In the Console, each behind its own switch, all OFF until turned on:
- Routing: the source space is read every minute and copied to the second and third spaces; the Safety valve.
- `chat_review`: each new Zapier alert and its reruns are reviewed and corrected, and show in the Review feed.
- `chat_delivery`: the corrected alert and the direct messages are posted through the bot's own Chat sign-in.
- From Console buttons: the Social Alert email draft, the pre-filled T&S form, temp checks, the emoji actions.

Only in the sheet-based bot today: acting on emojis added in Chat, answering @mentions, questions and direct messages
in Chat, posting inside a thread, temp check requests and cards in Chat. The list comes from a note of 22 Nov and is a
floor: step 1.1 checks the sheet-based bot switch by switch.

Not proven: nothing the bot does through its Chat sign-in has run against live Chat from the Console.

## Decision log

| # | Decision | Chosen | Why |
|---|---|---|---|
| D1 | Which spaces the Console's bot works while it is proven | It takes over the mirror spaces now. The sheet-based bot is switched off on its Control tab, not deleted | The owner, 23 Nov |
| D2 | Whose name is on what an analyst sends from the Console, and what starts a shift | The analyst's own name: each person allows Chat once. The bot's own work stays under the bot's account. A Start shift button starts the shift; no Google sign-in each shift | The owner, 23 Nov. Google keeps the permission, so a sign-in each shift would add a step and prove nothing |
| D3 | Where the end-of-shift handover goes | The Console only. The Google Doc is no longer written | The owner, 23 Nov |
| D4 | The QA chatbot's side of the chat panel | The alert's Chat thread, live, as Chat shows it. What is typed is posted in that thread; commands to the bot work as they do in Chat | The owner, 23 Nov |
| D5 | The status dropdown | A new field the analyst sets: Pending, On hold, Closed. The bot's own statuses (verified, needs review, suppressed, and so on) stay underneath and keep feeding the numbers | His three values are a person's view of the work; the existing ones record what the bot decided |
| D6 | Engagement and sentiment on a record | Read from the post tables by the post's link. Where the post is in none of them, sentiment is Gemini's label and engagement shows as not available | Burson's alert carries neither. A label is not a number, so the rule "no model writes a number" holds |
| D7 | Settings clean-up | Settings a person does not need day to day move under one Advanced section. Nothing is deleted | The bot's rules still need them |
| D8 | The Cases tab | Out of the menu. Its links open the same alert in Review | His words: "Remove or hide the cases tab" |
| D9 | How Chat is read | By the bot's sign-in, every minute, as now. No Chat app, no webhooks, no Apps Script | Standing rule (22 Nov) |
| D10 | Order | The QA chatbot first, then Review, then identity, shifts and the handover, then Settings | His words: "prioritize the chatbot working and that streaming through the web app" |

## Phases and steps

Sizes: S = a few files, M = one subsystem. A step is done when its named check passes and the whole test command still passes.

### Phase 1: the QA chatbot works Chat on its own

Verified when: with the sheet-based bot off, an alert in the source space is copied, reviewed, corrected and posted,
a question in Chat is answered in its thread, and each of the sheet's Control switches has its Console counterpart or a
line in the decision log saying why not.

| Step | What | Size | Check | Blocked by |
|---|---|---|---|---|
| 1.0 | Live proof, by the owner: sign in as the QA chatbot, set Routing, turn on `chat_review` and `chat_delivery`. Whatever fails is fixed before anything else | S | Routing shows copied, reviewed and posted with nothing red | none |
| 1.1 | Parity table: every Control switch and every thing the sheet-based bot does in Chat, against the Console, read from the code of both. The table below is filled in and its gaps become steps | M | The table has no "to check" left | none |
| 1.2 | The bot's replies land in the alert's thread. A queued post carries its thread; delivery posts into it; the copy spaces keep the same threads | S | `tests/test_chat_threads.py` | 1.1 |
| 1.3 | Mentions, questions and direct messages in Chat are answered by the bot through its sign-in (op `converse`), in the thread or the direct message | M | `tests/test_chat_answers.py` | 1.2 |
| 1.4 | Emojis added in Chat act as they do with the sheet-based bot (op `record_reaction`), with the reply in the thread | M | `tests/test_chat_emojis.py` | 1.2 |
| 1.5 | Temp check requests typed in Chat, and the result posted there | M | `tests/test_chat_tempcheck.py` | 1.3 |
| 1.6 | One QA chatbot panel on the Routing page: every switch that decides where the bot reads and writes, each saying what ON and OFF do, and one guarded step to go live in Burson | S | `tests/test_routing.py` plus a browser check | 1.1 |
| 1.7 | Whatever 1.1 finds missing, one step each | ? | named at 1.1 | 1.1 |

Parity, first pass (23 Nov). "Not found" means no setting or module of that kind was found by name in the Console's
code; step 1.1 confirms each row by reading both sides, and each confirmed gap becomes a step under 1.7.

| Sheet Control switch | Console today |
|---|---|
| Bot (B2) | Yes: Routing, QA chatbot ON |
| Relay with S-F Burson | Yes: Routing, source, second and third space, Copy everything |
| Post in S-F Burson, with the Burson outbox's Send | Yes: Routing writes in the source only with the valve OFF and no second space; Wait for Send |
| Safety valve | Yes |
| Work directly in B25 | Yes: Routing with no second space |
| Auto-find missing links | Yes: Find missing links |
| Direct BigQuery alerts | Yes: Our own alerts |
| Proactive watch | Yes: Watches |
| Early wave & velocity check | Yes, as Early Detection in BigQuery. Velocity spikes were not carried over |
| Fast triage, and its rank and hold-back switches | Yes: the Gemini Decisions switches |
| Write early-wave records to BigQuery | Yes, always: Early Detection keeps its records in BigQuery |
| Early Detection and Proactive watch also read the AMIE table | Yes: a tick per table on Integrations |
| Live dashboard | Yes: Dashboard and Stories |
| Temp checks | In the Console, yes. Typed in Chat, no (1.5) |
| Draft answers to questions | The sheet's is a Gmail draft on the Social Alert's thread: not found. Answers in Chat exist as op `converse`, not reached from Chat yet (1.3) |
| Write back to SLRR BigQuery | Partly: Our own alerts' mark-delivered setting only |
| Learn from IM calls | Partly: Learning page and checked examples. Showing Gemini the similar past calls: not found |
| Check outage & comms docs | Partly: the Knowledge documents are read. The outage check and holding statements: not found |
| Track post-alert outcomes | Partly: T&S outcome emails are read only when a Studio flow hands them over. Replies on sent Social Alerts and the Follow-up list: not found |
| Auto-send Social Alerts | No: the email is a Gmail draft a person sends |
| Auto-submit T&S form | No: a pre-filled form a person submits |
| KB & Guidance can start alerts | Not found |
| Watch sent alerts (24h) | Not found |
| Never wait on Burson | Not found: the Console sends a broken alert back to Burson and waits for the rerun |
| Draft follow-ups | Not found |
| Group test emails | Not found |
| Early Detection also reads Brandwatch live | Not in Early Detection. Agent alerts reads Brandwatch live |
| Open engine | Does not apply: the Console's Early Detection has no fixed review limits to replace |
| Slide deliveries | No |

### Phase 2: Review is the workspace

Verified when: an analyst can work an alert from start to close without opening Chat or another page.

| Step | What | Size | Check | Blocked by |
|---|---|---|---|---|
| 2.1 | One record per Zapier alert: the Zapier message and its reply thread as Chat shows them, the bot's work, the post's link, engagement and sentiment (D6) | M | `tests/test_review_record.py` | 1.2 |
| 2.2 | Status (Pending, On hold, Closed) as a dropdown and as the list's tabs; who is working it | S | `tests/test_review_status.py` | 2.1 |
| 2.3 | The escalation steps on the record, each with its state and its button: the email draft (drafted, sent), the T&S form (filled, submitted), the temp check (suggested, running, done, or Start one) | M | `tests/test_review_steps.py` | 2.1 |
| 2.4 | A summary of everything so far, written by Gemini from the record's own events and rewritten when the record changes. No number comes from the model | S | `tests/test_review_summary.py` | 2.1 |
| 2.5 | Write to the alert's thread from the record: tag people, post | S | `tests/test_review_post.py` | 1.2 |
| 2.6 | The chat panel inside Review: Gemini and the alert's thread side by side (D4); a finished temp check shown inside the panel, small, not on another page | M | `tests/test_review_chat_panel.py` plus a browser check | 2.1, 2.5 |
| 2.7 | New alerts and the bot's work appear without a reload | S | `tests/test_review_live.py` | 2.1 |
| 2.8 | Cases out of the menu; its links open Review (D8) | S | frontend type-check and a browser check | 2.1 |

### Phase 3: working as yourself, shifts, the handover

| Step | What | Size | Check | Blocked by |
|---|---|---|---|---|
| 3.1 | Each person allows Chat once, next to Connect Gmail. What they send from the Console is posted under their own name (D2) | M | `tests/test_chat_as_person.py` | 1.0, 2.5 |
| 3.2 | Start shift and End shift. Workforce shows who is on now and each shift's real start and end | S | `tests/test_shifts.py` | none |
| 3.3 | The handover, at End shift: alert statuses, what is outstanding, temp checks done and under way, alerts to watch and process updates are gathered from the shift's own records; Gemini writes the note; the analyst reads, adds to it and confirms; the next person sees it at Start shift (D3) | M | `tests/test_handover.py` | 3.2, 2.2 |

The handover today, from the owner's photos of the doc (23 Nov). It is rewritten at each shift start, four times a day:

| Section today | Its source today | In the Console (3.3) |
|---|---|---|
| Incident Managers: outgoing, incoming and on deck, each with their shift hours | The SLRR Alerts Coverage calendar | The same calendar, read by the QA chatbot's account. Beside it, who pressed Start shift and End shift, and when |
| Active Monitoring: the 5 most recent temp checks, each with a Status & Next Action note kept by hand | The Brand Safety Temp Checks doc | The Console's temp checks, newest first. Each has a Status & next action note an analyst edits; the note stays while the temp check is in the five |
| Initiatives to Watch, past 7 days: date, from, what to watch, link | The 24/7 SL team chat | That space, read by the bot's sign-in. Gemini picks the messages and writes each line; each line links to its Chat message |
| Ongoing Issues: the top 5 by number of alerts, past 48 hours, with product | Not stated | Counted in Python from the Console's own alerts, by issue name |
| Recent Process Updates, past 7 days: date, from, update, link | The 24/7 SL team chat | As Initiatives to Watch |
| Pinned Live Links, Instagram and Facebook only, past 48 hours | The Live Link Announcements space | That space, read by the bot's sign-in. The links are matched by their address, in Python |
| The analyst's close-of-shift note | Typed by the analyst | Gathered from what the analyst did in the Console that shift (alerts worked and their status, what is outstanding, temp checks done and under way). Gemini writes the note; the analyst reads it, adds to it and confirms |

Which messages count, the look-back days, the number of rows, the two spaces and the calendar are settings.

### Phase 4: Settings cut down

| Step | What | Size | Check | Blocked by |
|---|---|---|---|---|
| 4.1 | Every Settings page and field listed with who needs it and how often; the owner marks what he does not recognise | S | the list, agreed | none |
| 4.2 | Day-to-day settings first, the rest under Advanced (D7); fields the BigQuery card already covers leave the older pages; each remaining field says what it does in plain words | M | `tests/test_settings_layout.py` plus a browser check | 4.1 |

## Not yet specified

- 3.3: the calendar needs Google Calendar's read permission added to the QA chatbot's sign-in, and the calendar shared with that account. Whether temp checks done outside the Console (the Brand Safety Temp Checks doc) are listed too: until the team runs them in the Console, Active Monitoring shows only the Console's own. Where today's Ongoing Issues count comes from is not stated in the doc.
- 1.5: which typed requests the sheet-based bot understands. Read from `TempCheck.gs` and `Voice.gs` when the step is picked up.
- 2.5: whether people outside the roster can be tagged.
- 3.1: whether Chat accepts a post made with a person's own sign-in from this project's sign-in client. It is the same call the bot's sign-in makes; step 1.0 proves that one.
- Auto-send and auto-submit: the sheet has both switches. Whether the Console gets them is the owner's call after 1.1.
- The list of the 30 workflows.

## Always / Never

- Always: every switch starts OFF. Every write in Chat goes through `chatapi.ChatClient`, which asks the Routing page's rules first; the leak guard checks anything headed for the source space. Each step is test-first, on real records, and every action a person or the bot takes is audited.
- Never: a Chat app, webhooks or Apps Script in the bot's path. A number written by a model. A write to a table the app only reads. A change to the project's Vertex AI settings. A value a person may need to change, written in the code. Deleting the sheet-based bot. Merging a pull request without the owner's ask.

## Progress

| Step | Status |
|---|---|
| 1.0 Live proof | the owner's steps, given 23 Nov |
| 1.1 Parity table | next |
| 1.2 to 1.7 | not started |
| Phase 2 | not started |
| Phase 3 | not started |
| Phase 4 | not started |
