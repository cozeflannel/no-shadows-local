# Temp check (test app)

A small web app that builds the Brand Safety team's temp check without exporting anything from Brandwatch and
without Apps Script. It exists to answer one question: is that doable? It runs on your own computer, as you.

## Run it

```
gcloud auth application-default login     # once, if you have not already
cd tempcheck-app
node server.js                            # then open http://localhost:8787
node --test                               # the tests (no network)
```

Nothing to install: it needs Node 20 or later and has no dependencies. The chart library (Chart.js) loads in the
page from a CDN; without a connection the write-up still works and the hourly counts are under Numbers.

## What it does

1. **Numbers from Brandwatch's API, no export.** Pick a `[G EVENT]` query. Hourly volume, total, peak and velocity,
   sentiment, sources, mention types and engagement come from Brandwatch's volume endpoints. The only posts read are
   its 25 most-engaged and 15 most-engaged negative ones (reposts excluded), as the chat bot does.
2. **Posts from our own tables.** The query's own Boolean is converted to BigQuery by fixed rules (`lib/bwquery.js`,
   no model involved) and run on every table of posts the chat bot reads (the list is below). The page shows what
   converted, what was approximated, what was left out and why, what each table found, and our count next to
   Brandwatch's.
3. **Your own query.** Type or paste a Brandwatch Boolean, or fill in the filter form (which writes a Boolean for
   you). "Show how the query converts" shows the result and what the search would scan before anything runs.
4. **The write-up** in the team's template, with the hourly chart. Gemini writes the summary, negativity drivers and
   themes from the posts read; every number is computed, never written by the model.
5. **The concern level**, ranked against past issues at the same hours since each started (`lib/benchmark.js`).
6. **History.** Each temp check is kept with everything gathered for it. A later run can reuse the posts and search
   only the time since.
7. **Charts and posts you can open.** The Numbers tab and the "Our data next to Brandwatch" tab draw their numbers as
   charts, with the same numbers in a table underneath. Posts are cards; a card opens the post over the app, with
   the arrow keys stepping through the list and Esc closing it.
8. **No query yet.** For the moment an alert fires: name the issue and give a Boolean (typed, from the filter form,
   or drafted broad by Gemini: you see and can change it). Brandwatch is still asked: its standing Google queries
   (the team's `[V2] MAIN G Landscape` set, which together hold every mention of Google) are searched with that
   Boolean through the API, so the counts, sentiment, sources, mention types and top posts are Brandwatch's own.
   Our tables are searched with the same Boolean alongside. When Brandwatch has nothing for it, or can't be asked,
   the temp check is built from our tables and the write-up says so.

## The tables it searches

| Table | What it holds | How fresh |
|---|---|---|
| Sundar all mentions (`social_alerts_dataset.all_sundar_mentions`) | Brandwatch's alert-feed rows: X (with its words), Instagram, Facebook, Bluesky, Reddit | minutes |
| Sonar (`google_bg.sonar_raw`) | X, YouTube, Bluesky, Instagram, TikTok, Reddit and more | minutes |
| Brandwatch stored mentions (`raw_data.brandwatch_raw_mentions_base`) | news, Reddit, forums, blogs, reviews, Bluesky, Instagram, YouTube, Facebook. Its X rows have no words or author, so they can never match a word | a day's mentions arrive the day after |
| Sprinklr comments (`reporting_data.sprinklr_inbound_comments`) | comments, replies and mentions on Google's own posts and accounts. Google's own posts are left out | minutes |
| Tubular videos (`google_tubular_mentions.tubular_videos`) | YouTube, Instagram, Facebook and TikTok videos, by their titles only | a day or two |

A post found in two tables is counted once (by its link). A Sprinklr comment is counted by its own id, because many
comments share the link of the post they are under. Not searched: Sprinklr's outbound table (Google's own posts) and
the tables of posts the team already alerted.

## Automatic temp checks

Off until someone turns it on in the page ("Automatic temp checks"). When on, each incoming alert is put through
the occasions the team's documents name for a temp check (`lib/triggers.js`), and what starts is a draft meant to
get an analyst's attention: they use it, or do a fuller one before the pulse check.

