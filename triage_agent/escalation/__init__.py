"""Escalation (workstream A2): Social Alert drafts, T&S forms and the Gmail gateway.

Modules (docs/CONTRACTS.md §7):
  gmail.py     GmailGateway protocol, FakeGmail, GoogleGmail, token vaults
  drafting.py  Gemini drafting (escalation.draft_email / escalation.revise_email) + deterministic fallbacks
  service.py   start_escalation, draft_alert_email, add_group, revise_email, check_sent
  tns.py       T&S assessment, go/WD-Triage pre-fill links, urgent + bug-ID follow-up drafts

Submodules are imported explicitly (nothing is imported here) so that
`triage_agent.context.build_context` can load the Gmail gateway cheaply.
"""
