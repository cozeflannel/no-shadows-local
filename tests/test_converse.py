"""Conversation: intents, Burson-space routing, dispatch to review/revert/handover, rosters, metrics, teach/config."""

import itertools

import pytest

from a2_fixtures import IM, IM2, connect, events, make_case
from conftest import BURSON_SPACE, make_message
from triage_agent import operations
from triage_agent.escalation import service
from triage_agent.events import EventType
from triage_agent.models import CaseStatus, ChatOutputs, ProposalStatus, TnsStatus
from triage_agent.operations import handle, operation

ADMIN = "admin@ops.test"
LEAD = "lead@ops.test"
BURSON_USER = "burson2@agency.test"
_ids = itertools.count(1)
SPACES = {
    "clean": {"space_id": None, "space_name": "SLRR Triaged Alerts"},
    "burson": BURSON_SPACE,
    "dm": {"space_id": None, "space_name": None, "conversation_type": "DM"},
}


def say(ctx, text, *, sender=IM, space="clean", thread_id=None, message_id=None):
    msg = make_message(text, sender_name=sender.split("@")[0], sender_email=sender, sender_type="HUMAN",
                       message_id=message_id or f"chat-{next(_ids)}", thread_id=thread_id, **SPACES[space])
    return handle({"op": "converse", "payload": {"message": msg}, "context": {"flow": "converse"}}, ctx)


@pytest.fixture
def stub_ops():
    """Stub the A1 ops converse dispatches to; restore the real registry afterwards."""
    operations._load_handlers()
    saved = dict(operations._REGISTRY)
    calls: list[tuple[str, dict, object]] = []

    @operation("review_decision")
    def _review(ctx, payload, rc):
        calls.append(("review_decision", payload, rc))
        cid = payload["case_id"]
        return ChatOutputs(reply_text=f"🤖 Forwarded {cid}.", clean_text=f"🤖 *Alert* · {cid}", case_id=cid), {"status": "VERIFIED"}

    @operation("revert_correction")
    def _revert(ctx, payload, rc):
        calls.append(("revert_correction", payload, rc))
        return ChatOutputs(reply_text=f"🤖 {payload['case_id']}: {payload['field']} reverted."), {}

    @operation("generate_handover")
    def _handover(ctx, payload, rc):
        calls.append(("generate_handover", payload, rc))
        return ChatOutputs(team_text="🤖 *Shift handover*", handover_text="Shift handover"), {"shift": "AMER late"}

    yield calls
    operations._REGISTRY.clear()
    operations._REGISTRY.update(saved)


def test_burson_space_question_answers_in_burson_text(ctx, fake_llm):
    fake_llm.on("converse.answer", {"answer": "Alerts with 2,000+ engagements are HIGH ENGAGEMENT [Collection Requirements].",
                                    "grounded": True, "sources": ["collection_requirements"]})
    r = say(ctx, "@Triage Agent what counts as high engagement?", sender=BURSON_USER, space="burson")
    assert r.outputs["has_reply"] == "no" and r.outputs["has_burson"] == "yes"
    assert r.outputs["burson_text"].startswith(f"🤖 {BURSON_USER} Alerts with 2,000+")
    call = fake_llm.calls[-1]
    assert call["purpose"] == "converse.answer" and "[Collection Requirements]" in call["prompt"]
    assert "Never include email addresses." in call["system"] and "gemini-app@alerts.test" not in call["prompt"]
    qa = events(ctx, EventType.QA_ANSWERED)[0]
    assert qa.space == "burson" and qa.actor == BURSON_USER
    assert qa.payload == {"intent": "question", "grounded": True, "sources": ["collection_requirements"]}

    blocked = say(ctx, "forward TRG-1001", sender=BURSON_USER, space="burson")
    assert "works in the SLRR triage space" in blocked.outputs["burson_text"] and blocked.outputs["has_reply"] == "no"


