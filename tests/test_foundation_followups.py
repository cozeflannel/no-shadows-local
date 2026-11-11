"""Foundation follow-ups requested by workstream A2 (message-ref lookup, nested dispatch, Bcc history, speed KPI)."""

import pytest

from a2_fixtures import IM, connect, make_case, reaction
from triage_agent import operations
from triage_agent.escalation import service
from triage_agent.events import EventType
from triage_agent.ids import message_key
from triage_agent.metrics import compute_kpis
from triage_agent.models import ChatOutputs
from triage_agent.operations import UserFacingError, handle, operation


def test_message_key_variants():
    assert message_key("spaces/AAQ/messages/BBB.BBB") == "BBB.BBB"
    assert message_key("https://chat.google.com/room/AAQ/BBB/CCC?cls=10") == "CCC"
    assert message_key("https://mail.google.com/chat/u/0/#chat/space/AAQ/CCC") == "CCC"
    assert message_key(" CCC/ ") == "CCC"
    assert message_key("") is None and message_key(None) is None


def test_find_case_by_message_ref_uses_stored_key(ctx):
    case = make_case(ctx)
    case.clean_message_ref = "spaces/CLEAN/messages/m-77.m-77"
    ctx.store.save_case(case)
    other = make_case(ctx)  # never posted: no key
    assert other.clean_message_key is None
    assert ctx.store.get_case(case.case_id).clean_message_key == "m-77.m-77"
    assert ctx.store.find_case_by_message_ref("spaces/CLEAN/messages/m-77.m-77").case_id == case.case_id
    assert ctx.store.find_case_by_message_ref("https://chat.google.com/room/CLEAN/m-77/m-77.m-77?cls=10").case_id == case.case_id
    assert ctx.store.find_case_by_message_ref("spaces/CLEAN/messages/unknown") is None
    assert ctx.store.find_case_by_message_ref("") is None


def test_reaction_without_case_id_finds_case_by_message_ref(ctx, clock):
    connect(ctx, clock, IM)
    case = make_case(ctx)
    case.clean_message_ref = "spaces/CLEAN/messages/m-88.m-88"
    ctx.store.save_case(case)
    resp = handle({"op": "record_reaction", "payload": reaction("👍", text="(no id in this text)",
                                                                message_id="spaces/CLEAN/messages/m-88.m-88")}, ctx)
    assert resp.ok and resp.outputs["case_id"] == case.case_id


@pytest.fixture
def temp_op():
    """Register a handler for one test; restores whatever was registered under that name before."""
    operations.registered_operations()  # load the real handlers first so they can be restored
    saved = {}

    def register(name, fn):
        saved.setdefault(name, operations._REGISTRY.get(name))
        operation(name)(fn)

    yield register
    for name, previous in saved.items():
        if previous is None:
            operations._REGISTRY.pop(name, None)
        else:
            operations._REGISTRY[name] = previous


def test_dispatch_returns_raw_outputs_and_handle_finalizes_once(ctx, temp_op):
    temp_op("_t_raw", lambda c, p, rc: (ChatOutputs(burson_text="fix it", clean_text="hello", dm_text="psst",
                                                    dm_recipients=["a@ops.test"]), {"k": 1}))
    ctx.config.burson_feedback.silent_in_burson_space = True  # stealth: a rule only handle() applies
    out, data = operations.dispatch("_t_raw", {}, ctx)
    assert (out.burson_text, out.clean_text, out.dm_recipients, data) == ("fix it", "hello", ["a@ops.test"], {"k": 1})
    resp = handle({"op": "_t_raw", "payload": {}}, ctx)
    assert resp.outputs["burson_text"] == ""
    assert resp.outputs["clean_text"] == "hello\n\n[STEALTH — would post to Burson] fix it"
    assert (resp.outputs["dm_text"], resp.outputs["dm_recipients"]) == ("psst", "a@ops.test")
    with pytest.raises(UserFacingError):
        operations.dispatch("_t_missing", {}, ctx)


def test_converse_nested_op_errors_answer_in_chat(ctx, temp_op):
    def boom(c, p, rc):
        raise RuntimeError("kaboom")

    temp_op("generate_handover", boom)  # replaces the real op for this test only
    resp = handle({"op": "converse", "payload": {"message": {
        "text": "@Triage Agent handover", "message_id": "spaces/CLEAN/messages/h1",
        "sender": {"email": IM, "name": "IM", "type": "HUMAN"}, "space_name": "SLRR Triaged Alerts"}}}, ctx)
    assert resp.ok
    assert "kaboom" in resp.outputs["reply_text"]
    assert any(e.payload.get("nested_in") == "converse" for e in ctx.events.query(types=[EventType.ERROR]))


def test_bcc_mode_keeps_bcc_in_version_history(ctx, clock):
    connect(ctx, clock, IM)
    ctx.config.escalation.recipients_in = "bcc"
    case = make_case(ctx)
    esc = service.start_escalation(ctx, case, IM, trigger="reaction", requested_by=IM)
    email = service.draft_alert_email(ctx, esc, case)
    first = email.versions[0]
    assert first.to == [ctx.config.escalation.from_email] and first.bcc, first
    revised = service.revise_email(ctx, esc, "shorter", IM)
    assert revised.versions[-1].bcc == first.bcc


def test_flag_to_send_counts_alert_emails_only(ctx):
    ctx.emit(EventType.EMAIL_SENT, payload={"purpose": "alert", "flag_to_send_s": 600.0, "post_to_send_s": 900.0})
    ctx.emit(EventType.EMAIL_SENT, payload={"purpose": "tns_urgent", "flag_to_send_s": 60.0})
    ctx.emit(EventType.EMAIL_SENT, payload={"purpose": "bug_followup", "flag_to_send_s": 6000.0})
    kpis = compute_kpis(ctx.events.query(), config=ctx.config)
    derived = kpis.get("derived", kpis)
    assert derived["flag_to_send_min"] == {"avg": 10.0, "median": 10.0, "n": 1}
    assert derived["post_to_send_min"]["avg"] == pytest.approx(15.0)
