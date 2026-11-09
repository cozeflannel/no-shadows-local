"""Escalation service + Gmail gateway: drafts, ongoing-thread replies, groups, revisions, sent detection."""

from datetime import timedelta

import pytest

from a2_fixtures import IM, IM2, connect, events, make_case
from triage_agent.escalation import drafting, service
from triage_agent.escalation.gmail import FakeGmail, build_mime, decode_message, merge_mime, message_fields, encode_message
from triage_agent.events import EventType
from triage_agent.models import EmailStatus
from triage_agent.operations import UserFacingError

GEMINI_PA = "gemini-app@alerts.test"
CIVICS = "civics@alerts.test"


def llm_draft(fake_llm, body="Bottom line: Gemini recommended a dangerous dose.\n\nView Post: https://x.com/p\n\nBrand Social",
              notes=("Check the screenshot",)):
    fake_llm.on("escalation.draft_email", {"subject": "ignored", "body": body, "notes": list(notes)})


def test_urgent_auto_draft_in_im_gmail(ctx, clock, fake_llm):
    gmail = connect(ctx, clock, IM)
    llm_draft(fake_llm)
    case = make_case(ctx)
    esc = service.start_escalation(ctx, case, IM, trigger="auto_urgent", requested_by="agent")
    email = service.draft_alert_email(ctx, esc, case)

    assert email.status == EmailStatus.DRAFTED and email.purpose == "alert"
    draft = gmail.drafts[email.draft_id]
    assert draft["user"] == IM and draft["from_header"] == "Brand Social <sender@alerts.test>"
    assert GEMINI_PA in draft["to"] and draft["cc"] == ctx.config.escalation.default_cc and draft["bcc"] == []
    assert draft["subject"] == case.alert_name and draft["in_reply_to"] is None
    assert draft["body"].endswith("Brand Social") and draft["body"].count("Brand Social") == 1
    assert email.groups == ["Gemini App"] and email.versions[0].version == 1
    call = fake_llm.calls[-1]
    assert call["purpose"] == "escalation.draft_email" and call["model"] == ctx.config.models.drafting
    assert "Mirror the SLRR Alert Assistant email" in call["system"] and "<<<ALERT DATA" in call["prompt"]

    started = events(ctx, EventType.ESCALATION_STARTED)
    assert len(started) == 1 and started[0].payload["trigger"] == "auto_urgent" and started[0].actor == "agent"
    drafted = events(ctx, EventType.EMAIL_DRAFTED)[0]
    assert drafted.escalation_id == esc.escalation_id
    assert {k: drafted.payload[k] for k in ("purpose", "version", "cc", "groups", "thread_reply")} == {
        "purpose": "alert", "version": 1, "cc": len(ctx.config.escalation.default_cc), "groups": ["Gemini App"], "thread_reply": False}
    assert drafted.payload["to"] == len(draft["to"])
    assert esc.escalation_id in ctx.store.get_case(case.case_id).escalation_ids
    assert service.draft_note(ctx, esc, email) == f"📨 Draft ready in {IM}'s Gmail (Brand Social) · {esc.escalation_id}"

    # start_escalation reuses the open escalation; drafting again returns the same draft
    again = service.start_escalation(ctx, case, IM.upper(), trigger="reaction", requested_by=IM)
    assert again.escalation_id == esc.escalation_id and len(events(ctx, EventType.ESCALATION_STARTED)) == 1
    assert service.draft_alert(ctx, again, case).action == "existing" and len(gmail.drafts) == 1


def test_fallback_body_when_gemini_fails_and_body_cap(ctx, clock):
    gmail = connect(ctx, clock, IM)
    case = make_case(ctx)
    esc = service.start_escalation(ctx, case, IM, trigger="reaction", requested_by=IM)
    email = service.draft_alert_email(ctx, esc, case)
    body = gmail.drafts[email.draft_id]["body"]
    assert body.startswith("Bottom line: User says Gemini recommended a dangerous medication dose.")
    for line in ("Name: ", "Exposure Tag: Product - Dangerous results (e.g. medical/legal) (P0)", "KOF: No",
                 "View Post: https://x.com/"):
        assert line in body
    assert events(ctx, EventType.EMAIL_DRAFTED)[0].payload["llm"] is False

    ctx.config.escalation.max_body_chars = 300
    capped = drafting.finish_body(ctx, drafting.fallback_alert_body(ctx, case))
    assert len(capped) <= 300 and capped.endswith("\n\nBrand Social") and "…" in capped