| Occasion | The rule |
|---|---|
| A high-engaging alert | More engagement than nine in ten recent alerts. (Two alerts in three already carry the "HIGH" label, so that label can't be the bar.) |
| Multiple alerts on one issue | The third different post alerted on the issue within 24 hours. A corrected alert sent again is not another. |
| Rising post momentum | An alert that starts nothing has its post read again 30 and 90 minutes later; up by half or more starts one. X posts only for now. |
| Ongoing developments | A new alert on an issue that has a temp check refreshes it, hourly at most, reusing the posts it kept. |
| Scheduled coverage | "Keep refreshed for a day" on any temp check; "as needed" is the Run button. |

The documents give the occasions, not the numbers, so every number is a setting. "Try on the newest 500 alerts"
runs the rules over past alerts and starts nothing, to see what a setting would have done before saving it.

- It reads incoming alerts from the chat bot's Alert log tab, read only (`lib/feed.js`). Another feed hands each
  alert to `POST /api/alerts/incoming` instead: `{id, issue, at, eng, url, text}`.
- Switching it on never acts on alerts that were already there. It starts at most 20 a day, one at a time, and
  keeps a line for every alert saying what it did and why.
- A temp check that finds no posts in our tables is logged as "no posts found", not offered as a draft.
- It runs only while the app is running.

## In Chat

Off until someone turns it on in the page ("In Chat"). The app answers in the chat bot's Auto-correct space as the
person running it, with a temp check kept as a Google Doc and the Doc's link as a reply in the thread
(`lib/inchat.js`). The chat bot itself is not changed and needs nothing switched.

| Switch | What it does |
|---|---|
| Story cards | Each new Early Detection story card gets a temp check from the card's own draft query, a Google Doc, and the Doc's link as a reply in the card's thread. |
| Typed requests | `temp check` typed in the space by the person running the app is answered in that thread, within a minute or two. |

What to type, as a reply in a thread (or as a new message, which Chat makes a thread of):

| Typed | What is counted |
|---|---|
| `temp check` in a story card's thread | The card's own query. Typed again there later: an update of the last one. |
| `temp check [G EVENT] NOV26 Alleged Gmail Outage` | That Brandwatch query, by its name, its link or its id. |
| `temp check "calendar invite" AND (scam OR phishing)` | That Boolean, in Brandwatch's standing Google queries and in our tables. |
| `temp check` in an alert's thread | A query drafted from the alert, then checked (below). Typed again there later: an update of the last one. |

- **It needs its own sign-in to Chat**, made once with the line the page shows (`gcloud auth application-default
  login` with the two Chat permissions, kept in its own folder under the home directory, apart from every other
  Google login on the computer). Without it nothing is read or posted, and the switches cannot be turned on. "Make
  its temp check" on a story card in the page works without it: it makes the temp check and the Doc and shows the
  reply's words, and "Post this reply" is what needs the sign-in. Google can refuse that line with "This app is
  blocked"; the page then gives the same line made with a Desktop sign-in client of the team's own project, whose
  file is kept under the home directory beside the login, never in this repository.
- **A drafted query is checked before its count is given.** In an alert's thread nobody has written a query, so
  Gemini drafts one from the alert: what it is about, what sets this issue apart, and the words people use about
  what happened, all three of which a post must match. Nobody sees that query before it is counted with, so Gemini
  then reads up to 40 of the posts it found (the most engaged, and a spread of what our tables hold) and says which
  are about the issue. A query that caught other posts too is narrowed once, and the better of the two is used. The
  reply names the query and says how many of the posts read were about the issue; under half, it gives no count,
  only the query that was tried. It is a check of the query, not a measure of the whole count.
- **Where it posts:** only as a reply in an existing thread of the space the bot's Control tab names as its
  Auto-correct space, and only while the bot's own tick is beside it. Never in a space the Control tab gives to
  S-F Burson, never a new conversation, at most 30 replies a day, and never twice for the same card or request.
- **Switching either on never acts on what was already there.**
- **The Docs** go in one folder of the Drive of whoever runs the app ("Temp checks (automatic drafts)"). They are
  private to that person until the folder is shared: share it once with the people who should open the links. The
  app never changes who can see anything and never deletes a Doc.
- **The chat bot reads the same space.** A reply from the app is marked the way the bot marks its own posts, so the
  bot leaves it alone and does not relay it (checked by running the bot's own code against one). What you type is
  yours, though: a request with words like "issue", "status" or "email" in it can get an answer from the bot as well.
- **Only the person running the app is heard**, and only while the app is running. A request typed from another
  account is never answered; the page says it was left alone.

## What it reads and writes

| | |
|---|---|
| Brandwatch | Read only. `lib/brandwatch.js` can send nothing but GET. It uses the team's shared token from Secret Manager, the same one the chat bot reads; the token stays in memory and is never logged or saved. |
| BigQuery | Read only: a single SELECT per search, values as named parameters, a cap on what each search may scan (20 GB unless `TEMPCHECK_MAX_GB_PER_QUERY` says otherwise), estimated first for free. |
| Gemini | Vertex AI, the model the chat bot uses. |
| X | The public embed data, for the words of X posts (Brandwatch's API withholds them). |
| A post's own platform | Opening a post card shows the post in that platform's embed frame (X, YouTube, Instagram, TikTok, Bluesky, Reddit), so your browser loads that platform's page, as it would if you opened the link. The frame's address is built from the post's id only, and the server's content rule lets the page frame those six addresses and nothing else. News, Facebook and LinkedIn posts have no frame: the overlay shows what we hold and a link. |
| The bot's sheet | Read only: the Alert log tab (incoming alerts and story cards) and the Control tab (which space is the Auto-correct space, and which are S-F Burson's). |
| Google Drive | Each temp check made for Chat is saved as a new Google Doc in one folder the app made in the Drive of whoever runs it. It touches no other file or folder, shares nothing and deletes nothing. |
| Google Chat | Only with the Chat sign-in. `lib/chat.js` can list a space's messages and post a reply in an existing thread, and nothing else: no new conversation, no edit, no delete. |
| This folder | `data/` holds the temp checks and the benchmark as JSON files. The repository's `.gitignore` ignores every folder named `data`, so none of it can be committed. |

It listens on `127.0.0.1` only and has no sign-in of its own: it acts as whoever started it. Do not put it on a
network as it is.

## What to know about the numbers

- **Our tables hold posts, not reposts** (and replies only in Sprinklr's comments). Most of a Brandwatch total is
  reposts and replies, and most of the team's queries ask for them by post (`engagingWithGuid:`). So our count sits
  beside Brandwatch's *original posts*, not its total, and even then the two are not the same set of posts.
- **A count from the standing Google queries is Brandwatch's, but not an issue query's.** It counts the mentions those
  queries already hold that match the Boolean, so a mention that names neither Google nor one of its products is not
  in it. The `(Benchmarking)` query of the set is left out: it holds a 2% sample of the same mentions (Brandwatch gave
  its counts already scaled up, so a search inside it counted in steps of about fifty), and counting it would count
  everything twice. No concern level is given for such a count: past issues are ranked by their own queries.
- **The concern level is this app's own ranking**, not the team's benchmark. Brandwatch answers only for queries
  that are still active, and the team deactivates old ones, so the app holds fewer issues than the year had and says
  so in the sentence ("top 10% of 147 of the past 12 months' 313 Google issues"). Every temp check keeps its issue's
  curve, so coverage grows from here on. Check a level against the team's benchmark until the two have been compared.
- **A NOT after a list of ORs** is read as leaving those posts out of the whole list (`a OR b NOT c` is
  `(a OR b) NOT c`). That matches Brandwatch's own counts on the six real queries it was tested against; it is not
  taken from Brandwatch's documentation.

## The pieces

| File | What it is |
|---|---|
| `server.js` | The web server and its small API. |
| `lib/service.js` | One temp check, start to finish. |
| `lib/tempcheck.js` | The arithmetic and the template's wording, ported from the bot's `TempCheck.gs`. Pure. |
| `lib/bwquery.js` | Brandwatch Boolean to BigQuery, and the same plan run in memory. Pure. |
| `lib/owndata.js` | The search of our own tables. |
| `lib/brandwatch.js` | Brandwatch, read only. |
| `lib/benchmark.js` | The concern level. |
| `lib/triggers.js`, `lib/watch.js`, `lib/feed.js` | The occasions for a temp check, the watcher that acts on them, and the bot's Alert log and Control tab (read only). |
| `lib/inchat.js`, `lib/chat.js`, `lib/docs.js`, `lib/png.js` | In Chat: what is answered and where, Chat itself, the Google Doc, and the hourly chart as a picture for it. |
| `lib/gemini.js`, `lib/xposts.js`, `lib/bigquery.js`, `lib/gcp.js`, `lib/store.js` | Gemini, X post words, BigQuery, sign-in, the files kept. |
| `public/` | The page: `app.js`, and `visuals.js` for the charts, the post cards and the overlay a post opens in. |

To fold it into the alert app later: `POST /api/alerts` is the hook for "an alert just fired", `lib/store.js` is the
one file to swap for a BigQuery table, and everything in `lib/` that is marked Pure has no ties to this server.
