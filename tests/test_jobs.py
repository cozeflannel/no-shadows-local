"""Jobs: SLA nudges/misses, reminders, Burson chain, digest, handover, Path B parity, Agent Engine app."""

from datetime import datetime, timezone

import pytest

from conftest import GOOD_ALERT, make_message
from test_triage import alert, ok_llm
from triage_agent.events import EventType
from triage_agent.models import CaseStatus
from triage_agent.operations import handle

JOB = {"deliver": "outbox", "flow": "job", "invoked_by": "job:test"}


@pytest.fixture(autouse=True)
def _llm(fake_llm):
    ok_llm(fake_llm)


def run(ctx, *steps):
    return handle({"op": "run_followups", "payload": {"steps": list(steps)}, "context": JOB}, ctx)


def outbox(ctx, target=None):
    items = ctx.store.list_outbox(undelivered_only=True)
    return [i for i in items if target is None or i.target == target]


def triage(ctx, text, **kw):
    return handle({"op": "triage_message", "payload": {"message": make_message(text, **kw)}}, ctx)


def test_sla_nudge_then_breach_then_miss(ctx, clock):
    cid = triage(ctx, GOOD_ALERT).outputs["case_id"]  # X -> 15 min SLA
    clock.advance(minutes=10)
    run(ctx, "sla")
    dms = outbox(ctx, "dm")
    assert len(dms) == 1 and dms[0].recipients == ["im1@ops.test"] and cid in dms[0].text
    run(ctx, "sla")
    assert len(outbox(ctx, "dm")) == 1, "no duplicate nudge"
    clock.advance(minutes=6)
    run(ctx, "sla", "sla_misses")
    assert any("SLA passed" in i.text for i in outbox(ctx, "team"))
    assert len(ctx.events.query(types=[EventType.SLA_MISSED])) == 1
    run(ctx, "sla_misses")
    assert len(ctx.events.query(types=[EventType.SLA_MISSED])) == 1, "SLA decided once"
    assert ctx.store.get_case(cid).sla_met is False


def test_acknowledged_alert_gets_no_nudge(ctx, clock):
    cid = triage(ctx, GOOD_ALERT).outputs["case_id"]
    case = ctx.store.get_case(cid)
    case.acknowledged_at = clock.now
    ctx.store.save_case(case)
    clock.advance(minutes=20)
    run(ctx, "sla")
    assert not outbox(ctx, "dm")


def test_review_reminders_escalate_to_leads(ctx, clock, fake_llm):
    ok_llm(fake_llm, exposure_tag_fit={"ok": False, "confidence": 0.6, "proposed_value": "Product - Unexpected Responses"})
    triage(ctx, alert(30))
    clock.advance(minutes=11)
    run(ctx, "reviews")
    assert outbox(ctx, "dm")[-1].recipients == ["im1@ops.test"]
    clock.advance(minutes=11)
    run(ctx, "reviews")
    assert set(outbox(ctx, "dm")[-1].recipients) == set(ctx.config.lead_emails())


def test_burson_chain_and_abandon(ctx, clock):
    cid = triage(ctx, alert(31, Author="")).outputs["case_id"]
    assert ctx.store.get_case(cid).status == CaseStatus.FAILED
    clock.advance(minutes=31)
    run(ctx, "burson")
    assert "Reminder" in outbox(ctx, "burson")[-1].text
    clock.advance(minutes=30)
    run(ctx, "burson")
    assert "burson2@agency.test" in outbox(ctx, "burson")[-1].text  # backup
    clock.advance(minutes=60)
    run(ctx, "burson")
    assert outbox(ctx, "dm")[-1].recipients == ["im1@ops.test"]
    clock.advance(minutes=120)
    run(ctx, "burson")
    assert ctx.store.get_case(cid).status == CaseStatus.ABANDONED


def test_burson_digest_once_per_day(ctx, fake_llm):
    triage(ctx, alert(32, Product="Gems"))
    run(ctx, "digest")
    posts = outbox(ctx, "burson")
    assert len(posts) == 1 and "Daily QA digest" in posts[0].text and "Product ×1" in posts[0].text
    run(ctx, "digest")
    assert len(outbox(ctx, "burson")) == 1