def test_ongoing_issue_replies_on_the_original_thread(ctx, clock, fake_llm):
    gmail = connect(ctx, clock, IM, IM2)
    original = make_case(ctx)
    esc1 = service.start_escalation(ctx, original, IM, trigger="auto_urgent", requested_by="agent")
    first = service.draft_alert_email(ctx, esc1, original)
    clock.advance(minutes=4)
    rfc = gmail.mark_sent(first.draft_id, "<orig-123@mail.test>")
    assert [e.status for e in service.check_sent(ctx, esc1)] == [EmailStatus.SENT]
    assert ctx.store.get_case(original.case_id).alert_email_message_ids == [rfc]

    clock.advance(hours=3)
    ongoing = make_case(ctx, track="HIGH_ENGAGEMENT", issue_status="ONGOING", related_case_id=original.case_id)
    esc2 = service.start_escalation(ctx, ongoing, IM, trigger="reaction", requested_by=IM)
    outcome = service.draft_alert(ctx, esc2, ongoing)
    reply = gmail.drafts[outcome.email.draft_id]
    assert reply["in_reply_to"] == rfc and rfc in reply["references"]
    assert reply["subject"] == f"Re: {first.versions[0].subject}"
    assert reply["thread_id"] == first.thread_id, "same mailbox -> same Gmail thread"
    assert outcome.email.in_reply_to == rfc and any("ongoing thread" in n for n in outcome.notes)
    assert "Ongoing issue update" in fake_llm.calls[-1]["system"]
    assert events(ctx, EventType.EMAIL_DRAFTED)[-1].payload["thread_reply"] is True

    # Another IM drafts for the same ongoing issue: In-Reply-To set, but no threadId from someone else's mailbox
    esc3 = service.start_escalation(ctx, ongoing, IM2, trigger="reaction", requested_by=IM2)
    other = service.draft_alert(ctx, esc3, ongoing)
    other_draft = gmail.drafts[other.email.draft_id]
    assert other_draft["in_reply_to"] == rfc and other_draft["thread_id"] != first.thread_id
    assert any(IM in n and "send only one" in n for n in other.notes)

    # The reply is deleted: the original SENT message in the same thread must not count as "sent"
    gmail.mark_discarded(outcome.email.draft_id)
    changed = service.check_sent(ctx, esc2)
    assert [e.status for e in changed] == [EmailStatus.DISCARDED]
    assert events(ctx, EventType.EMAIL_DISCARDED)[-1].payload == {"purpose": "alert", "reason": "draft_deleted"}


def test_add_group_real_and_placeholder(ctx, clock):
    gmail = connect(ctx, clock, IM)
    case = make_case(ctx)
    esc = service.start_escalation(ctx, case, IM, trigger="reaction", requested_by=IM)

    # Placeholder group (no recipients) with no draft yet: the alert draft is created; GCPA is reported missing
    placeholder = service.add_group_to_draft(ctx, esc, case, "gcpa", IM)
    assert placeholder.action == "created" and "GCPA" in placeholder.plan.missing
    assert not events(ctx, EventType.EMAIL_GROUP_ADDED)
    draft_id = placeholder.email.draft_id

    # Real group: re-planned recipients (Cc) on the same draft, new version, email.group_added
    civics = service.add_group(ctx, esc, case, "civics", IM)
    draft = gmail.drafts[draft_id]
    assert civics.draft_id == draft_id and CIVICS in draft["cc"] and GEMINI_PA in draft["to"]
    assert civics.groups == ["Gemini App", "Civics"] and [v.version for v in civics.versions] == [1, 2]
    assert civics.versions[-1].instruction.startswith("Added Civics")
    added = events(ctx, EventType.EMAIL_GROUP_ADDED)
    assert len(added) == 1 and added[0].payload == {"group": "Civics", "via": "reaction", "purpose": "alert"}
    # adding it again changes nothing
    assert service.add_group_to_draft(ctx, esc, case, "Civics", IM).action == "unchanged"

    # IM edits survive a recipient update (partial update keeps the body)
    gmail.drafts[draft_id]["body"] = "Edited by the IM"
    gmail.drafts[draft_id]["to"].append("added-by-hand@alerts.test")
    service.add_group(ctx, esc, case, "people_comms", IM)
    assert gmail.drafts[draft_id]["body"] == "Edited by the IM" and "people-comms@alerts.test" in gmail.drafts[draft_id]["cc"]
    assert "added-by-hand@alerts.test" in gmail.drafts[draft_id]["to"], "recipients the IM added by hand are kept"


def test_add_group_after_alert_was_sent_drafts_reply_to_that_group(ctx, clock):
    gmail = connect(ctx, clock, IM)
    case = make_case(ctx)
    esc = service.start_escalation(ctx, case, IM, trigger="reaction", requested_by=IM)
    alert = service.draft_alert_email(ctx, esc, case)
    rfc = gmail.mark_sent(alert.draft_id)
    service.check_sent(ctx, esc)
    outcome = service.add_group_to_draft(ctx, esc, case, "stop_leaks", IM)
    assert outcome.email.purpose == "group" and outcome.action == "created"
    draft = gmail.drafts[outcome.email.draft_id]
    assert draft["to"] == ["stopleaks@alerts.test"] and draft["in_reply_to"] == rfc and draft["thread_id"] == alert.thread_id
    assert draft["subject"].startswith("Re: ")


