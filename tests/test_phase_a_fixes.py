"""Phase A safety fixes (see the review findings): each test reproduces the original defect.

Run: TRIAGE_LLM=fake .venv/bin/python -m pytest -q tests/test_phase_a_fixes.py
"""

from __future__ import annotations

import pytest
from pydantic import BaseModel, ValidationError

from a2_fixtures import IM, make_case
from conftest import BURSON_SPACE, GOOD_ALERT, make_message
from test_triage import ok_llm
from triage_agent import operations
from triage_agent.converse import intents
from triage_agent.converse.handler import try_passive_shift_signin
from triage_agent.escalation import service, tns
from triage_agent.events import EventType
from triage_agent.models import ChatMessage, ChatOutputs
from triage_agent.oncall.roster import person_for_sender
from triage_agent.operations import RetryableError, handle, is_retryable
from triage_agent.qa import parser
from triage_agent.qa.pipeline import run_qa

BURSON_PERSON = "burson2@agency.test"  # config roster burson: burson2
JOB = {"deliver": "outbox", "flow": "job", "invoked_by": "job:test"}


# ---------------------------------------------------------------------------
# 1. Infra errors during a Studio delivery are retryable (no silently dropped alerts)
# ---------------------------------------------------------------------------


class _Payload(BaseModel):
    n: int


def _validation_error() -> ValidationError:
    try:
        _Payload.model_validate({"n": "x"})
    except ValidationError as exc:
        return exc
    raise AssertionError("expected a ValidationError")


def test_is_retryable_classification():
    assert is_retryable("triage_message", RuntimeError("firestore 503")) is True
    assert is_retryable("record_reaction", ConnectionError("bigquery")) is True
    assert is_retryable("converse", KeyError("x")) is True
    assert is_retryable("ingest_email", TimeoutError()) is True
    assert is_retryable("triage_message", _validation_error()) is False, "a bad payload fails the same way every time"
    assert is_retryable("run_followups", RuntimeError("job crash")) is False, "jobs rerun on their own schedule"
    assert is_retryable("review_decision", RetryableError("x")) is True, "explicit RetryableError always wins"


def test_store_failure_during_triage_is_reported_retryable(ctx, fake_llm, monkeypatch):
    ok_llm(fake_llm)

    def boom(case):
        raise RuntimeError("Firestore unavailable")

    monkeypatch.setattr(ctx.store, "save_case", boom)
    res = handle({"op": "triage_message", "payload": {"message": make_message(GOOD_ALERT, message_id="m-infra-1")}}, ctx)
    assert res.ok is False and res.retryable is True
    assert all(v == "no" for k, v in res.outputs.items() if k.startswith("has_"))
    err = ctx.events.query(types=[EventType.ERROR])[-1]
    assert err.payload["retryable"] is True and err.payload["error_type"] == "RuntimeError"
    # nothing cached and the claim released: Studio's retry will be processed, not replayed
    assert ctx.store.get_idempotent("msg:m-infra-1") is None
    assert ctx.store.claim_idempotent("msg:m-infra-1") is True


def test_job_failure_is_not_retryable(ctx):
    operations._load_handlers()
    saved = dict(operations._REGISTRY)

    @operations.operation("run_followups")
    def _failing(ctx, payload, rc):
        raise RuntimeError("job crash")

    try:
        res = handle({"op": "run_followups", "payload": {}, "context": JOB}, ctx)
    finally:
        operations._REGISTRY.clear()
        operations._REGISTRY.update(saved)
    assert res.ok is False and res.retryable is False


# ---------------------------------------------------------------------------
# 2. Shift sign-in: no roster changes from ordinary sentences
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("text", [
    "I'm on it, will loop back to you by 5pm",
    "I'm on the fence about this tag",
    "I'm on the call with Jon until 3",
    "I'm on PTO until 4pm, can you check this one?",
    "on my way, back on by 3pm",
    "I am on vacation from Monday to Friday",
])
def test_sign_in_regex_ignores_ordinary_sentences(ctx, text):
    intent = intents.match_regex(text, ctx.config)
    assert intent is None or intent.name != "oncall_set", (text, intent)


@pytest.mark.parametrize("text, until", [
    ("I'm on until 6pm", "6pm"),
    ("I'm on", ""),  # the agent asks "Until when?"
    ("Hi team, I will be on alerts from 12pm to 6pm PST", "6pm PST"),
    ("I'm on call till 9pm ET", "9pm ET"),
    ("signing in on alerts until 5pm", "5pm"),
    ("taking over alerts through 6pm", "6pm"),
    ("I'm on shift 2pm to 10pm", "10pm"),
    ("I'm covering for Sam until 7pm", "7pm"),
])
def test_sign_in_regex_keeps_real_sign_ins(ctx, text, until):
    intent = intents.match_regex(text, ctx.config)
    assert intent is not None and intent.name == "oncall_set", text
    assert intent.args.get("until", "") == until


