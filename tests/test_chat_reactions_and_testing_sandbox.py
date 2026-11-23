"""Tests for source-space + mirror/clean-space emoji reaction reading and full Testing sandbox enforcement."""

from __future__ import annotations

from conftest import GOOD_ALERT
from test_chat_delivery import space_of, switches
from test_console_api import ADMIN, IM, api, console_ctx, seeded  # noqa: F401 - fixtures
from test_platform import assess_ok
from test_routing import MIR, PAT, SRC, route, world  # noqa: F401 - fixtures
from triage_agent.models import CaseStatus
from triage_agent.operations import handle
from triage_agent.platform_jobs import run_job


def test_source_space_im_reaction_acknowledges_case_without_duplicate_draft_or_sla_warning(api, world):
    """Exact TRG-1061 scenario: IM reacts in source space within 1 minute -> copied to mirror AND marks Case acked."""
    clean = space_of(api, "clean")
    team = space_of(api, "team")
    world.add_space(clean, "SLRR Triaged Alerts")
    world.add_space(team, "24/7 SL Team")
    assess_ok(api.ctx.llm)
    safe = {**api.ctx.config.platform.safety.model_dump(mode="json"), "testing": True, "testing_recipients": ["tester@qa.test"]}
    assert api.put("/api/platform/safety", {"value": safe, "note": "test"}).status_code == 200
    route(api, bot_on=True, source=SRC, mirror=MIR, copy_everything=True, safety_valve=True)
    switches(api, chat_review=True, chat_delivery=True)

    src_msg = world.say(SRC, GOOD_ALERT)
    world.clock.advance(seconds=30)
    # IM reacts with skin-toned thumbs-up in source space within 30 seconds
    world.emoji(src_msg, "👍🏽", user="users/im1")
    world.clock.advance(seconds=30)

    res = run_job(api.ctx, "maintenance")
    assert res["jobs"]["chat_review"]["reviewed"] == 1
    case_id = api.ctx.store.list_docs("chat_review", limit=10)[0]["case_id"]
    assert case_id.startswith("TRG-")

    # Next tick: mirror._emojis copies emoji onto MIR AND acknowledges the Case (if not already acked during review)
    world.clock.advance(minutes=1)
    run_job(api.ctx, "maintenance")

    case = api.ctx.store.get_case(case_id)
    assert case is not None
    assert case.acknowledged_at is not None, "IM reaction in source space must acknowledge the Case"
    assert any(a.code == "ack" and a.actor == "source_im" for a in case.actions)
    # Copied emoji in MIR must NOT trigger a second analyst action in MIR
    assert [a for a in case.actions if a.actor != "source_im"] == []

    # Advance past 60m SLA: even if followups were explicitly invoked, 0 SLA overdue warnings fire for our acked Case
    world.clock.advance(minutes=60)
    handle({"op": "run_followups", "payload": {"steps": ["sla"]}, "context": {"deliver": "outbox", "flow": "job"}}, api.ctx)
    refreshed = api.ctx.store.get_case(case_id)
    assert refreshed.oncall_notices == []
    assert [i for i in api.ctx.store.list_outbox(undelivered_only=False, limit=200)
            if i.case_id == case_id and i.source == "sla_risk"] == []
    assert world.texts(team) == []


def test_direct_analyst_reaction_on_mirrored_copy_or_clean_post_triggers_action_and_draft_to_tester(api, world):
    """Reacting directly in the mirror/clean space (either on the mirrored alert copy OR the TRG- post) runs record_reaction."""
    clean = space_of(api, "clean")
    world.add_space(clean, "SLRR Triaged Alerts")
    assess_ok(api.ctx.llm)
    safe = {**api.ctx.config.platform.safety.model_dump(mode="json"), "testing": True, "testing_recipients": ["tester@qa.test"]}
    assert api.put("/api/platform/safety", {"value": safe, "note": "test"}).status_code == 200
    route(api, bot_on=True, source=SRC, mirror=MIR, copy_everything=True, safety_valve=True)
    switches(api, chat_review=True, chat_delivery=True)

    world.say(SRC, GOOD_ALERT)
    world.clock.advance(minutes=1)
    run_job(api.ctx, "maintenance")

    case_id = api.ctx.store.list_docs("chat_review", limit=10)[0]["case_id"]
    mirrored_msg = world.messages[MIR][0]["name"]
    assert "TRG-" not in world.messages[MIR][0]["text"], "mirrored alert copy does not contain TRG- id"

    # Analyst reacts ❌ directly on the mirrored alert copy in MIR
    world.emoji(mirrored_msg, "❌", user=PAT["name"])
    world.clock.advance(minutes=1)
    res = run_job(api.ctx, "maintenance")
    assert res["jobs"]["chat_reactions"]["acted"] == 1
    case = api.ctx.store.get_case(case_id)
    assert case.status == CaseStatus.CLOSED and case.closed_reason == "no_action"
    assert case.acknowledged_at is not None
    assert any("Closed" in t for t in world.texts(MIR)), "confirmation reply posted in MIR thread"
    assert len(world.messages[SRC]) == 1, "nothing ever written back to the source space while Testing is ON"


def test_scheduled_followups_requires_switch_and_testing_sandbox_blocks_team_space(api, world):
    """Scheduled followups (empty payload) queues 0 nudges when followups switch is OFF, and even when ON, Testing holds team."""
    clean = space_of(api, "clean")
    team = space_of(api, "team")
    world.add_space(clean, "SLRR Triaged Alerts")
    world.add_space(team, "24/7 SL Team")
    assess_ok(api.ctx.llm)
    safe = {**api.ctx.config.platform.safety.model_dump(mode="json"), "testing": True, "testing_recipients": ["tester@qa.test"]}
    assert api.put("/api/platform/safety", {"value": safe, "note": "test"}).status_code == 200
    route(api, bot_on=True, source=SRC, mirror=MIR, copy_everything=True, safety_valve=True)
    switches(api, chat_review=True, chat_delivery=True)
    assert api.ctx.config.platform.flags.followups is False

    world.say(SRC, GOOD_ALERT)
    world.clock.advance(minutes=1)
    run_job(api.ctx, "maintenance")

    # Let SLA expire with NO reaction
    world.clock.advance(minutes=90)
    scheduled = run_job(api.ctx, "followups")
    assert "sla" not in scheduled["data"], "scheduled followups must not run sla_nudges while followups switch is OFF"
    assert world.texts(team) == []

    # Turn followups switch ON while Testing (Safety valve) remains ON: DM goes only to tester, team post is HELD!
    switches(api, chat_review=True, chat_delivery=True, followups=True)
    scheduled_on = run_job(api.ctx, "followups")
    assert scheduled_on["data"]["sla"] >= 1
    world.clock.advance(minutes=1)
    run_job(api.ctx, "maintenance")
    assert world.texts(team) == [], "Testing sandbox must hold SLA overdue posts from ever reaching 24/7 SL Team"