def test_handover_after_shift_end(ctx, clock):
    triage(ctx, GOOD_ALERT)
    clock.now = datetime(2026, 10, 12, 22, 10, tzinfo=timezone.utc)  # 6:10 pm ET: AMER late ended at 6:00
    run(ctx, "handover")
    team = outbox(ctx, "team")
    assert len(team) == 1 and "Shift handover: AMER late" in team[0].text
    assert outbox(ctx, "handover"), "appended to the Handover doc via the Outbox flow"
    run(ctx, "handover")
    assert len(outbox(ctx, "team")) == 1
    on_demand = handle({"op": "generate_handover", "payload": {}}, ctx)
    assert on_demand.outputs["has_team"] == "yes"


def _row(n, **kw):
    base = {
        "alert_id": f"a{n}", "alerted_at": "2026-10-12T17:59:00+00:00", "alert_track": "HIGH_ENGAGEMENT",
        "alert_name": "[HIGH ENGAGEMENT][NEW] Gemini App – Gemini fabricates academic citations",
        "issue_name": "Gemini fabricates academic citations", "issue_status": "NEW / not previously reported over the past 14 days",
        "priority": "P1", "exposure_tag": "Product - Factual inaccuracies (not dangerous/offensive)", "product": "Gemini App",
        "social_network": "X (Twitter)", "post_url": f"https://x.com/techwatcher/status/18451234567890{n:05d}",
        "post_content": "Asked Gemini for sources and it invented three papers.", "author": "@techwatcher",
        "total_engagement": 2450, "likes": 2000, "comments": 300, "shares": 150, "is_kof": False, "risk_tags": [],
        "relevance_score": 0.8, "language": "en",
    }
    base.update(kw)
    return base


def test_inhouse_parity_mode_records_and_matches(ctx, clock):
    ctx.config.inhouse.enabled = True
    burson = triage(ctx, alert(40)).outputs["case_id"]
    resp = handle({"op": "ingest_inhouse", "payload": {"rows": [_row(40), _row(41)]}, "context": JOB}, ctx)
    assert resp.data["processed"] == 2 and not outbox(ctx, "clean"), "parity mode posts nothing"
    match = ctx.events.query(types=[EventType.PARITY_MATCHED])
    assert match and match[0].payload["counterpart_case_id"] == burson
    again = handle({"op": "ingest_inhouse", "payload": {"rows": [_row(40)]}, "context": JOB}, ctx)
    assert again.data["skipped"] == 1
    clock.advance(hours=3)
    run(ctx, "parity")
    sides = {e.payload["side"] for e in ctx.events.query(types=[EventType.PARITY_UNMATCHED])}
    assert sides == {"inhouse_only"}


def test_inhouse_after_cutover_posts_one_alert_per_message(ctx):
    ctx.config.inhouse.enabled = True
    ctx.config.inhouse.parity_mode = False
    handle({"op": "ingest_inhouse", "payload": {"rows": [_row(50), _row(51)]}, "context": JOB}, ctx)
    clean = outbox(ctx, "clean")
    assert len(clean) == 2 and all(i.text.count("TRG-") == 1 for i in clean)


def test_agent_engine_app(tmp_path, monkeypatch):
    monkeypatch.setenv("TRIAGE_BACKEND", "local")
    monkeypatch.setenv("TRIAGE_LOCAL_DB", str(tmp_path / "ae.db"))
    monkeypatch.setenv("TRIAGE_LLM", "fake")
    from triage_agent.agent_engine_app import TriageAgentApp

    app = TriageAgentApp()
    app.set_up()
    out = app.query(op="health")
    assert out["ok"] and "triage_message" in out["data"]["operations"]
    assert len([k for k in out["outputs"] if k.startswith("has_")]) == 9


def test_parity_diffs_read_burson_then_inhouse(ctx, clock):
    ctx.config.inhouse.enabled = True
    triage(ctx, alert(42))  # Burson: HIGH_ENGAGEMENT, P1 factual inaccuracies
    handle({"op": "ingest_inhouse", "payload": {"rows": [_row(42, exposure_tag="Product - Dangerous results (e.g. medical/legal)",
                                                               priority="P0")]}, "context": JOB}, ctx)
    diffs = ctx.events.query(types=[EventType.PARITY_MATCHED])[0].payload["diffs"]
    assert diffs["exposure_tag"] == ["Product - Factual inaccuracies (not dangerous/offensive)",
                                     "Product - Dangerous results (e.g. medical/legal)"]
