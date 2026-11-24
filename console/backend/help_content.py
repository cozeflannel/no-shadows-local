"""Help pages for the Console: how to use each page and setting. Written for IMs and admins.

Separate from the knowledge docs the agent reads. Each topic belongs to a page; `anchor` is what a page's Help link
opens. Steps lead with the action.
"""

from __future__ import annotations

from typing import Any

TOPICS: list[dict[str, Any]] = [
    {
        "id": "getting-started", "page": "Start", "title": "Getting started", "audience": "everyone",
        "summary": "Sign in, find your work, and what each page is for.",
        "sections": [
            {"heading": "Sign in", "steps": [
                "Open the Console link. Google sign-in runs before the page loads.",
                "Your role shows at the top right: viewer (read), analyst or IM (act on alerts), lead, admin.",
                "No access: ask an admin to add you under Admin → People."]},
            {"heading": "Where to work", "items": [
                "Dashboard: what is happening now and over a period.",
                "Review Feed: every alert, what the agent decided, and the actions you can take.",
                "Stories: alerts on the same story, grouped, with how each story is growing.",
                "Chat agent: ask the agent, or have it do the work for you.",
                "Chat spaces: everything said to and by the agent in Chat.",
                "Temp check: a quick snapshot of an emerging issue.",
                "Workforce: who is on, the schedule, the forecast.",
                "Knowledge: the documents the agent reads.",
                "Campaigns & Watches: Brandwatch campaigns and early-warning watches.",
                "Compare: Burson, the app and the IMs, side by side.",
                "Integrations: the tools the agent is connected to (admins).",
                "Admin: people and roles, system status, recent changes (leads and admins).",
                "Settings: tuning values. Each has a working default (admins)."]},
            {"heading": "Chat or Console", "text": "Work an alert in Chat with reactions, or here. Both are recorded in the same case timeline and audit log."},
            {"heading": "Going back", "text": "Every page but the Dashboard has < back above its title. It opens the page you came from, or the Dashboard."},
        ],
    },
    {
        "id": "dashboard", "page": "Dashboard", "title": "Dashboard", "audience": "everyone",
        "summary": "Alert messages counted by the lines on the alert, with filters and response times.",
        "sections": [
            {"heading": "Right now", "items": [
                "The first row is live and the time range and filters don't change it: alerts held for review, alerts waiting for an IM, SLAs at risk, alerts sent back to Burson, posts waiting to go out and who is on shift.",
                "Click a number to open the list behind it."]},
            {"heading": "Pick a time range and filters", "steps": [
                "Choose Today, Last 24 hours, Last 7 days, Last 30 days or Custom. Custom days run from midnight to midnight, Eastern time.",
                "Open a filter (Product, Social network, Exposure tag, Sensitive topic, KOF, KOF list, Sentiment, What the agent decided, Came from) and tick one or more values. Each value shows how many alert messages it has.",
                "Several values in one filter mean any of them; different filters must all hold.",
                "Click a bar in any card to filter by it; click it again to stop.",
                "The filters are in the page's address: copy it to share the same view. Reset filters goes back to Today with no filters."]},
            {"heading": "Read the numbers", "items": [
                "The big number is the alert messages in this view. A rerun or an engagement update is another message on the same alert.",
                "Product, Social network, Exposure tag, Sensitive topic and KOF are the lines of a Burson alert, with the names from the requirements. An alert that names several products or topics counts under each.",
                "Sentiment is Gemini's read of each post on the Stories page, when Gemini reads each story is on.",
                "Response times run from an alert's first message to the agent's review, the first IM response, Burson's corrected re-post, the Social Alert draft, the email being sent and a Trust & Safety report. Each one counts only the alerts that got to that step.",
                "The chart and every measure under Every measure follow the filters too."]},
            {"heading": "Notifications and Ask Gemini", "items": [
                "The bell at the top lists what happened lately. Click an item to see it without leaving the page; Open goes to its page.",
                "Ask Gemini, in the corner of every page, opens the chat agent beside the page."]},
        ],
    },
    {
        "id": "review-feed", "page": "Review Feed", "title": "Review Feed", "audience": "IMs",
        "summary": "Work alerts: a list with a line each. Open one to write its email, file its T&S form, run a temp check and grade the chatbot.",
        "sections": [
            {"heading": "Find an alert", "steps": [
                "Each alert is one line: its name, where it stands, and the date and time it came in. Click a column heading to sort by it.",
                "The tabs choose what is listed: All alerts, Burson's alerts, Agent alerts (what the agent raised itself) or Chat messages (what the agent read and posted in Chat).",
                "Needs action shows what is waiting for a person, most urgent first. Switch the view: Review, Verified, Suppressed, Closed or All.",
                "Tick Full messages to see each alert's whole message under its line.",
                "Search by case id, product, tag or issue.",
                "In All alerts, an alert the agent raised itself has a lit edge."]},
            {"heading": "Open an alert", "items": [
                "Click a line. The alert opens over the list and takes most of the page; the list stays in view on the right, to step to the next alert.",
                "Left: a short brief (what the alert says, where it stands, what to do) and the details. Gemini words the brief; the to-do list and every figure come from the alert itself.",
                "Middle: Email (the Social Alert email), Alert (the message as posted, the fields, what the agent changed and the knowledge it cited) and Activity (the timeline and what was said in Chat).",
                "Right: Trust & Safety, Temp checks, Chatbot QA and the actions taken.",
                "Details shows the counted figures: Burson 3 of 5 right (of the fields Burson filled in, how many stood up to the checks) and, when the switch "
                "Gemini Decisions scores each alert is ON, how likely the alert is to need a person.",
                "Kept 47 of 50, beside a field on the Alert tab: how often incident managers kept the app's value for that field in their own assessments, last 30 days.",
                "Press Esc or the X to go back to the list."]},
            {"heading": "Write the Social Alert email", "steps": [
                "Open the alert. The email is already written from the alert, in the team's Social Alert template.",
                "Click into the email and type: you edit it as it will look. The toolbar has bold, italic, underline, lists and links.",
                "Check To, Cc, Bcc and the subject. Routed to shows the groups the routing rules chose.",
                "Press Save as a draft in Gmail. The draft lands in your own Gmail; connect Gmail from the top bar first.",
                "Open it in Gmail to send. The Console sends nothing on its own.",
                "With the switch Send alert emails from the Console on, Send now is beside Save: it asks first, saying who the email goes to, "
                "then saves it as it is written and sends it from your Gmail. While Testing is on it goes to the Testing recipients only, and with none set it is not sent.",
                "Start over from the alert drops your edits and writes the email again.",
                "While Testing is ON the draft is addressed only to the testing recipients."]},
            {"heading": "Trust & Safety form", "steps": [
                "When the agent recommends a report, the form is filled in as you open the alert.",
                "Press Open the filled-in form to review it. Change what needs changing there, then submit it or close it.",
                "Back on the alert, press I submitted it, or Discard.",
                "When the agent did not recommend a report, Check it anyway and fill in the form does it on request."]},
            {"heading": "Temp checks", "steps": [
                "Temp checks made for the alert are listed on the right. The agent starts one on its own when an alert calls for it and that switch is on.",
                "Click one to preview it over the alert.",
                "Press Confirm and close, or Confirm and send to Chat: a message with its summary and the link to its document is queued for the analysts' space.",
                "Edit in Google Docs opens its document, when it has one.",
                "Ask Gemini to change the write-up: it rewords the summary, the drivers and the themes. The counts stay the ones that were counted.",
                "Run a temp check starts a new one for any alert."]},
            {"heading": "Grade the chatbot", "steps": [
                "Press Grade the chatbot's work. Rate each thing from 1 to 5, or leave it Not rated.",
                "Say what was right, what was wrong and what it should do next time.",
                "Submit. The score is counted from your ratings and their weights; no model sets it.",
                "One person evaluates an alert. The first to submit owns its evaluation and can revise it (Revise your evaluation); everyone else reads it.",
                "You are shown what was understood and what was done with it: a checked example kept, and what became of each lesson.",
                "A lesson waits for a lead under Knowledge, Learning. With the switch Apply evaluation lessons without approval on, Gemini compares it with the "
                "lessons already in use and the passages of the knowledge documents nearest to it instead: nothing against it and it is in use at once; "
                "anything else (something against it, or no clear answer) and it is held for a lead, with what it goes against.",
                "The check lowers the chance of a contradiction; it does not rule one out. It reads the nearest passages, not every line of every document. "
                "Each lesson in use says what it was compared with.",
                "A lesson in use is read by the alert reviewer on every alert (by the agent's own alert review when it came from one of its alerts) and in chat answers. "
                "A lead can take one out of use under Knowledge, Learning.",
                "Every evaluation is listed under Records, Chatbot QA evaluations."]},
            {"heading": "Decide an alert held for review", "steps": [
                "Open the alert and press Decide.", "Tick the proposed corrections to apply, then send it on. Or Send back to Burson, or Suppress.",
                "Send back needs a reason."]},
            {"heading": "Record an action", "steps": [
                "Open the alert and press Actions.",
                "Tick what you did or want done: Acknowledge, Email (PAs), T&S form, add a team, crisis chat, close, superseded.",
                "Press Apply. Each one is recorded on the alert as its emoji in Chat would be."]},
            {"heading": "Agent alerts", "items": [
                "To judge: alerts the agent raised that nobody has confirmed or marked a false positive yet.",
                "Raised: every alert it raised, with each verdict.",
                "Not raised: what Gemini looked at and decided not to raise, and why. These are done: nothing is asked of you. They are kept as a record.",
                "Open one to read the reason and the posts, then press Confirm or False positive. A verdict can be changed.",
                "What the agent reads and the rules it reads by are under Settings: Sources and Rules."]},
            {"heading": "Add an alert by hand", "steps": ["Click Triage an alert.", "Paste the alert's text.", "It is triaged like any other and gets a case."]},
            {"heading": "Incident reports and the calendar", "items": [
                "Open an alert in the Review feed and press Incident report. It shows everything that happened to the alert, in order, in four parts: arrival and review, response, escalation, outcome.",
                "Add a note at the bottom. It is kept under your name and nothing rewrites it.",
                "Press Calendar on the Review feed, or open Workforce, to see incident reports on a calendar by month or week. Each one runs from the alert's arrival to its end. Click one to open it.",
                "Turn on Incident reports under Settings, Switches to have one opened automatically for every alert that is escalated (a draft, a sent email or a T&S form). With it OFF, an incident report exists only where a person opened one.",
                "An incident report is removed 30 days after its last activity."]},
        ],
    },
    {
        "id": "chat-spaces", "page": "Chat spaces", "title": "Chat spaces", "audience": "everyone",
        "summary": "Everything the agent received from Chat and posted back.",
        "sections": [
            {"heading": "Where it is", "items": [
                "The spaces and their counts: Dashboard, Chat spaces tab.",
                "The messages themselves: Review feed, Chat messages tab."]},
            {"heading": "Browse", "steps": [
                "On the Dashboard's Chat spaces tab, click a space's card to see only that space. Counts are for the period shown.",
                "Messages are grouped by thread, newest first.",
                "In the Review feed's Chat messages tab, pick a space and a window, or search the text. Full messages shows each conversation whole."]},
            {"heading": "Statuses", "items": [
                "Received: a message, reaction or email the agent was handed.",
                "Returned: a post the agent handed back to Chat to post.",
                "Queued: waiting to post.", "Delivered: handed to Chat.",
                "Held: stopped by a safety check. See Settings → Safety."]},
            {"heading": "Limits", "text": "The agent sees only what Chat hands it: alerts in the alert space, reactions on its posts, mentions and direct messages. Other messages in a space are not tracked."},
        ],
    },
    {
        "id": "chat-agent", "page": "Chat agent", "title": "Chat agent", "audience": "IMs",
        "summary": "Ask the agent, or have it work an alert for you.",
        "sections": [
            {"heading": "Ask", "steps": ["Type a question or a request and press Enter.", "The agent shows each tool it used and what came back.",
                                         "Answers cite the documents and cases they rest on."]},
            {"heading": "Have it act", "steps": [
                "Ask for the action in plain words: \"forward TRG-1042 with product Gemini App\", \"draft the email for TRG-1042\", \"run a temp check on the Gmail outage\".",
                "An action waits for you: Do it runs it, Cancel stops it.",
                "Actions need the analyst role and the chat agent's action switch (Settings, Switches: Let the chat agent act)."]},
            {"heading": "What it can do", "items": [
                "Find and explain alerts; show the review queue.", "Triage a pasted alert.", "Review decisions, reverts, closing.",
                "Every reaction action: acknowledge, email draft, T&S form, teams, crisis chat.",
                "Temp checks.", "Anything the agent understands in Chat (revise a draft, handover, roster sign-in).",
                "Search knowledge, metrics, who is on shift."]},
            {"heading": "From any page", "text": "Ask Gemini, in the bottom-right corner of every page, opens the same chat beside the page. It keeps your chat while you move between pages; New chat starts over and Open full page shows it on this page."},
            {"heading": "Record", "text": "Every tool call is in the audit log under your name."},
        ],
    },
    {
        "id": "temp-check", "page": "Temp check", "title": "Temp check", "audience": "IMs",
        "summary": "Run, read and act on temp checks.",
        "sections": [
            {"heading": "From a Brandwatch query", "steps": [
                "Type a few words of the query's name and pick it from the list. A pasted Brandwatch link or id works too.",
                "Leave Count from on the issue's start, or choose a time.",
                "Click Run temp check. Each step shows as it happens, and the result opens when it is done."]},
            {"heading": "No query yet", "steps": [
                "Click No query yet and name the issue. Paste the alert post if you have it.",
                "Click Draft a broad query (Gemini) and read the query it fills in. Change it, type your own, or use Filters.",
                "Click Run temp check. With no query typed, a broad one is drafted for you."]},
            {"heading": "Our own data", "items": [
                "Tick the tables to search.",
                "Show how the query converts lists what was read, what was approximated or left out, what each table would scan, and the SQL. Nothing runs.",
                "Reuse posts gathered earlier searches only the time since that temp check."]},
            {"heading": "Read the result", "items": [
                "Write-up: the team's template with its chart. Copy write-up copies it with the chart, ready to paste into an email or a doc. Download chart saves the chart as a picture.",
                "Numbers: the total, the peak hour, the last full hour, sentiment, mention types and sources, as charts and as a table.",
                "Our data next to Brandwatch: what our own tables hold beside Brandwatch's count, hour by hour, how the query was converted, and the posts found.",
                "Posts read: the posts Gemini read. Open a card to read the post without leaving the Console.",
                "Concern level: a Brandwatch query's count ranked against past issues at the same hours in. It needs enough past issues to compare."]},
            {"heading": "Search the web", "steps": [
                "Open a temp check and click the On the web tab. It shows while the switch Search the web in a temp check is ON.",
                "Type what you need to know about the issue, or leave the box empty to ask what people are saying.",
                "Click Search the web. Gemini searches Google and answers in a few sentences. Each number opens the page that sentence came from.",
                "Google's own search buttons under the answer open the searches it ran."],
             "items": [
                "The answer is shown to you only and is gone when you reload the page. Google's terms allow a searched answer to be shown only to the person who asked, and not to be stored.",
                "It is not kept with the temp check, is in none of its numbers and is not in the write-up.",
                "Google bills each search. Which search is used, the sites looked at first and the sites left out are under Settings, Temp check."]},
            {"heading": "Act on it", "steps": ["Mark as used, or Dismiss.", "Refresh (send as an update) reports what is new since the last one.",
                                              "Keep refreshed for a day refreshes it every hour. Stop refreshing ends it."]},
            {"heading": "From Chat", "text": "Type `temp check` in an alert's thread, or follow it with a Brandwatch query's name or a Boolean."},
            {"heading": "Automatic", "text": "With the auto switch on, an alert starts a draft when it is high-engaging, when it is the third post on an issue in a day, or when its post is climbing. The numbers are under Settings → Temp check."},
        ],
    },
    {
        "id": "workforce", "page": "Workforce", "title": "Workforce", "audience": "leads",
        "summary": "Who is on, the schedule, volume history, the forecast and reports.",
        "sections": [
            {"heading": "Now", "items": ["Who is on shift and until when.", "Open load and load per IM.", "Live volume against the forecast, hour by hour. A gap alert shows when volume runs over."]},
            {"heading": "Build the schedule", "steps": [
                "Open Schedule and click Edit rosters and shifts.", "On Rosters: add people, recurring slots, and one-off coverage for a time window.",
                "Back on Schedule, the grid shows each hour's staffing against what the forecast needs. Red hours are short."]},
            {"heading": "Shifts", "steps": ["Open Settings → Shifts.", "Add or edit named shifts (name, start, end, timezone) and Save. Handover timing follows them."]},
            {"heading": "Forecast", "steps": [
                "Open Forecast. Run forecast runs it now; the schedule runs it on its own when the switch is on.",
                "Recommendations list the hours that are short or over-staffed.",
                "Accept applies it (adds coverage for the suggested person). Edit lets you change the person or the window first. Dismiss closes it.",
                "Nothing changes the schedule until you accept."]},
            {"heading": "Methods", "text": "TimesFM (BigQuery AI.FORECAST) is the primary method. ARIMA_PLUS is the fallback and shows trend and daily and weekly patterns. Choose under Settings → Forecasting."},
            {"heading": "Reports", "steps": ["Open Reports and pick a period.", "Coverage, utilization, forecast accuracy (MAPE) and the gaps are shown.", "Export CSV downloads the report."]},
            {"heading": "Handovers and the calendar", "items": [
                "A handover is made for each shift when it ends, and posted to the team space. It is listed under Handovers on the Now tab and shows on the calendar below it.",
                "Click a handover to open it: what was posted, the shift in numbers, its incident reports, and each alert with its timeline.",
                "Add a note at the bottom of a handover. It is kept under your name.",
                "Make the handover for the shift that just ended yourself with the button on the Handovers card. A shift is handed over once.",
                "The calendar also shows incident reports. Click one to open it.",
                "The Handover doc is no longer written. An admin can turn it back on under Settings."]},
        ],
    },
    {
        "id": "rosters", "page": "Rosters", "title": "Rosters", "audience": "leads",
        "summary": "The IM roster and the Burson on-call roster.",
        "sections": [
            {"heading": "Edit a roster", "steps": ["Open Workforce → Schedule, or Rosters.", "Pick IM shifts or Burson on-call.",
                                                   "Edit people, recurring slots, the backup and the fallback. Save."]},
            {"heading": "Cover a window", "steps": ["Click Add coverage.", "Pick the person, start and end.", "It takes effect at once and shows in the week view."]},
            {"heading": "From Chat", "text": "`I'm on until 6pm ET` and `hand off to <email>` change the roster for the sender."},
        ],
    },
    {
        "id": "knowledge", "page": "Knowledge", "title": "Knowledge", "audience": "leads",
        "summary": "The documents the agent reads, which kind of alert reads which document, and the checked examples.",
        "sections": [
            {"heading": "Upload a document", "steps": [
                "Click Upload and choose one or more files: Word (.docx), PDF, a web page (.html), Markdown (.md) or text (.txt).",
                "Each file becomes a document with its headings, lists, links and tables kept. Status shows ready, or what to fix.",
                "Click its title to say what it covers, add tags, or mark it Guidance."]},
            {"heading": "Write or edit a document", "steps": [
                "Click Write one for a new document, or click a document's title to open it.",
                "Edit it on the page as in a word processor: the bar sets the text style, bold, italic, underline, links, lists, quotes and tables.",
                "Save. The agent reads the new version at once and the version number goes up.",
                "A linked web page or Drive file is edited where it lives; click Fetch to read it again."]},
            {"heading": "Link a document", "steps": [
                "Click Link one.", "Choose Web page (a public link) or Drive (a Docs, Sheets or Slides link) and paste the link.",
                "Say what it covers. Add tags.", "Tick May be quoted in the Burson space only if it may be used in answers there.", "Save."]},
            {"heading": "Export", "items": [
                "One document: choose Word, Web page or Text under Download on its row.",
                "Every document: choose a format under Export all. They come as one .zip file.",
                "Each export is on the record."]},
            {"heading": "Drive documents", "text": "Share the file with the agent's service account (Viewer). PDFs and Office files can't be read: save them as Google Docs first."},
            {"heading": "Bring over the sheet's documents (admins)", "steps": [
                "Click Bring over from the sheet. The Console reads the sheet's Resources tab and lists what would happen to each document: New, Update, Already here or Left out, with the reason.",
                "Check the list. Documents marked Burson may see it can be quoted in the Burson space, as on the sheet.",
                "Click Bring over. Each document comes with the text the chat bot already read, so the agent can use it at once.",
                "Each one keeps its Drive link. Once the Console's account can open the file it reads it from Drive itself; until then the sheet's copy is used and the status says so.",
                "Run it again any time: documents already here are updated, never doubled, and nothing made in the Console is removed.",
                "If the sheet can't be read, the message names the account to share the sheet with (Viewer is enough)."]},
            {"heading": "Map classes to documents", "steps": [
                "Open Classes.", "Each class lists the documents it reads.",
                "Tie a document to a class on the document itself (Classes), or give the class tags under Settings → Classification."]},
            {"heading": "Try retrieval", "steps": ["Open Try a search.", "Type a question or paste an alert.", "The passages the agent would read are listed with their scores."]},
            {"heading": "Checked examples", "items": ["Every alert an IM confirmed or corrected is kept as an example of the right answer.", "Export downloads them as a file used to test the agent."]},
            {"heading": "Learning", "text": "Facts taught in Chat, lessons from evaluations that are held or waiting, and proposed configuration changes wait under Proposed rules and facts. A lead can take a fact or a lesson in use out of use there."},
        ],
    },
    {
        "id": "campaigns", "page": "Campaigns & Watches", "title": "Campaigns & signals", "audience": "leads",
        "summary": "Brandwatch alert campaigns, and signals (watches): yes/no questions Gemini asks of every new post, as on the sheet's Watches tab.",
        "sections": [
            {"heading": "Campaigns", "items": [
                "Each campaign shows its status, query, alert, space, threshold, cap and today's counts.",
                "Change a campaign: click Change, fill in only what should change, Request change. The campaigns service applies it within a minute and writes the result back.",
                "End now closes the campaign."]},
            {"heading": "Add a signal", "steps": [
                "Open Signals (watches) and click New signal.",
                "Start from: a blank signal with the sheet's standard scoring and topics, one of the sheet's templates, or a copy of a signal you have.",
                "Name it, and write what to look for as a yes/no question.",
                "Check how to score impact from 1 to 10, the topics, the flag score and the networks (empty: every network).",
                "Add it. It starts off: turn it on with its switch when you are ready."]},
            {"heading": "On, off and the limit", "items": [
                "Each signal has its own on/off switch. At most the number shown can be on at once, because each one is a question Gemini asks of every new post.",
                "The Watches switch (Settings, Switches) only decides whether the Console looks at new posts at all. Signals can be added, changed, turned on or off and deleted while it is off.",
                "Each signal says in plain words what is happening: off, on but not checked (and why), or checked with its last 24 hours."]},
            {"heading": "Bring over the sheet's signals", "steps": [
                "Click Bring over the sheet's signals. Each row of the sheet's Watches tab is listed with what would happen to it.",
                "Every one comes over off, even if it is on in the sheet: the list shows which ones are on there.",
                "Running it again updates signals of the same name and never changes whether they are on."]},
            {"heading": "Read found posts", "items": [
                "At or over the flag score: flagged. A little below: a near miss, kept so you can tune the flag score.",
                "Rate each one Useful or Noise.", "Ahead shows how long before the alert the signal saw the post."]},
            {"heading": "Scorecard", "text": "For each day: alerts that came in, how many a signal caught, how many it caught first, and the median head start."},
        ],
    },
    {
        "id": "cases", "page": "Cases", "title": "Cases and escalations", "audience": "everyone",
        "summary": "Every case, its timeline, emails and T&S forms.",
        "sections": [
            {"heading": "Find a case", "steps": ["Open Cases.", "Search or filter by status, source, track or tag.", "Click a row for the fields, corrections, timeline and Chat activity."]},
            {"heading": "Emails & T&S", "text": "Emails & T&S lists every draft and form with its versions and recipients."},
            {"heading": "Our alerts vs Burson's", "text": "The alerts found from the team's own tables, next to Burson's alert for the same post."},
        ],
    },
    {
        "id": "stories", "page": "Stories", "title": "Stories", "audience": "everyone",
        "summary": "Alerts on the same story, grouped, with Gemini's read of each. See them by story, product, topic or sentiment.",
        "sections": [
            {"heading": "Read the map", "items": [
                "One circle per story. Its size is its engagement (or its number of alerts: Settings → Stories → Size by).",
                "Red: at least half of the story's rated posts are negative. Grey: neutral. Green: positive. A dashed grey ring: not rated yet.",
                "Inner circles are the smaller stories in it: the alerts under one issue name.",
                "Color by Activity shows blue for growing, violet for new and grey for quiet instead.",
                "A gradient ring: an alert in the story needs action."]},
            {"heading": "Change the view", "steps": [
                "View by Product or Topic: one circle per product or topic. Its inner circles are its posts by sentiment.",
                "View by Sentiment: one circle each for negative, neutral, positive and not rated. Its inner circles are the stories in it.",
                "Click a circle to list its stories. Show only these stories filters the map to that product, topic or sentiment.",
                "Use the Product, Topic and Sentiment filters, or type an issue name under Find a story."]},
            {"heading": "Gemini's read", "items": [
                "With the switch Gemini reads each story ON, Gemini gives every story a topic, a neutral name and a short summary, and labels each post negative, neutral or positive.",
                "The page counts the labels. No count or share comes from Gemini.",
                "The biggest unread stories are read first, a few on every run. A story that grows is read again.",
                "Read now on a story reads it straight away.",
                "The shares that make a story negative or positive, and how many posts are read, are in Settings → Stories."]},
            {"heading": "Watch a story grow", "steps": [
                "Click Play. The map starts just before the first alert of the stories shown and grows to now in 6 to 14 seconds. Pause stops it.",
                "Or drag the time slider. At each moment a circle holds only the alerts that had come in by then. The line under the slider "
                "says the moment and how many alerts, stories and accounts there were so far.",
                "Each tick above the slider is a moment when an alert came in. Busy stretches take up more of the slider, so every move shows "
                "a change. The grey line is where the window starts: a story on the map can have alerts from before it.",
                "With the slider selected, the arrow keys step from one alert to the next; Home goes to the start and End to now.",
                "Start over goes back to the first alert. Jump to now shows the map as it is now.",
                "With reduced motion turned on in your computer's settings, Play steps from one alert to the next without moving in between.",
                "Use Window to choose which stories are shown: those with an alert in the last 24 hours, up to 30 days."]},
            {"heading": "Open a story", "steps": [
                "Click a circle, or a row in List.",
                "The panel shows Gemini's read, the posts by sentiment, the running total, the smaller stories, every post with its words, and the Chat messages linked to them.",
                "Click a smaller story to see only its posts.",
                "Open alert goes to the alert in the Review Feed. Open post goes to the post."]},
            {"heading": "How alerts are grouped", "items": [
                "Same story: the alerts mean the same, by the similarity in Settings → Stories. Set an embedding model under Integrations → Gemini to match by meaning.",
                "Without an embedding model: the same exposure tag and issue names that share most of their words.",
                "Never the same story: both alerts name a CVE id, a long number or an @handle, and share none.",
                "A story silent for the keep-days in Settings → Stories is over. A later alert starts a new story.",
                "Each alert in the panel says why it is there: it started the story, or it matched by meaning or by words."]},
        ],
    },
    {
        "id": "compare", "page": "Compare", "title": "Compare: Burson, the app and the IMs", "audience": "everyone",
        "summary": "One page of numbers for a period, next to the period before.",
        "sections": [
            {"heading": "Read the page", "steps": ["Pick 7, 14, 30 or 90 days.", "The three cards at the top give one number each for Burson, the app and the IMs.",
                                                   "Each table lists the measure now, before, and the change."]},
            {"heading": "The four tables", "items": [
                "Burson's alerts, checked by the app: how many were right as sent, fixed by the app, sent back, held for an IM.",
                "The app's own detection against Burson's: posts both found, posts only one found. Needs in-house detection running.",
                "The IMs against the app: how often IM assessments agreed, verdicts overridden, app fixes undone, held alerts sent on or back.",
                "Speed: post to alert, the app's check, Burson's fix after a send-back, alert to email, SLA."]},
            {"heading": "Where the numbers come from", "text": "IM agreement counts the assessments IMs record in the Review Feed (Agree or Disagree). The rest is counted from the event log."},
        ],
    },
    {
        "id": "integrations", "page": "Integrations", "title": "Integrations", "audience": "admins",
        "summary": "Every tool the agent uses, connected in one place.",
        "sections": [
            {"heading": "Set everything up", "steps": [
                "Open Integrations.",
                "Click Set up. It fills what the project already has (the project, region, this Console's address, the deployed agent, the app's dataset) "
                "and the temp check app's setup: its five tables of posts and its Brandwatch values. Nothing already set is changed.",
                "It then creates the app's own tables if they are missing, and checks every tool that has its values.",
                "Read Left to do. Each line names a tool and what it still needs. Click the tool's name to open it.",
                "Copy each statement under Send to the owners of the data and send it to the people who own that dataset. Each one says which table it is for.",
                "Click Set up again when something has changed. It is safe to press as often as you like."]},
            {"heading": "Sign in as the QA chatbot", "steps": [
                "Open Integrations, then Google Chat.",
                "Enter the QA chatbot's account (the Google account it reads and posts as) and Save.",
                "Click Sign in as the QA chatbot. At Google, choose that account and leave every box ticked.",
                "Click Check now. Each space shows its latest message and whether people outside Google can join it.",
                "A space that says Add the account to this space: add it in Chat, then check again."]},
            {"heading": "BigQuery", "items": [
                "One tile holds the app's own dataset and every table the app reads.",
                "The app's own dataset is the only place it creates anything. Every other table is only read.",
                "Each table is listed once with what reads it. A table used in several places is one row: change it there and it changes everywhere.",
                "For a table of posts, tick what reads it: Temp checks, Early Detection, Watches.",
                "You never type a location. The check reads where each table lives and sets it.",
                "Check now asks each table for a day of posts, which costs nothing.",
                "Waiting for access: the table's owners have not let the Console read it yet. Nothing fails over it. Every feature skips that table, "
                "reads the rest, and reads it by itself once access arrives. Leave it in the list.",
                "Add a table of posts, or change how one is read, under Settings, Temp check."]},
            {"heading": "What a tile says", "items": [
                "Connected: its values are set and the last check passed.",
                "Connected, 1 waiting: BigQuery works, and that many tables wait for their owners to let the Console read them.",
                "Set, not checked: its values are set. Run the check.",
                "Needs values: something required is empty.",
                "Check failed: the last check found a problem. Open the tile for the fix.",
                "2 tables not readable: BigQuery itself works, and that many tables it reads need access or a correction.",
                "Not connected: an optional tool nobody has set up."]},
            {"heading": "When a table is waiting for access", "steps": [
                "Open Integrations, BigQuery, Check access. Each statement under Send to the owners of the data names the tables it is for.",
                "A dataset in your own project: run its statement by itself in BigQuery.",
                "A dataset in another project: send its statement to that dataset's owners.",
                "Check again once it has run. Until then the app skips that table.",
                "BigQuery answers the same way for a table that does not exist, so check the table's name too."]},
            {"heading": "Disconnect", "text": "Optional tools can be disconnected: their values go back to the defaults. Tools the agent needs cannot be disconnected, only changed."},
        ],
    },
    {
        "id": "routing", "page": "Routing", "title": "Routing: which space is read, copied and written", "audience": "admins",
        "summary": "Set the space the QA chatbot reads, the spaces it copies to, and whether it may write back.",
        "sections": [
            {"heading": "Set it up", "steps": [
                "Sign the QA chatbot in under Integrations, Google Chat, and add its account to each space.",
                "Open Routing.",
                "Paste the source space's link: Burson's space, or any other.",
                "Paste the second space's link. It gets every message from the source, in the same order.",
                "Optional: paste a third space's link. It gets everything that reached the second space.",
                "Turn QA chatbot ON and press Save. Copying starts from the last 15 minutes."]},
            {"heading": "When the QA chatbot writes in the source space", "items": [
                "Safety valve ON: never. The second and third spaces still get every message.",
                "Safety valve OFF and a second space set: never. Its work goes to the copy spaces.",
                "Safety valve OFF and no second space: fully open. It reads and writes in the source space.",
                "Ask before each post to the source, ON: each message waits under Waiting for Send until someone presses Send or Skip.",
                "A space people outside Google can join is never written, unless it is the source and the source is open."]},
            {"heading": "What is copied", "items": [
                "Alerts: an exact copy, without the credit line the sending app adds.",
                "With Copy replies and emojis too ON: replies under the matching message, people's messages, and each emoji once.",
                "Never copied: the QA chatbot's own posts, another app's replies in a thread, edits, deletions and removed emojis.",
                "A message that fails holds the ones behind it, so nothing arrives out of order. After five tries it is given up on and its row says why."]},
            {"heading": "Reviewing alerts read from Chat", "items": [
                "Turn on Review alerts read from Chat under Settings, Switches. With the QA chatbot ON and a source space set, each new message there is read within a minute and reviewed, with no Chat flow in between.",
                "The Reviewed list shows each message, what the review made of it, its case, and how many posts it queued. A person's message is set aside as not an alert. The QA chatbot's own posts are never read.",
                "What the review wants posted is queued. It is posted when Post queued messages in Chat is ON (the next section); otherwise it waits for a Chat flow.",
                "A message whose review fails is tried again each minute and given up after five tries. Its row says why. It does not hold the messages behind it.",
                "Reading starts from the last 15 minutes when the switch goes ON or the source space changes."]},
            {"heading": "Answering mentions in Chat", "items": [
                "Turn on Answer mentions in Chat under Settings, Switches. With the QA chatbot ON, a message that mentions it is answered within a minute, in that message's thread, with no Chat flow in between.",
                "It reads the source, second and third spaces. Under Answered, tick any of the agent's other spaces to read them too.",
                "A mention is the QA chatbot's account picked from Chat's @ list, or @ and the agent's name typed out. Apps and the QA chatbot's own posts are never answered.",
                "The Answered list shows each mention, who asked, and the reply. Queued means the reply waits for Send or for Post queued messages in Chat. Held means a rule said no; its row says why.",
                "In the source space the reply follows the rules at the top of this page. While that space is closed, the reply is shown in the second space under the alert's copy.",
                "Who asked is matched from the rosters and the people under Settings. Someone not on them is still answered.",
                "A reply Chat does not take is tried again each minute and given up after five tries. Its row says why."]},
            {"heading": "Posting queued messages in Chat", "items": [
                "Turn on Post queued messages in Chat under Settings, Switches. With the QA chatbot ON, each queued message is posted within a minute, once, as the QA chatbot's account, with no Chat flow in between.",
                "With Retry posts that fail ON too, each message goes through Google Pub/Sub and is posted as soon as it is queued. Pub/Sub tries a failed one again and sets it aside after the last try (Settings, Delivery); the minute run still posts whatever is left.",
                "The Posted list shows each one: where it went and whether it was posted, held, or is being tried again.",
                "Held means a rule said no and it is not posted, now or later: the source space is not open, the message names something internal, the target is not allowed, or the space is open to people outside Google and is not the source space.",
                "With Ask before each post to the source ON, a message for the source space moves to Waiting for Send.",
                "A direct message goes to each person in the direct message they already have with the QA chatbot. A person with none yet messages it once in Chat. While Testing is ON, only the testing recipients get direct messages.",
                "A message Chat does not take is tried again each minute and given up after five tries. Its row says why and has Try again.",
                "Messages queued more than 15 minutes before the switch went ON are not posted late.",
                "The handover doc is not a Chat message: it still needs a Chat flow."]},
            {"heading": "Names", "text": "Chat gives the QA chatbot each person's id and no name. Under People seen in the source space, type the name once and mark Burson or Google. Their copied messages then read Name (Burson): text."},
            {"heading": "A copy space is refused when", "items": [
                "It is the source space.", "People outside Google can join it.", "The second and third space are the same space.",
                "The QA chatbot's account is not in it."]},
        ],
    },
    {
        "id": "early-detection", "page": "Early Detection", "title": "Early Detection", "audience": "everyone",
        "summary": "Posts on one theme from small accounts, grouped into a story before anyone raises an alert.",
        "sections": [
            {"heading": "Work a story", "steps": [
                "Open Early Detection. New holds the stories Gemini has written up.",
                "Read the headline, the call (Escalate or Monitor) and the posts.",
                "Size it with a temp check when you need numbers.",
                "Press Escalate, Acknowledge or Dismiss. Add a note when it helps. Each step is on the record."]},
            {"heading": "How a story is made", "items": [
                "Every 15 minutes BigQuery reads the new posts of the tables named in Settings, Early Detection.",
                "Only small accounts are read: 5,000 followers or fewer, under 500 engagements, 40 characters or more, posted in the last 24 hours.",
                "Vertex AI turns each post into an embedding inside BigQuery. A post joins the nearest story, or starts one with its closest posts when two or more accounts are among them.",
                "A story is raised at 5 separate accounts (4 on two platforms) and 2 posts within 3 hours.",
                "A story already raised goes out again only as an Update: twice the accounts and three more, or a new platform."]},
            {"heading": "Scoring with Gemini Decisions", "text": "With the switch Score early stories with Gemini Decisions ON, each raised story is scored first. Plain noise goes to Held back. A small story (3 accounts) that scores high is raised as an Early signal. The most severe are written up first."},
            {"heading": "The tabs", "items": [
                "New: written up, waiting for a person.", "Waiting for write-up: raised, Gemini has not written it up yet.",
                "Acted on: acknowledged or escalated.", "Held back: Gemini Decisions scored it as noise, with the reason.",
                "Dismissed: Gemini or a person dismissed it. Move back to New undoes it."]},
            {"heading": "Turn it on", "steps": [
                "Settings, Early Detection: name the post tables under sources (their keys from Settings, Temp check, sources).",
                "Settings, Switches: turn on Change BigQuery from here once, so its three tables can be created.",
                "Settings, Switches: turn on Early Detection.",
                "Open AI and press Check now on Vertex AI in BigQuery. Every statement is checked against the real tables."]},
        ],
    },
    {
        "id": "agent-alerts", "page": "Agent alerts", "title": "Agent alerts", "audience": "everyone",
        "summary": "Alerts the agent raises itself from the sources it reads, reviewed before anyone is told.",
        "sections": [
            {"heading": "Work an alert", "steps": [
                "Open the Review feed, Agent alerts. To judge holds what the review raised and nobody has judged yet; Raised holds all of them, newest first.",
                "Read the severity, who it goes to, the evidence and the reason. Open the post from its link.",
                "Press Confirm when the alert was right, False positive when it was not. A verdict can be changed.",
                "In Chat, the Confirm and False positive links on an alert open it in the Review feed and record the verdict."]},
            {"heading": "How an alert is made", "items": [
                "Every few minutes each source hands over its new posts: the tables ticked for Agent alerts on Integrations, the Brandwatch queries, and the Other alerts space.",
                "Personal details are taken out of each post before it is kept: handles, emails, phone numbers and links by pattern, then names by Google's Sensitive Data Protection. Nothing is kept while that check cannot be reached.",
                "A post's link and, for a KOF, the name shown are kept apart in a vault no model reads. They are put back on the alert after the review.",
                "Each post is checked against the rules. A mandatory rule sends it straight to review. Any other rule has Gemini read the post first.",
                "Posts no rule covers are grouped into stories in BigQuery. Gemini reads a story that is growing fast enough.",
                "The review decides: raise or pass over, a severity, and who it goes to. It cannot overrule a mandatory rule.",
                "A raised story that keeps growing is reviewed once more.",
                "Posts, links and names are deleted after 30 days at most.",
                "Our own alerts is a different page: it takes alerts the team already chose from the team's own tables."]},
            {"heading": "Rules", "steps": [
                "Open Settings, Rules, and press Add a rule. Leads and admins can.",
                "Name the rule and say where it is in the process document.",
                "Choose Mandatory (a matching post is always raised) or Candidate (Gemini reads the post first).",
                "Give it at least one condition: words, a KOF author, followers, engagements, a source or a platform.",
                "Set a severity and who it goes to, or leave both for the review.",
                "Save. The rule applies from the next run."]},
            {"heading": "Where things are", "items": [
                "Review feed, Agent alerts, To judge and Raised: the alerts, with each verdict.",
                "Review feed, Agent alerts, Not raised: what Gemini looked at and decided not to raise, and why. A record only: nothing is asked of anyone.",
                "Settings, Sources: each source, when it was last read, and how many posts were kept. Run now is there too.",
                "Settings, Rules: what each new post is checked against.",
                "Settings, Reading and review: how often it reads, the KOF sheet, the models, and the space raised alerts are posted in."]},
            {"heading": "When something goes wrong", "items": [
                "A box on Settings, Sources says what happened and what to do, in plain words. Blue means nothing is broken: the agent is waiting, or something needs setting. Red means a person should look.",
                "A problem in the agent's own check: press Run now. If it keeps failing, tell an admin.",
                "A table the Console may not read: its owners let the Console's account in. The statement to send them is under Integrations, BigQuery. Nothing fails over it meanwhile.",
                "Google Cloud busy or slow: wait a few minutes. Nothing is lost; the agent tries again on its own.",
                "Admins see Google's own words under Technical details, to send on to whoever looks after the Console.",
                "After an update to the Console the agent remakes its tables and checks in BigQuery on its next run, while Change BigQuery from here is on."]},
            {"heading": "Turn it on", "steps": [
                "Open Integrations and press Find and fill. It adds the two tables only Agent alerts read, and ticks the tables it reads.",
                "Open Settings, Reading and review. Enter the KOF sheet's link, and share that sheet (Viewer) with the service's account. The deploy fills the BigQuery connection and the salt's secret: enter them only if they are blank. Add the Brandwatch queries and the Other alerts space if you use them.",
                "Open Settings, Switches and turn on Change BigQuery from here. Then open Settings, Sources and press Do it now.",
                "Open Settings, Rules, and add your rules.",
                "Open Settings, Switches and turn on Agent alerts.",
                "Open Settings, Sources and press Run now. The list shows what each source handed over. A source that could not be read says why.",
                "To post in Chat: choose the space under Settings, Reading and review, then turn on Post agent alerts in Chat. An alert is never posted in the source space."]},
        ],
    },
    {
        "id": "ai", "page": "AI", "title": "AI: three engines, one job each", "audience": "admins",
        "summary": "What each AI engine does here, whether it is connected, and a live check of each.",
        "sections": [
            {"heading": "The engines", "items": [
                "Gemini talks with people: the Console chat agent, the QA chatbot's replies, alert write-ups and each early story's headline and call.",
                "Gemini Decisions decides: it answers set questions with probabilities and writes no text. It picks an alert's class and scores early stories.",
                "Vertex AI in BigQuery reads the post tables: Early Detection's embeddings and grouping, and the Watches' questions and scores, run next to the data.",
                "Document search finds the passages of your Knowledge documents that bear on a question, so Gemini answers company questions from them and cites them."]},
            {"heading": "Connect Gemini Decisions", "steps": [
                "Put the Gemini API key in a secret in Secret Manager (or under Settings, Secrets).",
                "Settings, Gemini Decisions: enter the secret's name under secret and Save.",
                "Open AI and press Check now on Gemini Decisions.",
                "Settings, Switches: turn on Gemini Decisions sorts alerts, and Score early stories with Gemini Decisions."]},
            {"heading": "When Gemini Decisions fails", "text": "It is never asked twice. After a failure no call is made for 15 minutes and work goes on without it: Gemini picks the class, and every raised story goes to its write-up. The card shows the pause and the reason."},
            {"heading": "Check now", "items": [
                "Nothing is sent to a model as a test. Each check reads what the real work left behind.",
                "Gemini: each model's real calls in the last 24 hours, and the latest failure when there is one.",
                "Gemini Decisions: how often it was asked today, how often it failed, and a pause with its reason.",
                "Vertex AI in BigQuery: each Early Detection statement is checked by BigQuery against the real tables without running, and the last real read of each table is shown. A failing line shows BigQuery's own reason. A table waiting for access is marked and does not fail the check.",
                "Document search: how many documents and passages are kept, and how many are embedded."]},
            {"heading": "No model is asked for a number", "items": [
                "Gemini judges and writes. It is never asked how sure it is: a number a model writes about itself is not a measurement.",
                "A fix Gemini proposes is applied without a person only when Gemini Decisions puts the chance it is right at the bar in Settings. With no answer, the fix waits for a person.",
                "Everything else shown as a number is counted: Burson's fields right, how often incident managers kept a value, temp check volumes, the staffing forecast."]},
        ],
    },
    {
        "id": "admin", "page": "Admin", "title": "Admin", "audience": "leads",
        "summary": "People and roles, system status, and recent changes.",
        "sections": [
            {"heading": "Add a person", "steps": ["Open Admin → People.", "Click Add a person.", "Enter their email and name, pick a role, and choose whether they are on the IM roster.", "Save.",
                                                  "They can sign in at once. Give them shifts under Workforce."]},
            {"heading": "Roles", "items": ["Admin: changes settings, integrations and people.", "Lead: sees Admin; works alerts.",
                                            "Incident Manager or Analyst: works alerts.", "Viewer: reads the Console. Anyone signed in at a viewer domain is a viewer."]},
            {"heading": "Remove a person", "steps": ["Click Change on their row, then Remove this person.", "Someone holding shifts is moved off them in Workforce first.",
                                                     "The last admin cannot be removed."]},
            {"heading": "System", "items": [
                "Integrations: how many needed tools are set.", "Scheduled work: when the once-a-minute run last ran, and any part that failed.",
                "The agent, Delivery, Safety, BigQuery, Switches: their state, with a link to each.", "A card with a gradient edge needs attention."]},
            {"heading": "Changes", "text": "Every change to settings, integrations and people in the last 7 days, and who has been active."},
        ],
    },
    {
        "id": "settings", "page": "Settings", "title": "Settings", "audience": "admins",
        "summary": "Tuning values. Every one has a working default; change one only when you need to.",
        "sections": [
            {"heading": "What to fill in", "steps": [
                "Open Integrations and click Set up. It fills what the project already has and checks each tool.",
                "Do what Left to do lists.",
                "Add people under Admin → People.",
                "Turn on the features you want under Settings → Switches.",
                "Nothing else is required."]},
            {"heading": "Change a setting", "steps": ["Open Settings, then Advanced, and pick a section. Find a setting filters the list.", "Edit the fields.",
                                                      "Save. A note is optional and is kept in the history.", "Reset returns a section to its defaults."]},
            {"heading": "Sections", "items": [
                "Platform: switches, access, project, safety, delivery, BigQuery, forecasting, chat agent, classification, knowledge retrieval, temp check, campaigns & watches, costs, telemetry, stories, notifications, usage tracking.",
                "Usage tracking: a Google Tag Manager container (GTM-XXXXXXX) that counts which work pages are opened. Blank, the default, tracks nothing. "
                "It is told a page's name and kind only: never an alert's number or text, a search, or who is signed in. Settings, People, Integrations, "
                "Routing and AI are not counted, and time spent on a page is not measured. It applies the next time each person loads the Console.",
                "Agent: spaces, analysts & roles, shifts, distribution and recipients, actions, taxonomy and the rest. Rosters opens the Rosters page.",
                "Tools: secrets & credentials, AI instructions, audit log, change history.",
                "The values that connect a tool (project, dataset, topics, spaces) are set under Integrations and show here too.",
                "Switches: what the agent may do. All start OFF.",
                "What the chatbot alerts on: Sources (where it reads posts, and Run now), Rules (what a post must say, or who must post it, for an alert to be "
                "raised) and Reading and review (how often it reads, the models, and where a raised alert is posted)."]},
            {"heading": "History", "text": "Every change is listed with who made it and what changed, under Change history and in the audit log."},
        ],
    },
    {
        "id": "feature-flags", "page": "Settings", "title": "Switches", "audience": "admins",
        "summary": "Switches for what the agent and the Console may do. Every switch starts OFF.",
        "sections": [
            {"heading": "Turn a switch on", "steps": ["Open Settings → Switches.", "Read what the switch does.", "Turn it on and Save."]},
            {"heading": "Before turning on", "items": [
                "Knowledge retrieval and the classification layer: add documents first.",
                "Pub/Sub delivery: set the topics under Delivery and click Create what is missing.",
                "Temp checks: set Brandwatch and the post tables.", "Forecasting: connect BigQuery and map the events table.",
                "Alert pop-ups: none. Each person can mute them from the bell at the top.",
                "BigQuery admin and Secret admin: turn on only while you make changes."]},
        ],
    },
    {
        "id": "secrets", "page": "Settings", "title": "Secrets & credentials", "audience": "admins",
        "summary": "Add and rotate secrets. Values are never shown.",
        "sections": [
            {"heading": "Add a secret", "steps": ["Turn on Settings, Switches: Add secrets from here.", "Open Settings → Secrets.", "Click New secret, give the name and the value, Save.",
                                                  "Enter the secret's name in the setting that uses it (for example Temp check → Brandwatch token secret)."]},
            {"heading": "Rotate", "steps": ["Open the secret.", "Click New value and enter it.", "Disable the old version once the new one works."]},
            {"heading": "Gmail", "text": "IMs connect their own Gmail from the top bar. Their tokens are kept as secrets and are listed here by a hashed name."},
        ],
    },
    {
        "id": "bigquery", "page": "Settings", "title": "BigQuery", "audience": "admins",
        "summary": "Connect, create the agent's tables, and manage datasets, tables and views.",
        "sections": [
            {"heading": "Connect", "steps": ["Open Settings → BigQuery.", "Enter the project, location and the agent's dataset. Save.", "The banner shows whether it connected and the identity queries run as."]},
            {"heading": "Create the agent's tables", "steps": ["Turn on Settings, Switches: Change BigQuery from here.", "Click Create and map.", "The tables for events, forecasts and checked examples are created."]},
            {"heading": "Map tables", "text": "Mapping says which table holds what. Events is required for long dashboard ranges and the forecast."},
            {"heading": "Edit schemas and views", "steps": ["Open a dataset, then a table.", "Add columns or edit descriptions and Save. Existing columns can't change type.", "For a view, edit the SQL and Save. A view that doesn't compile is refused."]},
            {"heading": "Limits", "text": "The Console only changes datasets listed under Datasets the Console may change, and the agent's own dataset."},
        ],
    },
    {
        "id": "delivery", "page": "Settings", "title": "Delivery and posts that fail", "audience": "admins",
        "summary": "How posts reach Chat, retries, and what to do when a delivery fails.",
        "sections": [
            {"heading": "How it works", "text": "The agent gets a post ready, Chat is told one is waiting, and the Chat flow posts it. With the switch Retry posts that fail ON, a post that fails is tried again, and set aside after the last try so a person can look at it."},
            {"heading": "Set up", "steps": ["Open Settings → Delivery.", "Enter the topic and subscription names, the worker URL and the push service account. Save.",
                                            "Click Create what is missing.", "Turn on Settings, Switches: Retry posts that fail."]},
            {"heading": "A post that could not be delivered", "steps": ["Open Settings → Delivery.", "Read the error under Posts that could not be delivered.", "Fix the cause, then Replay. Discard closes it with a reason."]},
        ],
    },
    {
        "id": "ai-behavior", "page": "Settings", "title": "AI instructions and models", "audience": "admins",
        "summary": "Edit and version what Gemini is told for each task.",
        "sections": [
            {"heading": "Change instructions", "steps": [
                "Open Settings → AI instructions and pick a task.", "Read the built-in instructions.",
                "Write the new version. Put {{default}} where the built-in text should stay, then add your rules after it.",
                "Optionally pick a model from the list, or set a temperature, for that task.", "Publish. The new version is used from the next call."]},
            {"heading": "Roll back", "steps": ["Open the task.", "Click Use this on an earlier version, or Use built-in."]},
            {"heading": "Models", "text": "Every model setting is a list of the Gemini models this Google Cloud project can use, each with a line on what it is "
                                          "like. The first choice, Use the default, names the model the default uses; Other lets you type a name. The "
                                          "defaults for triage, drafting and conversation are under Settings, Gemini models."},
        ],
    },
    {
        "id": "safety", "page": "Settings", "title": "Safety", "audience": "admins",
        "summary": "Leak guard, Testing mode, allow-lists and the runtime checks.",
        "sections": [
            {"heading": "Runtime checks", "steps": ["Open Settings → Safety.", "Each check shows Passed or what to fix.", "A failed blocker stops outbound delivery until it passes."]},
            {"heading": "Testing mode", "steps": ["Turn Testing on.", "Enter up to 5 testing recipients.", "Every draft goes only to them. With none entered, drafts have no recipients."]},
            {"heading": "External spaces", "text": "List every space people outside the company can read. Everything bound for them passes the leak guard; a message that names internal things is held and listed here."},
            {"heading": "Allow-lists", "items": ["Post targets: the agent posts only to listed targets.", "Recipient domains: drafts only go to listed domains."]},
        ],
    },
    {
        "id": "audit", "page": "Settings", "title": "Audit log", "audience": "admins",
        "summary": "Who did what, from Chat or the Console.",
        "sections": [
            {"heading": "Search", "steps": ["Open Settings → Audit log.", "Filter by person, surface (Console, chat agent, Chat, jobs), status or case.", "Export CSV downloads the filtered log."]},
            {"heading": "What is recorded", "items": ["Every operation the agent ran and who started it.", "Every change made in the Console.",
                                                      "Every tool the chat agent used.", "Messages held by a safety check.", "Deliveries that were dead-lettered, replayed or discarded."]},
        ],
    },
    {
        "id": "costs", "page": "Settings", "title": "Costs", "audience": "admins",
        "summary": "AI usage and service cost.",
        "sections": [
            {"heading": "AI usage", "steps": ["Open Settings → Costs.", "Calls and tokens are shown by task and by model.", "Enter each model's price per million tokens to see cost."]},
            {"heading": "Service cost", "text": "Enter the billing export table to see cost by service and by day."},
        ],
    },
    {
        "id": "velocity", "page": "Post velocity", "title": "Post velocity & 7-day curves", "audience": "analysts",
        "summary": "Live engagement velocity (T+0 to T+168h), peak hourly spikes, side-by-side post comparisons and spike alerts.",
        "sections": [
            {"heading": "Check a post", "steps": ["Open Post velocity under Look into, or click Check velocity on any alert in Review feed, Cases, Stories, Early Detection or Temp check.",
                                                  "Paste an X (x.com) or Bluesky (bsky.app) post link and press Track post.",
                                                  "Click any row to view its 7-day curve (Hourly velocity, Cumulative engagements, or Reposts & replies)."]},
            {"heading": "Compare posts", "text": "Tick Compare on 2 to 6 posts to overlay their curves from the hour each post was published (T+0h to T+168h), even if they went live on different days."},
            {"heading": "Spike alerts", "text": "Press Watch on a post to be notified when it crosses into Growing (+1,000 or 1.35x baseline) or Surging (+10,000 or 5x). Turn on Post velocity polling & spike alerts under Settings → Switches to enable automatic background polling."},
        ],
    },
    {
        "id": "deploy", "page": "Start", "title": "Deploy and connect", "audience": "admins",
        "summary": "From an empty project to a working Console.",
        "sections": [
            {"heading": "Deploy", "steps": ["Run infra/deploy.sh with the project and region.", "It enables the APIs, creates the service accounts, deploys the Console, the worker and the agent, and prints the Console link.",
                                            "You are the first admin."]},
            {"heading": "Then, in the Console", "steps": ["Follow the checklist on the Dashboard: admins, agent account, spaces, roster, distribution, safety, BigQuery, delivery, knowledge, switches."]},
        ],
    },
]


def topics() -> list[dict[str, Any]]:
    return TOPICS
