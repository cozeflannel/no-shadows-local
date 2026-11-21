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
                "No access: ask an admin to add you under Settings → Analysts & roles, or to the IM roster."]},
            {"heading": "Where to work", "items": [
                "Dashboard: what is happening now and over a period.",
                "Review Feed: every alert, what the agent decided, and the actions you can take.",
                "Chat agent: ask the agent, or have it do the work for you.",
                "Chat spaces: everything said to and by the agent in Chat.",
                "Temp check: a quick snapshot of an emerging issue.",
                "Workforce: who is on, the schedule, the forecast.",
                "Knowledge: the documents the agent reads.",
                "Campaigns & Watches: Brandwatch campaigns and early-warning watches.",
                "Settings: everything the agent is configured with (admins)."]},
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
                "Verdict and confidence: the agent's decision and how sure it was.",
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
                "Your assessment is kept as a golden example."]},
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
                "Returned: a post the agent handed back to the Studio flow to post.",
                "Queued: waiting in the outbox for the Outbox flow.", "Delivered: handed to the Outbox flow.",
                "Held: stopped by a safety check. See Settings → Safety."]},
            {"heading": "Limits", "text": "The agent has no Chat API. It sees what the Studio flows hand it: alerts in the alert space, reactions on its posts, mentions and direct messages. Other messages in a space are not tracked."},
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
                "Actions need the analyst role and the chat agent's action switch (Feature flags → console_chat_agent)."]},
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
            {"heading": "Run one", "steps": [
                "Name the issue under Run one.",
                "Choose Boolean, Saved query or Draft it for me.",
                "With a Boolean, the page shows how many terms it understood and what it left out as you type.",
                "Click Run temp check. The result opens when it is ready."]},
            {"heading": "Read the result", "items": [
                "Write-up: the team's template. Copy it as text.", "Numbers: posts an hour, velocity since the peak, share negative, where the posts are.",
                "Posts: the posts read, most engagement first.",
                "Concern level: the issue ranked against past issues at the same hours in. It needs enough past issues to compare."]},
            {"heading": "Act on it", "steps": ["Mark as used, or Dismiss.", "Run again makes an update that reports what is new since the last one.",
                                              "Keep refreshed (hours), set when you run it, repeats the check until that time passes."]},
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
        "summary": "The documents the agent reads, the classification mapping and the golden set.",
        "sections": [
            {"heading": "Add a document", "steps": [
                "Click Add a document.", "Choose Text (paste it), Web page (a public link) or Drive (a Docs, Sheets or Slides link).",
                "Say what it covers. Add tags.", "Mark Guidance if it should outrank other documents.",
                "Tick May be quoted in the Burson space only if it may be used in answers there.", "Save. Status shows Ready, or what to fix."]},
            {"heading": "Drive documents", "text": "Share the file with the agent's service account (Viewer). PDFs and Office files can't be read: save them as Google Docs first."},
            {"heading": "Map classes to documents", "steps": [
                "Open Classes.", "Each class lists the documents it reads.",
                "Tie a document to a class on the document itself (Classes), or give the class tags under Settings → Classification."]},
            {"heading": "Try retrieval", "steps": ["Open Try a search.", "Type a question or paste an alert.", "The passages the agent would read are listed with their scores."]},
            {"heading": "Golden set", "items": ["Every alert an IM confirmed or corrected is kept as a labelled example.", "Export downloads them in the eval harness's format."]},
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
            {"heading": "Parity", "text": "Parity compares in-house alerts with Burson's for the same post."},
        ],
    },
    {
        "id": "settings", "page": "Settings", "title": "Settings", "audience": "admins",
        "summary": "Everything the agent is configured with. Changes apply to the next alert.",
        "sections": [
            {"heading": "Change a setting", "steps": ["Open Settings and pick a section on the left.", "Edit the fields.", "Save. A note is optional and is kept in the history.",
                                                      "Reset returns a section to its defaults."]},
            {"heading": "Sections", "items": [
                "Platform: feature flags, access, project, safety, delivery, BigQuery, forecasting, chat agent, classification, knowledge retrieval, temp check, campaigns & watches, costs, telemetry.",
                "Agent: spaces, analysts & roles, shifts, distribution and recipients, actions, taxonomy and the rest. Rosters opens the Rosters page.",
                "Tools: secrets & credentials, AI instructions, audit log, change history.",
                "BigQuery, Delivery, Safety, Costs and Project show their own panel under the form: tables and views, topics and dead letters, runtime checks, usage, the deployed agent.",
                "Feature flags: what the agent may do. All start OFF."]},
            {"heading": "History", "text": "Every change is listed with who made it and what changed, under Change history and in the audit log."},
        ],
    },
    {
        "id": "feature-flags", "page": "Settings", "title": "Feature flags", "audience": "admins",
        "summary": "Switches for what the agent and the Console may do. Every switch starts OFF.",
        "sections": [
            {"heading": "Turn a switch on", "steps": ["Open Settings → Feature flags.", "Read what the switch does.", "Turn it on and Save."]},
            {"heading": "Before turning on", "items": [
                "Knowledge retrieval and the classification layer: add documents first.",
                "Pub/Sub delivery: set the topics under Delivery and click Create what is missing.",
                "Temp checks: set Brandwatch and the post tables.", "Forecasting: connect BigQuery and map the events table.",
                "BigQuery admin and Secret admin: turn on only while you make changes."]},
        ],
    },
    {
        "id": "secrets", "page": "Settings", "title": "Secrets & credentials", "audience": "admins",
        "summary": "Add and rotate secrets. Values are never shown.",
        "sections": [
            {"heading": "Add a secret", "steps": ["Turn on Feature flags → secret_admin.", "Open Settings → Secrets.", "Click New secret, give the name and the value, Save.",
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
            {"heading": "Create the agent's tables", "steps": ["Turn on Feature flags → bigquery_admin.", "Click Create and map.", "The events, forecasts and golden tables are created and mapped."]},
            {"heading": "Map tables", "text": "Mapping says which table holds what. Events is required for long dashboard ranges and the forecast."},
            {"heading": "Edit schemas and views", "steps": ["Open a dataset, then a table.", "Add columns or edit descriptions and Save. Existing columns can't change type.", "For a view, edit the SQL and Save. A view that doesn't compile is refused."]},
            {"heading": "Limits", "text": "The Console only changes datasets listed under Datasets the Console may change, and the agent's own dataset."},
        ],
    },
    {
        "id": "delivery", "page": "Settings", "title": "Delivery and dead letters", "audience": "admins",
        "summary": "How posts reach Chat, retries, and what to do when a delivery fails.",
        "sections": [
            {"heading": "How it works", "text": "The agent queues a post, publishes an action to Pub/Sub, and the worker rings the doorbell that starts the Studio Outbox flow. A delivery that keeps failing goes to the dead-letter topic."},
            {"heading": "Set up", "steps": ["Open Settings → Delivery.", "Enter the topic and subscription names, the worker URL and the push service account. Save.",
                                            "Click Create what is missing.", "Turn on Feature flags → pubsub_delivery."]},
            {"heading": "Dead letters", "steps": ["Open Settings → Delivery → Dead letters.", "Read the error.", "Fix the cause, then Replay. Discard closes it with a reason."]},
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