def test_revisions_create_versions(ctx, clock, fake_llm):
    gmail = connect(ctx, clock, IM)
    case = make_case(ctx)
    esc = service.start_escalation(ctx, case, IM, trigger="reaction", requested_by=IM)
    email = service.draft_alert_email(ctx, esc, case)
    fake_llm.on("escalation.revise_email", lambda call: {"subject": "x", "body": f"Shorter v{call['prompt'].count('CURRENT')}", "notes": []})

    revised = service.revise_email(ctx, esc, "shorter, add the AIO 2K list", IM)
    assert revised.status == EmailStatus.REDRAFTED and revised.revision_requests == 1
    assert [v.version for v in revised.versions] == [1, 2] and revised.versions[-1].instruction == "shorter, add the AIO 2K list"
    assert gmail.drafts[email.draft_id]["body"].startswith("Shorter") and gmail.drafts[email.draft_id]["to"] == revised.versions[0].to
    assert "CURRENT DRAFT" in fake_llm.calls[-1]["prompt"] and fake_llm.calls[-1]["model"] == ctx.config.models.drafting
    req = events(ctx, EventType.EMAIL_REVISION_REQUESTED)
    assert req[0].payload == {"purpose": "alert", "instruction": "shorter, add the AIO 2K list"} and req[0].actor == IM
    assert events(ctx, EventType.EMAIL_REDRAFTED)[0].payload["version"] == 2

    service.revise_email(ctx, esc, "even shorter", IM)
    assert [v.version for v in esc.email_for("alert").versions] == [1, 2, 3]

    # Gemini down: the draft is left unchanged and the email waits for the IM
    fake_llm.handlers.pop("escalation.revise_email")
    failed = service.revise_email(ctx, esc, "add a timestamp", IM)
    assert failed.status == EmailStatus.REVISION_REQUESTED and "edit the draft in Gmail" in failed.error
    assert len(failed.versions) == 3 and failed.revision_requests == 3

    gmail.mark_sent(email.draft_id)
    with pytest.raises(UserFacingError, match="already sent"):
        service.revise_email(ctx, esc, "one more", IM)


def test_check_sent_sla_met_and_email_sent_payload(ctx, clock):
    gmail = connect(ctx, clock, IM)
    case = make_case(ctx)  # SLA 15 min, due 18:15 UTC
    esc = service.start_escalation(ctx, case, IM, trigger="auto_urgent", requested_by="agent")
    email = service.draft_alert_email(ctx, esc, case)
    clock.advance(minutes=10)
    gmail.mark_sent(email.draft_id, "<sent-1@mail.test>")
    assert service.check_sent(ctx, esc)[0].status == EmailStatus.SENT
    stored = ctx.store.get_case(case.case_id)
    assert stored.sla_met is True and stored.alert_email_message_ids == ["<sent-1@mail.test>"]
    met = events(ctx, EventType.SLA_MET)
    assert len(met) == 1 and met[0].case_id == case.case_id
    assert {k: met[0].payload[k] for k in ("track", "platform_tier", "sla_minutes", "due_at")} == {
        "track": "URGENT", "platform_tier": "strong", "sla_minutes": 15, "due_at": case.sla_due_at.isoformat()}
    sent = events(ctx, EventType.EMAIL_SENT)[0]
    assert sent.payload == {"purpose": "alert", "flag_to_send_s": 600.0, "versions": 1, "post_to_send_s": 600.0}
    sent_email = ctx.store.get_escalation(esc.escalation_id).email_for("alert")
    assert sent_email.rfc822_message_id == "<sent-1@mail.test>" and sent_email.sent_at == clock.now
    assert service.check_sent(ctx, esc) == []  # nothing open any more


