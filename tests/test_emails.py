"""Agent inbox: WD intake -> SUBMITTED, outcomes (+ bug-ID follow-up), Watchdog skip/create, other emails."""

import pytest

from a2_fixtures import IM, connect, events, make_case
from triage_agent import emails
from triage_agent.escalation import service, tns
from triage_agent.events import EventType
from triage_agent.models import ChatOutputs, EmailStatus, TnsStatus
from triage_agent.operations import handle

INTAKE_SUBJECT = "Issue [#12345678]: WD Intake Request"


def ingest(ctx, **mail):
    mail.setdefault("message_id", f"gmail-{abs(hash(str(sorted(mail.items())))) % 10**8}")
    return handle({"op": "ingest_email", "payload": mail, "context": {"flow": "email"}}, ctx)


def prepared(ctx, clock, fake_llm, **case_kw):
    fake_llm.on("tns.assess", {"eligible": True, "category": "Harmful hallucination", "criteria_ids": ["gemini_hallucination"],
                               "rationale": "Dangerous output.", "evidence": "input_shown", "description": "Gemini dosage advice."})
    case = make_case(ctx, engagement_total=150, **case_kw)
    esc = service.start_escalation(ctx, case, IM, trigger="reaction", requested_by=IM)
    tns.assess_and_prepare(ctx, esc, case, IM)
    return case, esc


def test_wd_intake_matched_by_reference(ctx, clock, fake_llm):
    case, esc = prepared(ctx, clock, fake_llm)
    body = f"A new WD intake request was filed.\nDescription: [SLRR {esc.escalation_id} / {case.case_id}] Gemini dosage advice."
    r = ingest(ctx, subject=INTAKE_SUBJECT, from_email="wd-intake@tns.test", body=body)
    assert r.outputs["has_clean"] == "yes"
    assert r.outputs["clean_text"].startswith(f"🤖 ✍️ T&S intake confirmed: Issue 12345678 · {case.case_id}")
    state = ctx.store.get_escalation(esc.escalation_id).tns
    assert state.status == TnsStatus.SUBMITTED and state.wd_issue_id == "12345678" and state.submitted_by == IM
    sub = events(ctx, EventType.TNS_SUBMITTED)
    assert len(sub) == 1 and sub[0].payload == {"via": "intake_email", "wd_issue_id": "12345678"}
    assert tns.find_by_wd_issue(ctx, "12345678").escalation_id == esc.escalation_id


def test_wd_intake_matched_by_post_url_and_unmatched(ctx, clock, fake_llm):
    case, esc = prepared(ctx, clock, fake_llm)
    url = case.latest.result.normalized["post_url"].replace("https://x.com", "https://twitter.com") + "?s=20"
    r = ingest(ctx, subject="Issue [#7654321]: WD Intake Request", body=f"Link to the post: {url}\nTeam: Marketing")
    assert "Issue 7654321" in r.outputs["clean_text"] and r.outputs["escalation_id"] == esc.escalation_id
    assert ctx.store.get_escalation(esc.escalation_id).tns.status == TnsStatus.SUBMITTED

    lost = ingest(ctx, subject="Issue [#1111111]: WD Intake Request", body="No reference here.")
    assert lost.outputs["has_clean"] == "no" and lost.outputs["dm_recipients"] == IM
    assert "Issue 1111111" in lost.outputs["dm_text"] and "submitted ESC-" in lost.outputs["dm_text"]
    assert events(ctx, EventType.MESSAGE_IGNORED)[-1].payload["reason"] == "intake_unmatched"


def test_fixed_outcome_with_bug_id_drafts_followup(ctx, clock, fake_llm):
    gmail = connect(ctx, clock, IM)
    case, esc = prepared(ctx, clock, fake_llm)
    alert = service.draft_alert_email(ctx, esc, case)
    rfc = gmail.mark_sent(alert.draft_id)
    service.check_sent(ctx, esc)
    ingest(ctx, subject=INTAKE_SUBJECT, body=f"[SLRR {esc.escalation_id} / {case.case_id}]")

    r = ingest(ctx, subject=f"Re: {INTAKE_SUBJECT}", body="Status: Fixed\nBug: b/123456789\nThanks for reporting.")
    assert r.outputs["clean_text"].startswith("🤖 ✍️ T&S outcome: Fixed · Issue 12345678 · bug b/123456789")
    assert r.outputs["dm_recipients"] == IM and "reply with the bug id is ready in your Gmail" in r.outputs["dm_text"]
    state = ctx.store.get_escalation(esc.escalation_id)
    assert state.tns.outcome == "Fixed" and state.tns.bug_id == "123456789"
    follow = state.email_for("bug_followup")
    assert follow.status == EmailStatus.DRAFTED
    draft = gmail.drafts[follow.draft_id]
    assert draft["in_reply_to"] == rfc and draft["thread_id"] == alert.thread_id and "b/123456789" in draft["body"]
    outcome = events(ctx, EventType.TNS_OUTCOME)[0]
    assert outcome.payload["outcome"] == "Fixed" and outcome.payload["bug_id"] == "123456789"

    dup = ingest(ctx, subject=f"Re: {INTAKE_SUBJECT}", body="Status: Fixed\nBug: b/123456789\nThanks for reporting.")
    assert dup.data["duplicate"] is True and len(events(ctx, EventType.TNS_OUTCOME)) == 1