def _burson_msg(text, *, email=BURSON_PERSON, name="Jordan Patel", message_id="m-signin"):
    return ChatMessage.model_validate(make_message(text, sender_name=name, sender_email=email, sender_type="HUMAN",
                                                   message_id=message_id, **BURSON_SPACE))


def test_passive_sign_in_false_positive_leaves_roster_alone(ctx):
    before = ctx.burson_on_call().person.id
    assert try_passive_shift_signin(ctx, _burson_msg("I'm on it, will loop back to you by 5pm"), rosters=("burson",)) is None
    assert ctx.burson_on_call().person.id == before
    assert not [o for o in ctx.roster("burson").overrides if o.set_via == "chat"]


def test_passive_sign_in_still_works_for_real_sign_in_and_curly_apostrophe(ctx):
    res = try_passive_shift_signin(ctx, _burson_msg("I\u2019m on until 8pm ET"), rosters=("burson",))  # Chat's ’
    assert res and res["roster"] == "burson" and res["person_id"] == "burson2"
    assert ctx.burson_on_call().person.id == "burson2"


def test_passive_sign_in_identity_is_the_email_when_known(ctx):
    # A known email that isn't on the roster must not borrow a roster member's display name.
    msg = _burson_msg("I'm on until 8pm ET", email="someone.else@agency.test", name="Jordan Patel")
    assert try_passive_shift_signin(ctx, msg, rosters=("burson",)) is None
    # With no email at all (Studio hides external members' emails) the display name is all we have.
    msg = _burson_msg("I'm on until 8pm ET", email="", name="Jordan Patel")
    assert try_passive_shift_signin(ctx, msg, rosters=("burson",))["person_id"] == "burson2"


def test_burson_space_flow_never_touches_the_im_roster(ctx):
    im_before = ctx.im_on_shift().person.email
    res = handle({"op": "triage_message", "payload": {"message": make_message(
        "I'm on until 8pm ET", sender_name="IM", sender_email=IM, sender_type="HUMAN", message_id="m-im-in-burson",
        **BURSON_SPACE)}}, ctx)
    assert res.outputs["summary"] == "not an alert" and "signin" not in res.data
    assert ctx.im_on_shift().person.email == im_before


def test_person_for_sender_rules(ctx):
    roster = ctx.roster("burson")
    assert person_for_sender(roster, BURSON_PERSON, "Nobody").id == "burson2"
    assert person_for_sender(roster, "unknown@agency.test", "Jordan Patel") is None
    assert person_for_sender(roster, None, "Jordan Patel").id == "burson2"
    assert person_for_sender(roster, "", None) is None


# ---------------------------------------------------------------------------
# 3. Parser: the priority banner and a [Priority] label don't concatenate
# ---------------------------------------------------------------------------


def test_priority_banner_plus_label_is_not_duplicated(ctx):
    text = "THIS ALERT MEETS P0 CRITERIA\n" + GOOD_ALERT.replace("Priority: P1", "Priority: P0")
    assert "Priority:" in text, "fixture has a Priority label"
    parsed = parser.parse(ctx.config, text)
    assert parsed.fields["priority"] == "P0"
    assert parsed.extra["banner_priority"] == "P0"


def test_repeated_label_still_appends(ctx):
    parsed = parser.parse(ctx.config, "Alert Name: first\nAlert Name: second\nIssue Name: x\nProduct: Search")
    assert parsed.fields["alert_name"] == "first\nsecond"


# ---------------------------------------------------------------------------
# 4. Path B: one poison row doesn't block the feed
# ---------------------------------------------------------------------------


def _row(n, **kw):
    base = {
        "alert_id": f"p{n}", "alerted_at": "2026-10-12T17:59:00+00:00", "alert_track": "HIGH_ENGAGEMENT",
        "alert_name": "[HIGH ENGAGEMENT][NEW] Gemini App – Gemini fabricates academic citations",
        "issue_name": "Gemini fabricates academic citations", "issue_status": "NEW", "priority": "P1",
        "exposure_tag": "Product - Factual inaccuracies (not dangerous/offensive)", "product": "Gemini App",
        "social_network": "X (Twitter)", "post_url": f"https://x.com/techwatcher/status/19990000000000{n:05d}",
        "post_content": "Asked Gemini for sources and it invented three papers.", "author": "@techwatcher",
        "total_engagement": 2450, "likes": 2000, "comments": 300, "shares": 150, "is_kof": False, "risk_tags": [],
        "relevance_score": 0.8, "language": "en",
    }
    base.update(kw)
    return base


