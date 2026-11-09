"""Foundation tests: config, store, events, rosters, metrics, outbox, dispatcher."""

from datetime import datetime, timedelta, timezone

from triage_agent.events import EventType
from triage_agent.metrics import KPI_DEFINITIONS, compute_kpis
from triage_agent.models import STUDIO_OUTPUT_KEYS, Case, CaseStatus, ChatOutputs, Override
from triage_agent.oncall.roster import coverage_gaps, escalation_chain, resolve_on_call
from triage_agent.operations import handle, operation


def test_config_loads_placeholder_template(ctx):
    tpl = ctx.config.alert_template
    assert tpl.id == "burson_sonar_alert_v3"
    assert not tpl.is_placeholder
    assert tpl.field("post_url").required
    assert "+" in ctx.config_version
    assert len(ctx.config.collection.exposure_tags) >= 46
    assert ctx.config.distribution.products, "distribution.yaml merged under `distribution`"


def test_config_overrides_merge(ctx):
    ctx.store.save_config_overrides({"thresholds": {"needs_review_below": 0.5}}, actor="test")
    ctx.reload_config()
    assert ctx.config.thresholds.needs_review_below == 0.5
    assert ctx.config.thresholds.llm_block_min_confidence == 0.80  # untouched sibling


def test_config_lookups(ctx):
    col, dist, cfg = ctx.config.collection, ctx.config.distribution, ctx.config
    assert col.tag("Product - Litigation").name == "Brand - Litigation"  # merged tag alias
    assert col.tag("product - perceived bias").priority == "P0"
    assert col.topic("World Politics").name == "Politics"
    assert col.tier_for("X (Twitter)").sla_minutes == 15
    assert col.tier_for("LinkedIn").sla_minutes is None
    assert col.level_for(2450) == "HIGH" and col.level_for(199) == "VERY LOW" and col.level_for(10, is_kof=True) == "VIRAL KOF"
    assert col.is_redundant("Product - Privacy & security concerns", "Privacy")
    assert dist.product("Bard").name == "Gemini App"
    gems = dist.product("Gems")
    assert gems.deprecated and gems.redirect_to == ["Gemini App"]
    assert dist.product("AI Studio").name == "Devs Products"
    assert dist.group("civics").name == "Civics" and dist.group("Stop Leaks").action_code == "stop_leaks"
    assert cfg.action("⚖️").code == "civics" and cfg.action("⚖").code == "civics"  # with/without VS16
    assert cfg.action("1️⃣").code == "exec_comms"
    assert cfg.action("📦").kind == "email_pa"
    assert cfg.space_key_for("AAQAaa_0I9g", None) == "burson"
    assert cfg.space_key_for(None, "[s-f] youtube social") == "youtube"


def test_named_rosters(ctx, clock):
    assert ctx.im_on_shift().person.id == "im1"
    assert ctx.burson_on_call().person.id == "burson1"
    roster = ctx.roster("burson")
    saturday = datetime(2026, 10, 17, 16, 0, tzinfo=timezone.utc)
    assert resolve_on_call(roster, saturday).source == "backup"
    roster.overrides.append(
        Override(override_id="o1", person_id="burson2", start=clock.now - timedelta(hours=1),
                 end=clock.now + timedelta(hours=2), set_by="test", created_at=clock.now)
    )
    res = resolve_on_call(roster, clock.now)
    assert (res.person.id, res.source) == ("burson2", "override")
    assert [p.id for p in escalation_chain(roster, clock.now)] == ["burson2", "burson_lead"]
    gaps = coverage_gaps(roster, clock.now.replace(hour=4), clock.now.replace(hour=4) + timedelta(days=1))
    assert gaps, "nights should be uncovered in the seed Burson roster"
    im_gaps = coverage_gaps(ctx.roster("slrr_im"), clock.now, clock.now + timedelta(days=2))
    assert not im_gaps, "follow-the-sun IM shifts cover 24/7"


def test_store_ids_cases(ctx, clock):
    assert ctx.store.next_id("TRG") == "TRG-1001"
    case = Case(case_id="TRG-1001", record_key="x.com/a", status=CaseStatus.FAILED, source="burson_chat",
                exposure_tag="Brand - Litigation", created_at=clock.now, updated_at=clock.now)
    ctx.store.save_case(case)
    inhouse = Case(case_id="TRG-1002", record_key="x.com/a", status=CaseStatus.VERIFIED, source="inhouse",
                   source_ref="abc123", created_at=clock.now, updated_at=clock.now)
    ctx.store.save_case(inhouse)
    assert ctx.store.find_case_by_record_key("x.com/a", source="burson_chat").case_id == "TRG-1001"
    assert ctx.store.find_case_by_source_ref("inhouse", "abc123").case_id == "TRG-1002"
    assert [c.case_id for c in ctx.store.list_cases(exposure_tag="brand - litigation")] == ["TRG-1001"]
    ctx.store.put_kv("handover:last", {"shift": "AMER late"})
    assert ctx.store.get_kv("handover:last")["shift"] == "AMER late"