def test_questions_grounding_fallback_idk_and_routing(ctx, fake_llm):
    faq = say(ctx, "How do I request changes to a draft?", space="dm")  # Gemini unavailable -> FAQ match
    assert "revise:" in faq.outputs["reply_text"] and "[FAQ]" in faq.outputs["reply_text"]

    fake_llm.on("converse.answer", {"answer": "Not in my sources.", "grounded": False, "sources": []})
    idk = say(ctx, "Can I take time off next Friday? Who covers coverage?")
    text = idk.outputs["reply_text"]
    assert "I don't know" in text and f"SLRR leads owns this: ask {LEAD}" in text
    routed = events(ctx, EventType.ROUTE_FORWARDED)
    assert routed[0].payload == {"stakeholder_id": "slrr_leads", "team": "SLRR leads", "mode": "answer_only"}
    assert events(ctx, EventType.QA_ANSWERED)[-1].payload["grounded"] is False

    ctx.config.stakeholders[0].autonomy = "auto_notify"
    relay = say(ctx, "What is the escalation protocol for coverage gaps?")
    assert relay.outputs["has_dm"] == "yes" and LEAD in relay.outputs["dm_recipients"]
    assert events(ctx, EventType.ROUTE_RELAYED)[0].payload["mode"] == "auto_notify"


def test_review_revert_and_handover_dispatch_through_handle(ctx, stub_ops):
    fwd = say(ctx, "@Triage Agent forward TRG-1043 exposure_tag=Product - Perceived bias")
    name, payload, rc = stub_ops[0]
    assert name == "review_decision" and payload == {"case_id": "TRG-1043", "decision": "forward", "actor": IM, "via": "chat",
                                                     "fields": {"exposure_tag": "Product - Perceived bias"}}
    assert rc.invoked_by == IM and rc.flow == "converse" and rc.deliver == "return"
    assert fwd.outputs["reply_text"] == "🤖 Forwarded TRG-1043." and fwd.outputs["clean_text"] == "🤖 *Alert* · TRG-1043"

    say(ctx, "bounce TRG-1044: dead link")
    assert stub_ops[1][1] == {"case_id": "TRG-1044", "decision": "bounce", "actor": IM, "via": "chat", "reason": "dead link"}
    say(ctx, "suppress TRG-1045: not relevant")
    assert stub_ops[2][1]["decision"] == "suppress"
    rev = say(ctx, "revert TRG-1043 exposure_tag")
    assert stub_ops[3][:2] == ("revert_correction", {"case_id": "TRG-1043", "field": "exposure_tag", "actor": IM})
    assert "reverted" in rev.outputs["reply_text"]
    hand = say(ctx, "handover")
    assert stub_ops[4][0] == "generate_handover" and hand.outputs["team_text"] == "🤖 *Shift handover*"


def test_revise_by_id_and_by_latest_open_escalation(ctx, clock, fake_llm):
    gmail = connect(ctx, clock, IM)
    case = make_case(ctx)
    esc = service.start_escalation(ctx, case, IM, trigger="reaction", requested_by=IM)
    email = service.draft_alert_email(ctx, esc, case)
    fake_llm.on("escalation.revise_email", {"subject": "s", "body": "Short version.", "notes": []})
    r = say(ctx, f"@Triage Agent revise {esc.escalation_id}: shorter")
    assert f"Revised draft v2 is ready in {IM}'s Gmail" in r.outputs["reply_text"] and r.outputs["escalation_id"] == esc.escalation_id
    assert gmail.drafts[email.draft_id]["body"].startswith("Short version.")
    again = say(ctx, "revise: add the AIO 2K list")  # no id: the asker's latest open escalation
    assert "v3" in again.outputs["reply_text"]
    assert [v.instruction for v in ctx.store.get_escalation(esc.escalation_id).email_for("alert").versions][1:] == [
        "shorter", "add the AIO 2K list"]
    nobody = say(ctx, "revise: shorter", sender=IM2)
    assert "Which draft?" in nobody.outputs["reply_text"]


