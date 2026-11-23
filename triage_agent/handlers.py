"""Imports every module that registers operations with @operation(...).

Modules are owned by different workstreams (docs/CONTRACTS.md#module-layout).
A module that doesn't exist yet is skipped, so partial builds still run; an
ImportError *inside* an existing module is raised.
"""

import importlib

HANDLER_MODULES = [
    "triage_agent.triage",  # triage_message
    "triage_agent.review",  # review_decision, revert_correction, close_case
    "triage_agent.actions",  # record_reaction, start_escalation, record_post
    "triage_agent.emails",  # ingest_email
    "triage_agent.converse.handler",  # converse, decide_proposal, decide_fact
    "triage_agent.followups",  # run_followups, generate_handover
    "triage_agent.inhouse",  # ingest_inhouse
    "triage_agent.platform_ops",  # record_assessment, run_temp_check, run_forecast, refresh_knowledge, run_watches
    "triage_agent.ownalerts.review",  # review_own_candidate
]

for _name in HANDLER_MODULES:
    try:
        importlib.import_module(_name)
    except ModuleNotFoundError as _exc:
        if _exc.name not in (_name, _name.rsplit(".", 1)[0]):
            raise
