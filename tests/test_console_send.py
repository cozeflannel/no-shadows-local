"""Sending the Social Alert email from an alert's window (switch: Send alert emails from the Console).

What these tests hold to:
  * the switch starts off, and while it is off nothing is sent, by the route or by the gateway;
  * while Testing is on the email goes to the Testing recipients only, and with none named it is not sent at all;
  * what goes out is what the Console wrote: a draft changed in Gmail after it was saved is written again first;
  * with Testing off the allowed recipient domains still hold;
  * a sent email is recorded the way a send from Gmail is (the alert, the event log), and cannot be sent twice.

Gmail is the in-memory stand-in every Console test uses, behind the same safety wrapper every deployed context has.
"""

from __future__ import annotations

from typing import Any

import pytest

from test_a2_review import TOKEN, DictVault, FakeService, google
from test_console_api import ADMIN, IM, VIEWER, api, console_ctx, seeded  # noqa: F401 - fixtures
from test_workspace import a_case
from triage_agent import audit, safety
from triage_agent.escalation.gmail import GmailError
from triage_agent.events import EventType
from triage_agent.models import EmailStatus

TESTER = "tester@qa.test"
REAL = ["lead@alerts.test", "vp@alerts.test"]


@pytest.fixture
def mail(api):
    """The Gmail stand-in itself, with the safety wrapper in front of it as a deployed context has."""
    inner = api.ctx.gmail
    api.ctx.gmail = safety.SafeGmail(inner, lambda: api.ctx)
    return inner


def settings(api, *, send: bool = True, testing: bool = True, testers: list[str] | None = None, domains: list[str] | None = None) -> None:
    flags = {**api.ctx.config.platform.flags.model_dump(mode="json"), safety.SEND_SWITCH: send}
    assert api.put("/api/platform/flags", {"value": flags}, user=ADMIN).status_code == 200
    safe = {**api.ctx.config.platform.safety.model_dump(mode="json"), "testing": testing, "testing_recipients": testers or [],
            "allowed_recipient_domains": domains or []}
    assert api.put("/api/platform/safety", {"value": safe, "note": "test"}, user=ADMIN).status_code == 200


def email_body(api, case_id: str, **changes: Any) -> dict[str, Any]:
    start = api.get(f"/api/workspace/{case_id}", user=IM).json()["email"]
    return {"subject": "Alert for the team", "to": list(REAL), "cc": [], "bcc": [], "html": start["html"], **changes}


def send(api, case_id: str, who: str = IM, **changes: Any):
    return api.post(f"/api/workspace/{case_id}/email/send", email_body(api, case_id, **changes), user=who)


def addressed(sent: dict[str, Any]) -> list[str]:
    return [*sent["to"], *sent["cc"], *sent["bcc"]]


# -- off until an admin turns it on ---------------------------------------------------------------------------------------
def test_the_switch_starts_off_and_while_it_is_off_nothing_is_sent(api, mail):
    case_id = a_case(api)
    assert api.ctx.config.platform.flags.console_send_email is False, "off in the code: an admin turns it on"
    assert api.get(f"/api/workspace/{case_id}", user=IM).json()["email"]["can_send"] is False
    refused = send(api, case_id)
    assert refused.status_code == 409 and "Sending from the Console is off" in refused.json()["error"]
    assert mail.sent_drafts == [] and mail.drafts == {}, "not sent, and no draft was made for a send that was refused"

    saved = api.put(f"/api/workspace/{case_id}/email", email_body(api, case_id), user=IM)
    assert saved.status_code == 200
    [draft] = mail.drafts.values()
    with pytest.raises(safety.SendRefused, match="is off"):  # the gateway refuses on its own: no code path sends around the switch
        api.ctx.gmail.send_draft(IM, draft["draft_id"], from_header="x", to=[TESTER], cc=[], bcc=[], subject="s", body="b")
    assert mail.sent_drafts == []


# -- Testing ----------------------------------------------------------------------------------------------------------------
def test_with_testing_on_and_no_testing_recipient_nothing_is_sent(api, mail):
    case_id = a_case(api)
    settings(api, testing=True, testers=[])
    refused = send(api, case_id)
    assert refused.status_code == 409 and "no Testing recipient is named, so nothing is sent" in refused.json()["error"]
    assert mail.sent_drafts == []
    api.put(f"/api/workspace/{case_id}/email", email_body(api, case_id), user=IM)
    [draft] = mail.drafts.values()
    with pytest.raises(safety.SendRefused, match="nothing is sent"):
        api.ctx.gmail.send_draft(IM, draft["draft_id"], from_header="x", to=list(REAL), cc=[], bcc=[], subject="s", body="b")
    assert mail.sent_drafts == [] and len(mail.drafts) == 1, "the draft is still a draft"