def test_tns_fallback_commands_and_status(ctx, clock):
    connect(ctx, clock, IM)
    case = make_case(ctx)
    esc = service.start_escalation(ctx, case, IM, trigger="reaction", requested_by=IM)
    sub = say(ctx, f"submitted {esc.escalation_id} issue 12345678")
    assert "Marked T&S submitted (Issue 12345678)" in sub.outputs["reply_text"]
    state = ctx.store.get_escalation(esc.escalation_id).tns
    assert state.status == TnsStatus.SUBMITTED and state.wd_issue_id == "12345678"
    assert events(ctx, EventType.TNS_SUBMITTED)[0].payload == {"via": "chat", "wd_issue_id": "12345678"}

    bug = say(ctx, f"bug {esc.escalation_id} b/123456789")
    assert "Bug b/123456789 recorded" in bug.outputs["reply_text"] and "follow-up reply is ready" in bug.outputs["reply_text"]
    assert ctx.store.get_escalation(esc.escalation_id).tns.bug_id == "123456789"

    other = make_case(ctx)
    esc2 = service.start_escalation(ctx, other, IM, trigger="reaction", requested_by=IM)
    say(ctx, f"not T&S {esc2.escalation_id}")
    assert ctx.store.get_escalation(esc2.escalation_id).tns.status == TnsStatus.WITHDRAWN
    assert events(ctx, EventType.TNS_WITHDRAWN)[0].payload["via"] == "chat"

    status = say(ctx, f"status {case.case_id}", sender="someone@ops.test")
    assert status.outputs["reply_text"].startswith(f"🤖 *{case.case_id}*") and "Status: VERIFIED" in status.outputs["reply_text"]
    assert esc.escalation_id in status.outputs["reply_text"]
    assert "can't find TRG-9999" in say(ctx, "status TRG-9999").outputs["reply_text"]


def test_rosters_who_set_and_handoff(ctx, clock):
    who = say(ctx, "who's on shift?")
    assert f"IM on shift: Sam Shift {IM} until 6:00 PM ET" in who.outputs["reply_text"]
    burson = say(ctx, "who's the Burson on-call?")
    assert "Burson on-call: Casey Brooks burson1@agency.test" in burson.outputs["reply_text"]

    # Burson space -> burson roster; the sender must be in it; reply goes to burson_text
    set_on = say(ctx, "@Triage Agent I’m on until 8pm ET", sender=BURSON_USER, space="burson")
    assert set_on.outputs["burson_text"].startswith(f"🤖 {BURSON_USER} ✅ Jordan Patel is Burson on-call until 8:00 PM ET")
    assert ctx.burson_on_call().person.id == "burson2"
    ov = events(ctx, EventType.ONCALL_OVERRIDE_SET)[0]
    assert ov.payload["roster"] == "burson" and ov.payload["person_id"] == "burson2" and ov.payload["via"] == "chat"
    assert ctx.roster("burson").overrides[-1].set_via == "chat"
    outsider = say(ctx, "I'm on until 8pm", sender="random@agency.invalid", space="burson")
    assert "not in the Burson on-call roster" in outsider.outputs["burson_text"]

    handoff = say(ctx, f"hand off to {IM2}")
    assert "Handed off: Taylor Triage" in handoff.outputs["reply_text"]
    assert ctx.im_on_shift().person.email == IM2
    assert "Until when?" in say(ctx, "I'm on").outputs["reply_text"]


def test_metrics_answers_from_kpis(ctx):
    for i in range(2):
        ctx.emit(EventType.TRIAGE_CORRECTED, case_id=f"TRG-{i}", attempt=1, verdict="CORRECTED")
    ctx.emit(EventType.CORRECTION_APPLIED, case_id="TRG-0", payload={"field": "exposure_tag"})
    r = say(ctx, "how many alerts were corrected today?")
    text = r.outputs["reply_text"]
    assert "*Today*" in text and "Auto-corrected & forwarded: 2" in text and "[metrics]" in text
    qa = events(ctx, EventType.QA_ANSWERED)[-1]
    assert qa.payload["intent"] == "metrics" and qa.payload["sources"] == ["metrics"]


