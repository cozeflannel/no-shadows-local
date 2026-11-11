"""slrr-signals: the two-track SLRR system on Cloud Run (docs/TWO_TRACK_SIGNALS.md).

Track 1 (official, strict): what the five source tables hand over lands in slrr_signals.raw_mentions; deterministic rules
(exclusions, previously-reported, KOF, Sensitive Topic language, P0 hints, the 2K+ engagement track) stop most of it
before any LLM; Gemini classifies the survivors against the playbook taxonomy; the Collection Requirements engine
(triage_agent.qa.requirements, the same one that QAs Burson's alerts) decides; rows go to classified_mentions.

Track 2 (radar, exploratory): the early_detection embedding clusters (and the sources' own issue groupings) with their
velocity; Gemini estimates whether each will meet Track 1 if left alone; rows go to radar_clusters.

The service itself posts nothing in Chat and emails no one: the existing chatbot hands its results to the chat
(apps-script-chat-bot/Signals.gs), into the flows the sheet's Control tab already routes. Qualifying Track 1 rows are
posted as watch alerts where Watch alerts (Control row 35) says, and worked there like any alert; the clusters Track 2
promoted or rated likely to become an alert join the bot's Early detection review (Control row 19). Each hand-off is
recorded in slrr_signals.handoffs.
"""