def test_check_sent_sla_missed_once(ctx, clock):
    gmail = connect(ctx, clock, IM)
    late = make_case(ctx)
    esc = service.start_escalation(ctx, late, IM, trigger="reaction", requested_by=IM)
    email = service.draft_alert_email(ctx, esc, late)
    clock.advance(minutes=20)
    gmail.mark_sent(email.draft_id)
    service.check_sent(ctx, esc)
    assert ctx.store.get_case(late.case_id).sla_met is False and len(events(ctx, EventType.SLA_MISSED)) == 1

    # run_followups already decided the SLA (sla_met=False): a later send emits email.sent but no second SLA event
    decided = make_case(ctx)
    decided.sla_met = False
    ctx.store.save_case(decided)
    esc2 = service.start_escalation(ctx, decided, IM, trigger="reaction", requested_by=IM)
    email2 = service.draft_alert_email(ctx, esc2, decided)
    gmail.mark_sent(email2.draft_id)
    service.check_sent(ctx, esc2)
    assert len(events(ctx, EventType.SLA_MISSED)) == 1 and len(events(ctx, EventType.EMAIL_SENT)) == 2

    # limited tier (no SLA): no SLA event at all
    limited = make_case(ctx, platform="LinkedIn", platform_tier="limited", sla_minutes=None)
    esc3 = service.start_escalation(ctx, limited, IM, trigger="reaction", requested_by=IM)
    gmail.mark_sent(service.draft_alert_email(ctx, esc3, limited).draft_id)
    service.check_sent(ctx, esc3)
    assert ctx.store.get_case(limited.case_id).sla_met is None and not events(ctx, EventType.SLA_MET)


def test_bcc_placement(ctx, clock):
    gmail = connect(ctx, clock, IM)
    ctx.config.escalation.recipients_in = "bcc"
    case = make_case(ctx, sensitive_topics=["Politics"], engagement_total=900)  # under 2K: Politics is why it's urgent -> Civics
    esc = service.start_escalation(ctx, case, IM, trigger="reaction", requested_by=IM)
    email = service.draft_alert_email(ctx, esc, case)
    draft = gmail.drafts[email.draft_id]
    assert draft["to"] == ["sender@alerts.test"] and draft["cc"] == []
    assert GEMINI_PA in draft["bcc"] and CIVICS in draft["bcc"]
    assert email.versions[0].to == ["sender@alerts.test"]
    assert events(ctx, EventType.EMAIL_DRAFTED)[0].payload["bcc"] == len(draft["bcc"])


def test_not_connected_fails_cleanly(ctx, clock):
    case = make_case(ctx)
    esc = service.start_escalation(ctx, case, IM, trigger="auto_urgent", requested_by="agent")
    no_gateway = service.draft_alert_email(ctx, esc, case)  # ctx.gmail is None
    assert no_gateway.status == EmailStatus.FAILED and "isn't configured" in no_gateway.error

    connect(ctx, clock)  # gateway present, IM not connected
    email = service.draft_alert_email(ctx, esc, case)
    assert email.status == EmailStatus.FAILED and "connect it in the Agent Console" in email.error
    assert len(esc.emails) == 1, "a FAILED attempt replaces the previous FAILED one"
    failed = events(ctx, EventType.EMAIL_FAILED)
    assert [e.payload["reason"] for e in failed] == ["not_connected", "not_connected"]
    assert failed[-1].payload["purpose"] == "alert" and failed[-1].escalation_id == esc.escalation_id
    assert "Connect Gmail in the Agent Console" in service.draft_note(ctx, esc, email)

    ctx.gmail.connect(IM)  # after connecting, the next attempt drafts
    assert service.draft_alert_email(ctx, esc, case).status == EmailStatus.DRAFTED


def test_mime_round_trip_and_partial_merge():
    msg = build_mime(from_header="Brand Social <sender@alerts.test>", to=["a@alerts.test"], cc=["c@alerts.test"],
                     bcc=["d@alerts.test"], subject="Line one\nInjected: header", body="Hi – there",
                     in_reply_to="<orig@mail>", references=["<root@mail>"])
    fields = message_fields(decode_message(encode_message(msg)))
    assert fields["subject"] == "Line one Injected: header", "no header injection"
    assert fields["bcc"] == ["d@alerts.test"] and fields["references"] == "<root@mail> <orig@mail>"
    merged = message_fields(merge_mime(decode_message(encode_message(msg)), {"cc": ["c@alerts.test", "e@alerts.test"]}))
    assert merged["cc"] == ["c@alerts.test", "e@alerts.test"] and merged["body"].strip() == "Hi – there"


def test_fake_gmail_threads_belong_to_one_mailbox(clock):
    gmail = FakeGmail(connected={IM, IM2}, clock=clock)
    first = gmail.create_draft(IM, from_header="f", to=["a"], cc=[], bcc=[], subject="s", body="b")
    with pytest.raises(Exception):
        gmail.create_draft(IM2, from_header="f", to=["a"], cc=[], bcc=[], subject="Re: s", body="b",
                           thread_id=first["thread_id"])
    clock.advance(minutes=1)
    gmail.mark_sent(first["draft_id"])
    status = gmail.draft_status(IM, first["draft_id"], first["thread_id"], since=clock.now - timedelta(minutes=1))
    assert status["status"] == "SENT" and status["sent_at"] == clock.now
