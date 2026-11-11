"""slrr-signals: the two-track SLRR system on Cloud Run (docs/TWO_TRACK_SIGNALS.md).

Track 1 (official, strict): what the five source tables hand over lands in slrr_signals.raw_mentions; deterministic rules
(exclusions, previously-reported, KOF, Sensitive Topic language, P0 hints, the 2K+ engagement track) stop most of it
before any LLM; Gemini classifies the survivors against the playbook taxonomy; the Collection Requirements engine
(triage_agent.qa.requirements, the same one that QAs Burson's alerts) decides; rows go to classified_mentions.

Track 2 (radar, exploratory): the early_detection embedding clusters (and the sources' own issue groupings) with their
velocity; Gemini estimates whether each will meet Track 1 if left alone; rows go to radar_clusters.

Nothing here posts in Chat or emails anyone. Qualifying Track 1 rows wait in v_track1_ready for the existing chatbot,
which reads them only when its own hand-off switch is ON.
"""