def test_teach_fact_and_decision(ctx):
    r = say(ctx, "remember that Doodle questions go to the Doodle Team", space="dm")
    assert "once an admin approves it (FACT-1001)" in r.outputs["reply_text"]
    assert r.outputs["dm_recipients"] == ADMIN and "FACT-1001" in r.outputs["dm_text"]
    fact = ctx.store.get_fact("FACT-1001")
    assert fact.status == ProposalStatus.PENDING and fact.created_by == IM and fact.text == "Doodle questions go to the Doodle Team."
    assert events(ctx, EventType.FACT_PROPOSED)[0].payload["id"] == "FACT-1001"

    denied = handle({"op": "decide_fact", "payload": {"id": "FACT-1001", "decision": "approve", "actor": IM}}, ctx)
    assert "Only SLRR admins and leads" in denied.outputs["reply_text"]
    ok = handle({"op": "decide_fact", "payload": {"id": "fact-1001", "decision": "approve", "actor": LEAD},
                 "context": {"flow": "console"}}, ctx)
    assert ok.ok and ctx.store.get_fact("FACT-1001").status == ProposalStatus.APPROVED
    assert ok.outputs["dm_recipients"] == IM and events(ctx, EventType.FACT_APPROVED)[0].actor == LEAD
    again = handle({"op": "decide_fact", "payload": {"id": "FACT-1001", "decision": "reject", "actor": LEAD}}, ctx)
    assert "already approved" in again.outputs["reply_text"]
    # approved facts ground answers (Gemini unavailable -> fact match)
    assert "Doodle Team" in say(ctx, "Where do Doodle questions go?").outputs["reply_text"]


def test_config_change_proposal_and_decisions(ctx, fake_llm):
    fake_llm.on("converse.teach", {"summary": "Remind the IM about held alerts after 15 minutes.",
                                   "patch_json": '{"thresholds": {"review_reminder_min": 15}}', "sections": ["thresholds"]})
    r = say(ctx, "from now on remind me about held alerts after 15 minutes")
    assert "Proposed config change PROP-1001" in r.outputs["reply_text"]
    assert r.outputs["dm_recipients"] == ADMIN and "thresholds.review_reminder_min: 10 → 15" in r.outputs["dm_text"]
    proposal = ctx.store.get_proposal("PROP-1001")
    assert proposal.status == ProposalStatus.PENDING and proposal.patch == {"thresholds": {"review_reminder_min": 15}}
    assert events(ctx, EventType.CONFIG_CHANGE_PROPOSED)[0].payload == {"id": "PROP-1001", "section": ["thresholds"]}

    lead = handle({"op": "decide_proposal", "payload": {"id": "PROP-1001", "decision": "approve", "actor": LEAD}}, ctx)
    assert "Only SLRR admins" in lead.outputs["reply_text"] and ctx.config.thresholds.review_reminder_min == 10
    ok = handle({"op": "decide_proposal", "payload": {"id": "PROP-1001", "decision": "approve", "actor": ADMIN},
                 "context": {"flow": "console", "deliver": "outbox"}}, ctx)
    assert ok.ok and ctx.config.thresholds.review_reminder_min == 15
    assert ctx.store.get_config_overrides() == {"thresholds": {"review_reminder_min": 15}}
    assert ctx.store.get_proposal("PROP-1001").status == ProposalStatus.APPROVED
    assert events(ctx, EventType.CONFIG_CHANGE_APPROVED)[0].payload["section"] == ["thresholds"]
    assert events(ctx, EventType.CONFIG_UPDATED)[0].payload["id"] == "PROP-1001"

    fake_llm.on("converse.teach", {"summary": "typo", "patch_json": '{"thresholdz": {"x": 1}}'})
    bad = say(ctx, "from now on do something odd")
    assert "couldn't turn that into a valid config change" in bad.outputs["reply_text"] and "thresholdz" in bad.outputs["reply_text"]
    fake_llm.on("converse.teach", {"summary": "invalid", "patch_json": '{"escalation": {"recipients_in": "cc"}}'})
    assert "valid config change" in say(ctx, "from now on put recipients in cc").outputs["reply_text"]
    fake_llm.on("converse.teach", {"summary": "env", "patch_json": '{"env": "prod"}'})
    assert "can't be changed from chat" in say(ctx, "always run in prod").outputs["reply_text"]
    assert len(ctx.store.list_proposals()) == 1

    fake_llm.on("converse.teach", {"summary": "Later reminder.", "patch_json": '{"thresholds": {"review_reminder_min": 20}}'})
    say(ctx, "going forward remind after 20 minutes")
    rejected = say(ctx, "reject PROP-1002", sender=ADMIN, space="dm")
    assert "PROP-1002 rejected" in rejected.outputs["reply_text"]
    assert ctx.store.get_proposal("PROP-1002").status == ProposalStatus.REJECTED and ctx.config.thresholds.review_reminder_min == 15