def test_outbox_doorbell_and_drain(ctx, clock):
    a1 = ctx.enqueue("clean", "🤖 alert TRG-1", case_id="TRG-1")
    clock.advance(seconds=1)
    ctx.enqueue("clean", "🤖 alert TRG-2", case_id="TRG-2")
    for i in range(3):
        clock.advance(seconds=1)
        ctx.enqueue("team", f"🤖 team note {i}")
    clock.advance(seconds=1)
    ctx.enqueue("dm", "🤖 to IM", recipients=["im@ops.test"])
    clock.advance(seconds=1)
    ctx.enqueue("dm", "🤖 to leads", recipients=["lead@ops.test"])
    assert len(ctx.doorbell.rings) == 7 and ctx.doorbell.rings[0] == a1.outbox_id

    first = handle({"op": "drain_outbox", "context": {"flow": "outbox"}}, ctx)
    assert first.ok and first.outputs["has_clean"] == "yes" and "TRG-1" in first.outputs["clean_text"]
    assert "TRG-2" not in first.outputs["clean_text"], "one alert per clean-space message"
    assert first.outputs["team_text"].count("team note") == 3
    assert first.outputs["dm_recipients"] == "im@ops.test"
    assert first.outputs["case_id"] == "TRG-1"

    second = handle({"op": "drain_outbox"}, ctx)
    assert "TRG-2" in second.outputs["clean_text"] and second.outputs["dm_recipients"] == "lead@ops.test"
    assert second.outputs["has_team"] == "no"
    third = handle({"op": "drain_outbox"}, ctx)
    assert third.outputs["has_clean"] == "no" and third.data["delivered_ids"] == []
    assert ctx.events.query(types=[EventType.OUTBOX_DELIVERED])


@operation("_test_multi_target")
def _multi_target(ctx, payload, rc):
    return ChatOutputs(reply_text="🤖 done", team_text="🤖 heads-up TRG-9", dm_text="🤖 dm", dm_recipients=["a@ops.test"], case_id="TRG-9")


def test_unsupported_targets_are_queued_not_dropped(ctx):
    resp = handle({"op": "_test_multi_target", "context": {"targets": ["reply", "clean"]}}, ctx)
    assert resp.outputs["has_reply"] == "yes" and resp.outputs["has_team"] == "no" and resp.outputs["has_dm"] == "no"
    assert sorted(resp.data["rerouted_to_outbox"]) == ["dm", "team"]
    queued = {i.target for i in ctx.store.list_outbox()}
    assert queued == {"team", "dm"}


def test_outbox_delivery_mode_queues_everything(ctx):
    resp = handle({"op": "_test_multi_target", "context": {"deliver": "outbox"}}, ctx)
    assert all(resp.outputs[k] == "no" for k in ("has_reply", "has_team", "has_dm"))
    assert resp.data["reply_text"] == "🤖 done" and len(resp.data["queued_outbox_ids"]) == 2


def test_shadow_mode_labels_and_redirects_dms(ctx):
    ctx.config.env = "shadow"
    resp = handle({"op": "_test_multi_target"}, ctx)
    assert resp.outputs["team_text"].startswith("[SHADOW → team]")
    assert resp.outputs["dm_text"].startswith("[SHADOW → would DM a@ops.test]")
    assert resp.outputs["dm_recipients"] == ",".join(ctx.config.admin_emails())


def test_metrics_v3(ctx):
    ctx.emit(EventType.TRIAGE_FAILED, case_id="TRG-1", attempt=1, verdict="FAIL", error_codes=["post_url:required"])
    ctx.emit(EventType.TRIAGE_PASSED, case_id="TRG-1", attempt=2, verdict="PASS", payload={"after_bounce": True, "time_to_correction_s": 1800})
    ctx.emit(EventType.TRIAGE_PASSED, case_id="TRG-2", attempt=1, verdict="PASS")
    ctx.emit(EventType.TRIAGE_CORRECTED, case_id="TRG-3", attempt=1, verdict="CORRECTED")
    ctx.emit(EventType.CORRECTION_APPLIED, case_id="TRG-3", payload={"field": "exposure_tag"})
    ctx.emit(EventType.TRIAGE_SUPPRESSED, case_id="TRG-4", attempt=1, verdict="SUPPRESSED", payload={"reason": "below_threshold"})
    ctx.emit(EventType.SLA_MET, case_id="TRG-2", payload={"track": "URGENT", "platform_tier": "strong"})
    ctx.emit(EventType.SLA_MISSED, case_id="TRG-3", payload={"track": "URGENT", "platform_tier": "strong"})
    ctx.emit(EventType.EMAIL_DRAFTED, escalation_id="ESC-1", payload={"purpose": "alert"})
    ctx.emit(EventType.EMAIL_DRAFTED, escalation_id="ESC-1", payload={"purpose": "tns_urgent"})
    ctx.emit(EventType.TNS_OUTCOME, escalation_id="ESC-1", payload={"outcome": "Fixed", "bug_id": "123456789"})
    result = compute_kpis(ctx.events.query(), config=ctx.config)
    k, d = result["kpis"], result["derived"]
    assert set(k) == set(KPI_DEFINITIONS)
    assert (k["sent_back_for_edits"], k["burson_reruns_passed"], k["forwarded_without_edits"]) == (1, 1, 1)
    assert (k["auto_corrected"], k["suppressed"], k["tns_urgent_emails"], k["tns_fixed"]) == (1, 1, 1, 1)
    assert d["first_pass_yield"] == round(1 / 4, 3)
    assert d["corrections_by_field"] == {"exposure_tag": 1}
    assert d["suppressed_by_reason"] == {"below_threshold": 1}
    assert d["sla_met_pct"] == 0.5 and d["sla_by_track"]["URGENT"]["met"] == 1
    assert d["time_to_correction_min"]["avg"] == 30.0
    assert d["time_saved_hours"] == round((1 * 30 + 2 * 10) / 60, 1)


def test_dispatcher_always_returns_studio_keys(ctx):
    ok = handle({"op": "health"}, ctx)
    assert ok.ok and set(STUDIO_OUTPUT_KEYS) <= set(ok.outputs)
    assert len(STUDIO_OUTPUT_KEYS) == 23
    missing = handle({"op": "no_such_op", "payload": {}}, ctx)
    assert set(STUDIO_OUTPUT_KEYS) <= set(missing.outputs)
    assert all(missing.outputs[k] == "no" for k in STUDIO_OUTPUT_KEYS if k.startswith("has_"))