def test_while_testing_the_email_goes_to_the_testing_recipients_only(api, mail):
    case_id = a_case(api)
    settings(api, testing=True, testers=[TESTER])
    assert api.get(f"/api/workspace/{case_id}", user=IM).json()["email"]["can_send"] is True
    assert send(api, case_id, who=VIEWER).status_code == 403
    done = send(api, case_id, cc=["exec@alerts.test"])
    assert done.status_code == 200, done.text
    [sent] = mail.sent_drafts
    assert sent["to"] == [TESTER] and sent["cc"] == [] and sent["bcc"] == [], "nobody real is on it"
    assert not set(addressed(sent)) & {*REAL, "exec@alerts.test"}
    assert "[Testing: this draft would have gone to 3 recipients.]" in sent["body"] and sent["subject"] == "Alert for the team"
    assert mail.drafts == {}, "sent: it is no longer a draft"

    email = done.json()["email"]
    assert email["status"] == "sent" and email["sent_at"]
    esc = next(e for e in api.ctx.store.list_escalations(case_id=case_id, limit=20) if e.analyst_email == IM)
    kept = esc.email_for("alert")
    assert kept.status == EmailStatus.SENT and kept.rfc822_message_id, "recorded the way a send from Gmail is noticed"
    assert kept.rfc822_message_id in api.ctx.store.get_case(case_id).alert_email_message_ids
    assert any(e.case_id == case_id for e in api.events(EventType.EMAIL_SENT))
    [entry] = [e for e in audit.search(api.ctx) if e.action == "email.send"]
    assert entry.actor == IM and entry.case_id == case_id and "to 1 Testing recipient" in entry.summary

    twice = send(api, case_id)
    assert twice.status_code == 409 and "already sent" in twice.json()["error"] and len(mail.sent_drafts) == 1, "never sent twice"


def test_what_goes_out_is_what_the_console_wrote_not_what_the_draft_held_in_gmail(api, mail):
    case_id = a_case(api)
    settings(api, testing=True, testers=[TESTER])
    assert api.put(f"/api/workspace/{case_id}/email", email_body(api, case_id), user=IM).status_code == 200
    [draft] = mail.drafts.values()
    draft["to"], draft["bcc"], draft["subject"] = ["someone@elsewhere.test"], ["hidden@elsewhere.test"], "Changed in Gmail"  # edited in Gmail after the save
    assert send(api, case_id).status_code == 200
    [sent] = mail.sent_drafts
    assert addressed(sent) == [TESTER] and sent["subject"] == "Alert for the team", "the draft was written again before it was sent"


def test_the_gateway_itself_writes_the_draft_again_before_it_sends(api, mail):
    """Whatever calls it: a draft is never sent as Gmail happens to hold it, only as the call gives it, under the rules."""
    case_id = a_case(api)
    settings(api, testing=True, testers=[TESTER])
    assert api.put(f"/api/workspace/{case_id}/email", email_body(api, case_id), user=IM).status_code == 200
    [draft] = mail.drafts.values()
    draft["to"], draft["cc"], draft["subject"] = ["someone@elsewhere.test"], ["hidden@elsewhere.test"], "Changed in Gmail"
    api.ctx.gmail.send_draft(IM, draft["draft_id"], from_header="x", to=list(REAL), cc=[], bcc=[], subject="As given", body="As given.")
    [sent] = mail.sent_drafts
    assert addressed(sent) == [TESTER] and sent["subject"] == "As given"
    with pytest.raises(GmailError, match="whole email"):  # part of an email is not enough to know what would go out
        api.ctx.gmail.send_draft(IM, "r-none", to=[TESTER], subject="s")


# -- Testing off ------------------------------------------------------------------------------------------------------------
def test_with_testing_off_it_goes_to_its_recipients_and_the_allowed_domains_still_hold(api, mail):
    case_id = a_case(api)
    settings(api, testing=False, domains=["alerts.test"])
    assert safety.testing_recipients(api.ctx.config) is None, "Testing is off"
    done = send(api, case_id, to=["lead@alerts.test", "friend@elsewhere.test"], cc=["vp@alerts.test"])
    assert done.status_code == 200, done.text
    [sent] = mail.sent_drafts
    assert (sent["to"], sent["cc"], sent["bcc"]) == (["lead@alerts.test"], ["vp@alerts.test"], []), "an address outside the allowed domains is dropped"
    assert "[Testing" not in sent["body"]
    [entry] = [e for e in audit.search(api.ctx) if e.action == "email.send"]
    assert "to 2 recipients" in entry.summary and entry.detail["testing"] is False

    other = next(c.case_id for c in api.ctx.store.list_cases(limit=200) if c.case_id != case_id and c.attempts and not c.escalation_ids
                 and not api.ctx.store.list_escalations(case_id=c.case_id, limit=5))
    nobody = send(api, other, to=["friend@elsewhere.test"])
    assert nobody.status_code == 409 and "nobody to go to" in nobody.json()["error"] and len(mail.sent_drafts) == 1
    assert send(api, other, to=[]).status_code == 409


# -- when Gmail does not take it --------------------------------------------------------------------------------------------
def test_a_gmail_problem_leaves_the_draft_and_says_so(api, mail, monkeypatch):
    case_id = a_case(api)
    settings(api, testing=True, testers=[TESTER])

    def down(user_email: str, draft_id: str) -> dict:
        raise GmailError("Gmail is unreachable right now: timed out")
    monkeypatch.setattr(mail, "send_draft", down)
    failed = send(api, case_id)
    assert failed.status_code == 409 and "Gmail did not send it" in failed.json()["error"] and "still in your Gmail" in failed.json()["error"]
    assert len(mail.drafts) == 1 and mail.sent_drafts == []
    state = api.get(f"/api/workspace/{case_id}", user=IM).json()["email"]
    assert state["status"] in ("drafted", "redrafted") and not [e for e in audit.search(api.ctx) if e.action == "email.send"]


# -- the Gmail API ------------------------------------------------------------------------------------------------------------
def test_gmail_is_asked_to_send_the_draft_by_its_id():
    svc = FakeService(drafts__send={"id": "m-9", "threadId": "t-4", "labelIds": ["SENT"]})
    assert google(svc, DictVault({IM: TOKEN})).send_draft(IM, "r-123") == {"message_id": "m-9", "thread_id": "t-4"}
    assert svc.named("drafts.send") == [{"userId": "me", "body": {"id": "r-123"}}], "users.drafts.send: the permission IMs already gave (gmail.compose) covers it"