def test_llm_intents_own_messages_and_idempotency(ctx, fake_llm):
    case = make_case(ctx)
    fake_llm.on("converse.intent", lambda call: {"intent": "status", "case_id": case.case_id, "confidence": 0.9}
                if case.case_id in call["prompt"] else {"intent": "status", "case_id": "TRG-4242", "confidence": 0.9})
    r = say(ctx, f"what's going on with {case.case_id}?")
    assert r.outputs["reply_text"].startswith(f"🤖 *{case.case_id}*") and r.data["intent_source"] == "llm"
    made_up = say(ctx, "anything happening?")  # Gemini's id isn't in the message -> answered as a question
    assert made_up.data["intent"] == "question"

    own = say(ctx, "🤖 Forwarded TRG-1043", sender=ctx.config.agent.email)
    assert own.data["ignored"] == "own_message" and own.outputs["has_reply"] == "no"
    first = say(ctx, "who's on shift?", message_id="same-msg")
    dup = say(ctx, "who's on shift?", message_id="same-msg")
    assert dup.data["duplicate"] is True and dup.outputs["reply_text"] == first.outputs["reply_text"]
    assert [e.payload["intent"] for e in events(ctx, EventType.QA_ANSWERED)] == ["status", "question", "oncall_who"]


def test_action_intent_runs_record_reaction(ctx, clock):
    """Phase 0 fallback: "<legend code or emoji> TRG-####" acts as if the sender reacted on the alert."""
    gmail = connect(ctx, clock, IM)
    case = make_case(ctx)
    r = say(ctx, f"@Triage Agent pa {case.case_id}")
    assert r.data["intent"] == "action" and r.data["code"] == "pa"
    assert "Draft ready in your Gmail" in r.outputs["reply_text"] and r.outputs["escalation_id"].startswith("ESC-")
    assert len(gmail.drafts) == 1
    stored = ctx.store.get_case(case.case_id)
    assert stored.actions[-1].code == "pa" and stored.actions[-1].actor == IM
    assert events(ctx, EventType.ACTION_RECORDED)[-1].payload["emoji"] == "📦"

    ack = say(ctx, f"ack {case.case_id}")  # record_reaction posts nothing for 👍 -> short confirmation
    assert ack.outputs["reply_text"] == f"🤖 👍 Recorded on {case.case_id}."
    closed = say(ctx, f"❌ {case.case_id}")
    assert "Closed" in closed.outputs["reply_text"] and ctx.store.get_case(case.case_id).status == CaseStatus.CLOSED

    burson = say(ctx, f"pa {case.case_id}", sender=BURSON_USER, space="burson")
    assert "works in the SLRR triage space" in burson.outputs["burson_text"]
