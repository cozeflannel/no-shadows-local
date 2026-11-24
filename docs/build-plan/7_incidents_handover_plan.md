# Plan 7: incident reports, the handover, their calendars, and what follows

From the owner's requests of 23 Nov 2026 (23:29 and 23:58 ET) and 24 Nov (02:11 ET). Plan 6 phase 3 (the automatic
handover) is built here, as phase 3 of this plan.

## Decision log

| # | Decision | Chosen | Why |
|---|---|---|---|
| D1 | One report or two | Two reports on one engine. An incident report is about one alert; a handover is about one shift. Both read the event log (`triage_agent/reports.py`) | The owner asked whether they differ (23:58): they differ in unit, reader and place, not in data |
| D2 | Where each lives | "the incident report actually belongs on the same page where they work cases from. Handover goes in workforce." | The owner, 23:58 |
| D3 | Who writes them | "Both should be automated and managed by AI with ability for human to add to it. Allow for scheduled runs." | The owner, 23:58 |
| D4 | How the handover leaves the Console | "a message to a team chat space that control from the console". The Google Doc is not written | The owner, 02:11 |
| D5 | Calendars | A calendar on the main tab of Workforce and one in the Review feed. Handovers and incidents show on them "like an event looks on a google calendar". Clicking an incident opens a window over the page, glass style, with "a structured and organize list of everything that occured during that incident" | The owner, 02:11 |
| D6 | When an incident report starts | Every alert shows its timeline. The incident report (name on the calendar, AI summary, notes, dated copies) starts when an alert is escalated (a draft, a sent email, a T&S form) or when a person opens one | Told to the owner 23:58, no objection |
| D7 | Scheduled runs | An incident report can save a dated copy every hour, 4 hours, day or week, or on set dates. A copy is saved and rings the bell. No email to start | His windows (23:29: "1 hour, 4 hours, a day, and then a week, or even custom date ranges"); his "No preference" on where a scheduled report goes |
| D8 | A person's additions | A note is kept as that person's, with their name and the time. AI rewrites only its own parts | Told to the owner 23:58, no objection |
| D9 | The Reports page pitched at first | Dropped. The window view (last hour, 4 hours, day, week, two dates) is a range on the incident list and the calendar in Review | D2 |
| D10 | Contact addresses (phase 6) | "They can be stored but should never be exposed or in the repo" | The owner, 23:50 |

## Phases and steps

### Phase 1: the engine and incident reports (backend)

| Step | What | Size | Proven by | Blocked by |
|---|---|---|---|---|
| 1.1 | Timeline of one alert and the report of a window, read from the event log | S | `tests/test_reports.py` | none |
| 1.2 | Incident reports: opened by the minute run when an alert is escalated (switch `incident_reports`, OFF to start) or by a person; name, start, end, notes; kept `reports.keep_days` after the last activity | M | `tests/test_incidents.py` | 1.1 |
| 1.3 | `GET /api/calendar` (incidents and handovers between two dates), `GET /api/incidents/{id}` (the structured list), `POST /api/incidents` (open by hand), `POST /api/incidents/{id}/notes` | S | `tests/test_incidents.py` | 1.2 |

### Phase 2: the calendars and the incident window (front end)

| Step | What | Size | Proven by | Blocked by |
|---|---|---|---|---|
| 2.1 | One calendar component, month and week, events drawn as blocks | M | type check, build, a browser picture | 1.3 |
| 2.2 | The incident window: glass style, the structured list, notes | S | a browser picture | 2.1 |
| 2.3 | The calendar on Workforce's main tab and in the Review feed, with the range (last hour, 4 hours, day, week, two dates) on the incident list | S | a browser picture | 2.1 |

### Phase 3: the handover

| Step | What | Size | Proven by | Blocked by |
|---|---|---|---|---|
| 3.1 | A handover per shift from the roster's shifts: the shift's alerts from the engine, and the sections of plan 6 step 3.3 | M | `tests/test_handover_console.py` | 1.1 |
| 3.2 | Notes by people; the handover on Workforce and on its calendar | S | the same, and a browser picture | 3.1, 2.1 |
| 3.3 | Posted as a message to the team space chosen in the Console, through the queue and the Routing rules | S | the same | 3.1 |

### Phase 4: scheduled copies and AI summaries

| Step | What | Size | Proven by | Blocked by |
|---|---|---|---|---|
| 4.1 | Dated copies of an incident report on a schedule a person sets; extra handover times | M | `tests/test_report_schedules.py` | 1.2, 3.1 |
| 4.2 | AI summary on an incident report and a handover, rewritten as things change (switch OFF to start) | M | the same files | 1.2, 3.1 |

### Later phases, in the owner's order

5. The acknowledgement ladder: extends the nudges that already run in `triage_agent/followups.py` (timings per priority, backup and lead steps, the ladder's state on the alert).
6. Contacts and distribution list upkeep: upload, manage in the app, differences from the outside list shown for a person to accept (D10).
7. The AI ledger on the AI page, over the `llm.usage` events already recorded; prices are settings.

## Not yet specified

- Phase 3: the Calendar read permission for the QA chatbot's sign-in (who is on next), asked on 23 Nov, not answered. Until then the roster in the Console is the source.
- Phase 3: whether the Console also reads the Brand Safety Temp Checks doc for Active Monitoring.
- Phase 6: which outside list is compared (the Brand safety groups sheet is the one read today).
- Phases 5 to 7: read on both sides when each is picked up.

## Always / Never

- Always: test first; one pull request per piece from a fresh main; every new switch OFF to start; no address in the repo.
- Never: write to the source tables; post anywhere the Routing and Testing rules do not allow; let AI overwrite a person's note.

## Progress

| Step | Status |
|---|---|
| 1.1 to 1.3 | built (`tests/test_reports.py`, `tests/test_incidents.py`) |
| 2.1 to 2.3 | built: one calendar component (month and week), the incident window, the calendar on Workforce's main tab and in the Review feed, an Incident report button on an alert. Seen in a browser in the dark theme; the light theme not looked at. The range list (last hour, 4 hours, day, week, two dates) is not built: the calendar's month and week are the ranges so far |
| 3.1 to 3.3 | built in part (`tests/test_handover_console.py`): one handover record per shift, made at the shift's end or by a person, posted to the team space through the queue, shown on Workforce (a list, a window, the calendar), notes by people, the shift's numbers, alerts and incident reports read from the event log. Not built: the sections that need sources not connected yet (who is on next from the Calendar, active monitoring from the temp checks doc, initiatives and process updates from the team chat, pinned live links); AI does not write any of it yet (phase 4.2) |
| Phases 4 to 7 | not started |
