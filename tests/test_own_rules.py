"""Own alerts: the rules. They are kept in the store, which the Console reads, and copied to BigQuery, where each new
post is checked against them. Stand-ins: tests/own_helpers.py (no network)."""

from __future__ import annotations

import pytest

from own_helpers import HOME, SONAR, row, set_up
from triage_agent.ownalerts import cycle, rules

ADMIN = "admin@ops.test"
RECALL = {"rule_name": "Recall or safety notice", "process_doc_section": "4.2 Product safety", "execution_mode": "HARD_MANDATE",
          "required_keywords_any": ["recall", " Safety Notice ", ""], "platforms": ["X", "Reddit", "x"], "forced_severity": "P0",
          "forced_escalation_path": "LEGAL"}


@pytest.fixture
def world(ctx, monkeypatch):
    gw, dlp = set_up(ctx, monkeypatch)
    ctx.config.platform.flags.bigquery_admin = True
    return gw, dlp


def merges(gw) -> list[dict]:
    return [r for r in gw.ran if r["sql"].startswith("MERGE `proj.slrr_triage_agent.policy_rules_config`")]


def test_a_rule_is_kept_tidied_and_copied_to_bigquery(ctx, world):
    gw, _ = world
    rule = rules.save(ctx, ADMIN, RECALL)
    assert rule.rule_id.startswith("rule-") and rule.updated_by == ADMIN and rule.updated_at == ctx.now() and rule.active is True
    assert rule.required_keywords_any == ["recall", "Safety Notice"] and rule.platforms == ["x", "reddit"]
    assert [r.rule_id for r in rules.list_rules(ctx)] == [rule.rule_id]
    (merge,) = merges(gw)
    p = merge["params"]
    assert merge["location"] == "US" and "WHEN NOT MATCHED THEN INSERT" in merge["sql"] and "updated_at = CURRENT_TIMESTAMP()" in merge["sql"]
    assert p["rule_id"] == rule.rule_id and p["rule_name"] == "Recall or safety notice" and p["execution_mode"] == "HARD_MANDATE"
    assert p["required_keywords_any"] == ["recall", "Safety Notice"] and p["required_keywords_all"] == [] and p["excluded_keywords"] == []
    assert p["target_sources"] == [] and p["platforms"] == ["x", "reddit"] and p["require_kof"] is False
    assert (p["min_followers"], p["min_engagements"], p["forced_severity"], p["forced_escalation_path"], p["active"], p["updated_by"]) == (
        0, 0, "P0", "LEGAL", True, ADMIN)
    assert not rules.pending(ctx)
    assert [e.payload["rule_id"] for e in ctx.events.query(types=["own.rule_saved"])] == [rule.rule_id]


def test_changing_a_rule_keeps_its_id(ctx, world):
    first = rules.save(ctx, ADMIN, RECALL)
    second = rules.save(ctx, "lead@ops.test", {**RECALL, "rule_id": first.rule_id, "active": False, "min_followers": 5000})
    assert second.rule_id == first.rule_id and second.active is False and second.min_followers == 5000 and second.updated_by == "lead@ops.test"
    assert len(rules.list_rules(ctx)) == 1


@pytest.mark.parametrize("change,why", [
    ({"rule_name": "  "}, "name"),
    ({"execution_mode": "MAYBE"}, "mandatory"),
    ({"forced_severity": "P9"}, "severities"),
    ({"forced_escalation_path": "NOBODY"}, "paths"),
    ({"required_keywords_any": [], "platforms": []}, "at least one condition"),
    ({"target_sources": ["no_such_source"]}, "no_such_source"),
    ({"min_followers": -1}, "followers"),
])
def test_a_rule_that_cannot_work_is_refused_with_the_reason(ctx, world, change, why):
    with pytest.raises(ValueError, match=why):
        rules.save(ctx, ADMIN, {**RECALL, **change})
    assert rules.list_rules(ctx) == []


def test_a_rule_may_name_any_source_that_is_read_and_leave_severity_to_the_review(ctx, world):
    own = ctx.config.platform.own_alerts
    own.brandwatch_queries, own.other_alerts_space = ["2004167929"], "spaces/AAAAother1234"
    rule = rules.save(ctx, ADMIN, {"rule_name": "KOF on any feed", "process_doc_section": "2.1", "execution_mode": "SOFT_CANDIDATE", "require_kof": True,
                                   "target_sources": ["sonar", "brandwatch_api", "other_alerts"], "forced_severity": "", "forced_escalation_path": ""})
    assert rule.target_sources == ["sonar", "brandwatch_api", "other_alerts"] and rule.forced_severity == "" and rule.require_kof is True


def test_a_rule_saved_while_bigquery_refuses_is_kept_and_copied_by_the_next_run(ctx, clock, world):
    gw, _ = world
    gw.fail = "MERGE `proj.slrr_triage_agent.policy_rules_config`"
    rule = rules.save(ctx, ADMIN, RECALL)
    assert [r.rule_id for r in rules.list_rules(ctx)] == [rule.rule_id] and rules.pending(ctx)
    gw.fail = ""
    gw.source_rows[SONAR] = [row(1)]
    cycle.run(ctx)
    order = [("merge" if r["sql"].startswith("MERGE `proj.slrr_triage_agent.policy_rules_config`") else "call") for r in gw.ran
             if r["sql"].startswith(("MERGE `proj.slrr_triage_agent.policy_rules_config`", "CALL "))]
    assert order == ["merge", "call"], "the rules reach BigQuery before the posts are checked against them"
    assert not rules.pending(ctx)


def test_the_first_run_copies_every_rule_after_it_creates_the_tables(ctx, world):
    gw, _ = world
    gw.fail = "MERGE `proj.slrr_triage_agent.policy_rules_config`"
    rules.save(ctx, ADMIN, RECALL)
    rules.save(ctx, ADMIN, {**RECALL, "rule_name": "Second rule"})
    gw.fail = ""
    cycle.run(ctx)
    assert len(merges(gw)) == 2
    sweep = next(r for r in gw.ran if r["sql"].startswith(f"DELETE FROM `{HOME}.policy_rules_config`"))
    assert sorted(sweep["params"]["ids"]) == sorted(r.rule_id for r in rules.list_rules(ctx)), "rows for rules that are gone are removed"


def test_removing_a_rule_takes_it_out_of_the_store_and_bigquery(ctx, world):
    gw, _ = world
    rule = rules.save(ctx, ADMIN, RECALL)
    assert rules.delete(ctx, ADMIN, rule.rule_id) is True and rules.list_rules(ctx) == []
    gone = gw.ran[-1]
    assert gone["sql"] == f"DELETE FROM `{HOME}.policy_rules_config` WHERE rule_id = @rule_id" and gone["params"] == {"rule_id": rule.rule_id}
    assert rules.delete(ctx, ADMIN, "rule-unknown") is False