def test_inhouse_poison_row_is_isolated_and_retried(ctx, fake_llm, monkeypatch):
    ok_llm(fake_llm)
    from triage_agent import inhouse

    real = inhouse.row_to_parsed

    def flaky(ctx_, row):
        if row["alert_id"] == "p2":
            raise RuntimeError("bad row")
        return real(ctx_, row)

    monkeypatch.setattr(inhouse, "row_to_parsed", flaky)
    res = handle({"op": "ingest_inhouse", "payload": {"rows": [_row(1), _row(2), _row(3), {"no_id": True}]}, "context": JOB}, ctx)
    assert res.ok
    assert res.data["processed"] == 2 and res.data["failed"] == ["p2"] and res.data["no_id"] == 1
    assert "failed 1" in res.outputs["summary"]
    errs = [e for e in ctx.events.query(types=[EventType.ERROR]) if e.payload.get("alert_id") == "p2"]
    assert errs and errs[0].payload["retryable"] is True
    assert ctx.store.find_case_by_source_ref("inhouse", "p1") and ctx.store.find_case_by_source_ref("inhouse", "p3")
    assert ctx.store.find_case_by_source_ref("inhouse", "p2") is None

    monkeypatch.setattr(inhouse, "row_to_parsed", real)  # the feed recovers: the next run picks p2 up
    again = handle({"op": "ingest_inhouse", "payload": {"rows": [_row(1), _row(2), _row(3)]}, "context": JOB}, ctx)
    assert again.data["processed"] == 1 and again.data["skipped"] == 2 and again.data["failed"] == []


# ---------------------------------------------------------------------------
# 5. Unknown Sonar relevance labels don't fail the URGENT gates
# ---------------------------------------------------------------------------


def _sensitive(ctx, relevance):
    parsed = parser.parse(ctx.config, GOOD_ALERT)
    parsed.fields["risk_tags"] = ["Child Safety"]
    parsed.extra["relevance_score"] = relevance
    return run_qa(ctx, parsed, source="inhouse", received_at=ctx.now())


def test_unknown_relevance_label_is_treated_as_unknown(ctx, fake_llm):
    ok_llm(fake_llm)
    known = _sensitive(ctx, "very_high").assessment
    unknown = _sensitive(ctx, "strong match (new label)").assessment
    missing = _sensitive(ctx, None).assessment
    assert "SENSITIVE_TOPIC" in known.reason_codes
    assert "SENSITIVE_TOPIC" in missing.reason_codes
    assert "SENSITIVE_TOPIC" in unknown.reason_codes, "an unrecognised label must not silently fail the 1.0 gate"
    low = _sensitive(ctx, "low").assessment
    assert "SENSITIVE_TOPIC" not in low.reason_codes, "known low relevance still gates"


# ---------------------------------------------------------------------------
# 6. T&S: placeholder entry ids are flagged in the ✍️ reply
# ---------------------------------------------------------------------------


def test_tns_prepared_message_warns_while_entry_ids_are_placeholders(ctx, fake_llm):
    fake_llm.on("tns.assess", {"eligible": True, "category": "Harmful hallucination", "criteria_ids": ["gemini_hallucination"],
                               "rationale": "ok", "evidence": "input_shown", "description": "desc"})
    case = make_case(ctx, ts_recommended=True, ts_reasons=["Gemini hallucination"], engagement_total=150)
    esc = service.start_escalation(ctx, case, IM, trigger="reaction", requested_by=IM)
    state = tns.assess_and_prepare(ctx, esc, case, IM)
    ctx.config.tns.is_placeholder = True
    assert "field ids haven't been verified" in tns.prepared_message(ctx, esc, case, state)
    ctx.config.tns.is_placeholder = False
    assert "field ids haven't been verified" not in tns.prepared_message(ctx, esc, case, state)


# ---------------------------------------------------------------------------
# 7. Stealth mode: env override, applied exactly once
# ---------------------------------------------------------------------------


def test_stealth_env_override_and_single_application(ctx, monkeypatch):
    ctx.config.burson_feedback.silent_in_burson_space = False
    monkeypatch.delenv("TRIAGE_STEALTH_BURSON", raising=False)
    assert operations.stealth_enabled(ctx) is False
    monkeypatch.setenv("TRIAGE_STEALTH_BURSON", "true")
    assert operations.stealth_enabled(ctx) is True

    ctx.config.env = "shadow"
    out = ChatOutputs(burson_text="🤖 Needs Burson · TRG-1", clean_text="🤖 clean")
    final, _ = operations._finalize(ctx, operations.OperationRequest(op="triage_message"), out, {})
    assert final.burson_text == ""
    assert final.clean_text.count("[STEALTH — would post to Burson]") == 1
    assert final.clean_text.startswith("[SHADOW → clean]")
