"""Agent alerts: the app raises alerts of its own from the sources it reads.

    sources   every few minutes each source hands over what is new: the post tables in BigQuery (each read in its own
              location), the Brandwatch queries, and the Chat space other tools post their alerts in.
    scrub     personal details are taken out of every post before it is kept: patterns, then Cloud DLP. An author is
              kept as a salted hash; a KOF's name and each post's link go to a vault no model reads.
    cycle     BigQuery checks each post against the rules, asks Gemini about the ones a rule leaves open, groups the
              rest into stories and measures how fast each story grows.
    review    what passed is reviewed on the Agent Runtime; a mandatory rule cannot be overruled.
    raise     a raised alert is posted through the QA chatbot's Chat sign-in, with the name and links from the vault.
    feedback  an analyst's verdict is kept and shown to later reviews.
    surge     a raised story that is growing again is reviewed once more.
    purge     what is past its days is deleted, once a day.

The source tables are only ever read. Every table of its own that holds posts expires after 30 days at most.
In the Console the feature is called Agent alerts ("Our own alerts" is the page for the team's own tables); in the
code and the settings it is `own_alerts`.
"""

SWITCH = "own_alerts"
POST_SWITCH = "own_alerts_post"
SNIPPET_BREAK = " || "  # what stands between two posts in a story's evidence