def test_infeasible_outcome_notifies_without_draft(ctx, clock, fake_llm):
    case, esc = prepared(ctx, clock, fake_llm)
    tns.mark_submitted(ctx, esc, via="chat", actor=IM, wd_issue_id="2222222")
    r = ingest(ctx, subject="Issue [#2222222]: WD Intake Request", body="The report was closed as Infeasible.")
    assert "T&S outcome: Infeasible" in r.outputs["clean_text"] and r.outputs["dm_recipients"] == IM
    assert ctx.store.get_escalation(esc.escalation_id).email_for("bug_followup") is None
    update = ingest(ctx, subject="Issue [#2222222]: WD Intake Request", body="Assigned to a reviewer.")
    assert update.outputs["has_clean"] == "no" or "Infeasible" not in update.outputs["clean_text"]


@pytest.mark.parametrize("subject,body,reason", [
    ("Watchdog Anti-Abuse Alert: Early Warning", "Trend forming https://x.com/a/status/1", "early_warning"),
    ("Watchdog Anti-Abuse Alert", "Users share a Gemini jailbreak https://x.com/a/status/2", "jailbreak"),
    ("Watchdog Anti-Abuse Alert", "NSFW generated image spreading https://x.com/a/status/3", "nsfw"),
])
def test_watchdog_skip_rules(ctx, subject, body, reason):
    r = ingest(ctx, subject=subject, body=body)
    assert all(r.outputs[k] == "no" for k in r.outputs if k.startswith("has_"))
    skipped = events(ctx, EventType.WATCHDOG_SKIPPED)
    assert len(skipped) == 1 and skipped[0].payload["reason"] == reason and skipped[0].payload["links"]


def test_watchdog_creates_alerts_through_process_alert(ctx, clock, fake_llm, monkeypatch):
    calls = []

    def fake_process_alert(ctx_, parsed, *, source, received_at, message=None, source_ref=None, post=True):
        calls.append({"parsed": parsed, "source": source, "source_ref": source_ref, "message": message})
        n = len(calls)
        return ChatOutputs(clean_text=f"🤖 *Watchdog alert {n}* · TRG-90{n:02d}", case_id=f"TRG-90{n:02d}", verdict="PASS"), {"case_id": f"TRG-90{n:02d}"}

    monkeypatch.setattr(emails, "_triage_helper", lambda: fake_process_alert)
    fake_llm.on("watchdog.extract", lambda call: {
        "alert_name": "Gemini App – Users share a prompt that leaks system instructions", "product": "Gemini App",
        "social_network": "X", "exposure_tag": "Product - Dangerous results (e.g. medical/legal)",
        "total_engagement": 5400, "kof": True, "post_url": "https://wrong.example/ignored"})
    existing = make_case(ctx, record_key="x.com/status/1845000000000000001")
    body = ("Watchdog flagged abuse.\nPosts: https://x.com/abuser/status/1845000000000000001 and "
            "https://x.com/other/status/1845000000000000002?s=20 and https://www.reddit.com/r/x/comments/abc123/title/\n"
            "Internal: https://docs.google.com/document/d/xyz")
    r = ingest(ctx, subject="Watchdog Anti-Abuse Alert", from_email="watchdog@tns.test", body=body, message_id="wd-1")

    assert r.outputs["clean_text"] == "🤖 *Watchdog alert 1* · TRG-9001" and r.outputs["case_id"] == "TRG-9001"
    assert len(calls) == 2, "the existing case's link is skipped"
    first = calls[0]
    assert first["source"] == "watchdog" and first["parsed"].parse_method == "structured"
    assert first["parsed"].fields["post_url"] == "https://x.com/other/status/1845000000000000002?s=20"
    assert first["parsed"].fields["total_engagement"] == 5400 and first["parsed"].fields["kof"] is True
    assert {c["source_ref"] for c in calls} == {"wd-1:x.com/status/1845000000000000002", "wd-1:reddit.com/comments/abc123"}
    assert fake_llm.calls[-1]["purpose"] == "watchdog.extract"
    queued = ctx.store.list_outbox()
    assert [i.text for i in queued] == ["🤖 *Watchdog alert 2* · TRG-9002"], "one case per clean post: the second via the outbox"
    received = events(ctx, EventType.WATCHDOG_RECEIVED)[0]
    assert len(received.payload["links"]) == 3 and "docs.google.com" not in str(received.payload["links"])
    skipped = events(ctx, EventType.WATCHDOG_SKIPPED)
    assert skipped[0].payload["reason"] == "existing_case" and skipped[0].case_id == existing.case_id


def test_watchdog_without_triage_lists_links(ctx, monkeypatch):
    monkeypatch.setattr(emails, "_triage_helper", lambda: None)
    r = ingest(ctx, subject="Watchdog Anti-Abuse Alert", body="See https://x.com/a/status/1845000000000000009")
    assert r.outputs["has_clean"] == "yes" and "https://x.com/a/status/1845000000000000009" in r.outputs["clean_text"]
    assert "no alert was created" in r.outputs["clean_text"] and ctx.store.list_cases() == []


def test_doorbell_unrecognized_and_flat_payload(ctx):
    door = ingest(ctx, subject="[triage-agent outbox] OBX-123", body="clean OBX-123")
    assert door.data["ignored"] == "doorbell_email"
    other = ingest(ctx, subject="Lunch?", body="Pizza at noon")
    assert other.data["ignored"] == "unrecognized_email"
    assert [e.payload["reason"] for e in events(ctx, EventType.MESSAGE_IGNORED)] == ["doorbell_email", "unrecognized_email"]

    mail = emails.inbound_from_payload({"subject": "x", "from": "T&S Intake <wd@tns.test>", "to": "a@ops.test, B <b@ops.test>",
                                        "body": "hi", "received_at": "Mon, 12 Oct 2026 14:00:00 -0400"})
    assert mail.from_email == "wd@tns.test" and mail.from_name == "T&S Intake" and mail.to == ["a@ops.test", "b@ops.test"]
    assert mail.received_at.isoformat() == "2026-10-12T14:00:00-04:00"
