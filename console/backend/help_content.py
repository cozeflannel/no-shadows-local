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
        ],
    },
    {
        "id": "dashboard", "page": "Dashboard", "title": "Dashboard", "audience": "everyone",
        "summary": "Live numbers, charts and a feed you can act from.",
        "sections": [
            {"heading": "Pick a period", "steps": [
                "Use the range buttons: Hour, Today, 24 h, 7 days, 30 days or Custom.",
                "Custom: set the start and the end. The numbers update at once.",
                "Each card shows the change against the period before it."]},
            {"heading": "Read the cards", "items": [
                "Needs you now: alerts waiting for review, unacknowledged alerts, SLAs at risk. Click a card to open the Review Feed.",
                "Alerts received, first-pass yield, auto-fix rate, SLA met: definitions are under each card's info icon.",
                "Time saved uses the minutes set under Settings → Metrics."]},
            {"heading": "Act from the live feed", "steps": [
                "The feed updates as events arrive (the dot is green while live).",
                "Click an item to open its alert.",
                "Items marked Review, Acknowledge or SLA need a person."]},
        ],
    },
    {
        "id": "review-feed", "page": "Review Feed", "title": "Review Feed", "audience": "IMs",
        "summary": "Work alerts: see the agent's call, decide, escalate, assess.",
        "sections": [
            {"heading": "Find an alert", "steps": [
                "Needs action shows what is waiting for a person, most urgent first.",
                "Switch the view: Review, Verified, Suppressed, Closed or All.",
                "Search by case id, product, tag or issue."]},
            {"heading": "Read a card", "items": [
                "Verdict: the agent's decision.",
                "Burson 3 of 5 right (60%): of the fields Burson filled in, how many stood up to the checks. Counted, not estimated.",
                "72% likely to need a person: Gemini Decisions' probability, shown when the switch Gemini Decisions scores each alert is ON.",
                "Kept 47 of 50, beside a field: how often incident managers kept the app's value for that field in their own assessments, last 30 days.",
                "Class: the classification layer's class (when that switch is on).",
                "Corrections: what the agent changed, old to new. Proposed corrections wait for you.",
                "Sources: the knowledge passages the assessment cited. Click one to open the document.",
                "Suggested actions: what the routing rules recommend."]},
            {"heading": "Decide an alert held for review", "steps": [
                "Open the alert.", "Tick the proposed corrections to apply, then Apply and forward. Or Send back to Burson, or Suppress.",
                "Send back needs a reason."]},
            {"heading": "Take an action", "steps": [
                "Open the alert and pick an action: Acknowledge, Email (PAs), T&S form, add a team, crisis chat, close, superseded.",
                "A draft lands in your own Gmail. Connect Gmail from the top bar first."]},
            {"heading": "Assess the agent", "steps": [
                "Open the alert and go to Was the agent right?",
                "Click Right. Or pick the correct verdict or write a note, then click Wrong.",
                "Your assessment is kept as a checked example of the right answer."]},
            {"heading": "Add an alert by hand", "steps": ["Click Triage an alert.", "Paste the alert's text.", "It is triaged like any other and gets a case."]},
        ],
    },
    {
        "id": "chat-spaces", "page": "Chat spaces", "title": "Chat spaces", "audience": "everyone",
        "summary": "Everything the agent received from Chat and posted back.",
        "sections": [
            {"heading": "Browse", "steps": [
                "Click a space's card to see only that space. Counts are for the period shown.",
                "Messages are grouped by thread, newest first.",
                "Filter by direction (received or posted), or search the text."]},
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
            {"heading": "Map classes to documents", "steps": [
                "Open Classes.", "Each class lists the documents it reads.",
                "Tie a document to a class on the document itself (Classes), or give the class tags under Settings → Classification."]},
            {"heading": "Try retrieval", "steps": ["Open Try a search.", "Type a question or paste an alert.", "The passages the agent would read are listed with their scores."]},
            {"heading": "Checked examples", "items": ["Every alert an IM confirmed or corrected is kept as an example of the right answer.", "Export downloads them as a file used to test the agent."]},
            {"heading": "Learning", "text": "Facts taught in Chat and proposed configuration changes wait under Proposed rules and facts."},
        ],
    },
    {
        "id": "campaigns", "page": "Campaigns & Watches", "title": "Campaigns & Watches", "audience": "leads",
        "summary": "Brandwatch alert campaigns and early-warning watches.",
        "sections": [
            {"heading": "Campaigns", "items": [
                "Each campaign shows its status, query, alert, space, threshold, cap and today's counts.",
                "Change a campaign: click Change, fill in only what should change, Request change. The campaigns service applies it within a minute and writes the result back.",
                "End now closes the campaign."]},
            {"heading": "Add a watch", "steps": [
                "Open Watches and click New watch.", "Name it.", "Write what to look for as a yes/no question.",
                "Write how to score impact from 1 to 10.", "List topics. Set the bar (the score that flags).", "Save, then turn it On."]},
            {"heading": "Read detections", "items": [
                "At the bar: flagged. Near miss: within the near-miss range, kept so you can tune the bar.",
                "Rate each one Useful or Noise.", "Lead shows how long before the alert the watch saw the post."]},
            {"heading": "Scorecard", "text": "For each day: alerts that came in, how many a watch caught, how many it caught first, and the median lead."},
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
                "Color by Activity shows blue for growing, purple for new and grey for quiet instead.",
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
            {"heading": "Watch a story grow", "steps": ["Click Play growth, or drag the time slider.", "Circles grow in place from the start of the window to now.",
                                                         "Use Window to look further back, up to 30 days."]},
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
                "Copy the lines under Send to the owners of the data and send them to the people who own those datasets.",
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
                "Check now asks each table for a day of posts, which costs nothing. A table the Console can't read shows the GRANT line its owners run.",
                "Add a table of posts, or change how one is read, under Settings, Temp check."]},
            {"heading": "What a tile says", "items": [
                "Connected: its values are set and the last check passed.",
                "Set, not checked: its values are set. Run the check.",
                "Needs values: something required is empty.",
                "Check failed: the last check found a problem. Open the tile for the fix.",
                "2 tables not readable: BigQuery itself works, and that many tables it reads need access or a correction.",
                "Not connected: an optional tool nobody has set up."]},
            {"heading": "When access is denied", "text": "The check names the account and the exact grant to run. For a dataset in another project, send that line to the dataset's owners."},
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
            {"heading": "Posting queued messages in Chat", "items": [
                "Turn on Post queued messages in Chat under Settings, Switches. With the QA chatbot ON, each queued message is posted within a minute, once, as the QA chatbot's account, with no Chat flow in between.",
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
                "Vertex AI in BigQuery: each Early Detection statement is checked by BigQuery against the real tables without running, and the last real read of each table is shown. A failing line shows BigQuery's own reason.",
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
                "Platform: switches, access, project, safety, delivery, BigQuery, forecasting, chat agent, classification, knowledge retrieval, temp check, campaigns & watches, costs, telemetry, stories, notifications.",
                "Agent: spaces, analysts & roles, shifts, distribution and recipients, actions, taxonomy and the rest. Rosters opens the Rosters page.",
                "Tools: secrets & credentials, AI instructions, audit log, change history.",
                "The values that connect a tool (project, dataset, topics, spaces) are set under Integrations and show here too.",
                "Switches: what the agent may do. All start OFF."]},
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
                "Optionally set a model or temperature for that task.", "Publish. The new version is used from the next call."]},
            {"heading": "Roll back", "steps": ["Open the task.", "Click Use this on an earlier version, or Use built-in."]},
            {"heading": "Models", "text": "The default models for triage, drafting and conversation are under Settings → Models."},
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
