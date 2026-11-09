"""Conversation (workstream A2): @mentions and DMs to the Triage Agent (docs/CONTRACTS.md §10).

  intents.py  regex intents first, then Gemini (converse.intent)
  answer.py   grounded answers (facts, FAQ, Collection Requirements, distribution, stakeholders,
              live cases, metrics) + stakeholder routing
  teach.py    "remember that…" facts and "from now on…" config change proposals (+ decisions)
  handler.py  ops converse, decide_proposal, decide_fact
"""
