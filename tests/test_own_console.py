"""Agent alerts in the Console: what its page is given, a run and the set-up started by hand, the rules, an analyst's
verdict, its settings page, and its place on the Integrations page.

The API is called through the FastAPI app. Stand-ins: tests/own_helpers.py for BigQuery, FakeLLM for Gemini.
"""

from __future__ import annotations

from typing import Any

import pytest

from own_helpers import HOME, SONAR, row, set_up
from test_insight import bigquery_card, own_secrets  # noqa: F401 - fixtures
from test_platform import ADMIN, IM, LEAD, VIEWER, _llm, client, iap  # noqa: F401 - fixtures
from triage_agent.ownalerts import review, rules, schema

QUEUE = f"FROM `{HOME}.review_queue` rq"
RULE = {"rule_name": "Recall or safety notice", "process_doc_section": "4.2 Product safety", "execution_mode": "HARD_MANDATE",
        "required_keywords_any": ["recall", "fire"], "forced_severity": "P0", "forced_escalation_path": "LEGAL"}


@pytest.fixture
def world(ctx, monkeypatch, fake_llm):
    gw, _ = set_up(ctx, monkeypatch)
    fake_llm.on("own.review", {"escalate": True, "severity": "P1", "escalation_path": "PR_COMMS", "decision_rationale": "Several owners report it."})
    ctx.config.platform.own_alerts.review_engine = "worker"
    return gw


def ready(ctx, gw) -> None:
    ctx.config.platform.flags.bigquery_admin = True
    schema.provision(ctx)
    gw.ran.clear()


def decided(ctx, gw, n: int = 1) -> dict[str, Any]:
    """One reviewed alert, as the page lists it."""
    gw.answers = [(QUEUE, [{"queue_id": f"q{n}", "item_type": "SINGLE_POST", "target_id": f"post{n}", "trigger_path": "SINGLE_POST_GEMINI",
                            "matched_rule_id": "rule-1", "rule_name": "Recall or safety notice", "evidence": "Pixel battery swelling again"}])]
    review.run(ctx)
    gw.answers = []
    return ctx.store.get_doc(review.DECISIONS, review.decision_id(f"q{n}"))


# -- the page ------------------------------------------------------------------------------------------------------------
def test_the_page_is_given_the_runs_the_sources_the_alerts_and_what_this_person_may_do(ctx, client, world):
    ready(ctx, world)
    doc = decided(ctx, world)
    got = client.get("/api/own", headers=iap(VIEWER)).json()
    state = got["state"]
    assert state["on"] is True and state["objects"] == "ready" and state["interval_minutes"] == 2
    assert [(s["label"], s["status"]) for s in state["sources"]] == [("Sprinklr comments", "not read yet"), ("Sonar", "not read yet")]
    assert state["review"]["result"] == {"reviewed": 1, "raised": 1, "passed": 0, "failed": 0, "left": 0, "posted": 0}
    assert state["post"] == {"on": False, "target": "", "space": ""} and state["kof"]["set"] is True and state["rules_pending"] is False
    assert state["severities"] == ["P0", "P1", "P2"] and state["paths"] == ["EXEC_SECURITY", "PR_COMMS", "LEGAL", "BRAND_SOCIAL"]
    assert [d["id"] for d in got["decisions"]] == [doc["id"]] and got["decisions"][0]["evidence"] == "Pixel battery swelling again"
    assert (got["can_act"], got["can_run"], got["can_edit_rules"], got["can_set_up"]) == (False, False, False, False)
    flags = lambda who: tuple(client.get("/api/own", headers=iap(who)).json()[k] for k in ("can_act", "can_run", "can_edit_rules", "can_set_up"))  # noqa: E731
    assert flags(IM) == (True, False, False, False) and flags(LEAD) == (True, True, True, False) and flags(ADMIN) == (True, True, True, True)
    assert client.get("/api/own", headers=iap("stranger@elsewhere.test")).status_code == 403


def test_the_page_names_the_space_alerts_are_posted_in(ctx, client, world):
    cfg = ctx.config.platform
    cfg.flags.own_alerts_post, cfg.own_alerts.post_target = True, "team"
    post = client.get("/api/own", headers=iap(VIEWER)).json()["state"]["post"]
    assert post == {"on": True, "target": "team", "space": ctx.config.space("team").display_name}


def test_the_page_lists_the_last_days_of_alerts_and_can_show_only_the_raised_ones(ctx, client, clock, world, fake_llm):
    ready(ctx, world)
    decided(ctx, world, 1)
    clock.advance(days=3)
    fake_llm.on("own.review", {"escalate": False, "severity": "P2", "escalation_path": "BRAND_SOCIAL", "decision_rationale": "One owner."})
    decided(ctx, world, 2)
    ids = lambda **params: [d["queue_id"] for d in client.get("/api/own", params=params, headers=iap(VIEWER)).json()["decisions"]]  # noqa: E731
    assert ids() == ["q2", "q1"] and ids(days=2) == ["q2"] and ids(status="raised") == ["q1"] and ids(status="passed") == ["q2"]


# -- by hand: a run, and the set-up --------------------------------------------------------------------------------------
def test_a_lead_can_start_a_run_now_and_it_is_on_the_record(ctx, client, world):
    ready(ctx, world)
    world.source_rows[SONAR] = [row(1), row(2)]
    assert client.post("/api/own/run", headers=iap(IM)).status_code == 403
    got = client.post("/api/own/run", headers=iap(LEAD))
    assert got.status_code == 200
    out = got.json()
    assert out["ok"] is True and out["run"]["read"] == 2 and out["run"]["staged"] == 2 and out["review"]["reviewed"] == 0
    entry = client.get("/api/audit", params={"action": "own.run"}, headers=iap(ADMIN)).json()["entries"][0]
    assert entry["actor"] == LEAD and "2 read, 2 kept" in entry["summary"]


def test_a_run_by_hand_is_refused_while_the_switch_is_off(ctx, client, world):
    ctx.config.platform.flags.own_alerts = False
    got = client.post("/api/own/run", headers=iap(LEAD))
    assert got.status_code == 403 and got.json()["error"] == 'Agent alerts is switched off. An admin can turn on "Agent alerts" under Settings, Switches.'
    assert world.ran == []


def test_an_admin_creates_the_bigquery_objects_from_the_page(ctx, client, world):
    assert client.post("/api/own/setup", headers=iap(LEAD)).status_code == 403
    off = client.post("/api/own/setup", headers=iap(ADMIN))
    assert off.status_code == 409 and "Change BigQuery from here" in off.json()["error"] and world.ran == []
    ctx.config.platform.flags.bigquery_admin = True
    got = client.post("/api/own/setup", headers=iap(ADMIN))
    assert got.status_code == 200 and got.json() == {"ok": True, "steps": len(schema.statements(ctx))}
    state = client.get("/api/own", headers=iap(VIEWER)).json()["state"]
    assert state["objects"] == "ready" and state["rules_pending"] is True, "the new rules table is empty: the rules are copied before the next run"
    entry = client.get("/api/audit", params={"action": "own.setup"}, headers=iap(ADMIN)).json()["entries"][0]
    assert entry["actor"] == ADMIN and entry["status"] == "ok"


def test_a_set_up_bigquery_refuses_says_which_step_and_is_on_the_record(ctx, client, world):
    ctx.config.platform.flags.bigquery_admin = True
    world.fail = "CREATE OR REPLACE MODEL"
    got = client.post("/api/own/setup", headers=iap(ADMIN))
    assert got.status_code == 409 and "BigQuery refused to create the model embedding_model" in got.json()["error"]
    entry = client.get("/api/audit", params={"action": "own.setup"}, headers=iap(ADMIN)).json()["entries"][0]
    assert entry["status"] == "error" and "embedding_model" in entry["summary"]


# -- the rules -----------------------------------------------------------------------------------------------------------
def test_the_rules_page_lists_the_rules_and_what_a_rule_may_name(ctx, client, world):
    rules.save(ctx, LEAD, RULE)
    got = client.get("/api/own/rules", headers=iap(VIEWER)).json()
    (rule,) = got["rules"]
    assert rule["rule_name"] == "Recall or safety notice" and rule["execution_mode"] == "HARD_MANDATE" and rule["updated_by"] == LEAD
    assert got["sources"] == [{"key": "comments", "label": "Sprinklr comments"}, {"key": "sonar", "label": "Sonar"}]
    assert got["severities"] == ["P0", "P1", "P2"] and got["paths"][0] == "EXEC_SECURITY" and got["can_edit"] is False
    assert client.get("/api/own/rules", headers=iap(LEAD)).json()["can_edit"] is True


def test_a_lead_adds_changes_and_removes_a_rule_and_each_change_is_on_the_record(ctx, client, world):
    assert client.post("/api/own/rules", json=RULE, headers=iap(IM)).status_code == 403
    made = client.post("/api/own/rules", json=RULE, headers=iap(LEAD))
    assert made.status_code == 200
    rule = made.json()["rule"]
    assert rule["rule_id"].startswith("rule-") and rule["required_keywords_any"] == ["recall", "fire"] and rule["active"] is True
    changed = client.put(f"/api/own/rules/{rule['rule_id']}", json={**RULE, "active": False, "min_followers": 5000}, headers=iap(LEAD))
    assert changed.status_code == 200 and changed.json()["rule"]["active"] is False and changed.json()["rule"]["min_followers"] == 5000
    assert [r.rule_id for r in rules.list_rules(ctx)] == [rule["rule_id"]], "changed, not added again"
    assert client.put("/api/own/rules/rule-gone", json=RULE, headers=iap(LEAD)).status_code == 404
    assert client.delete(f"/api/own/rules/{rule['rule_id']}", headers=iap(IM)).status_code == 403
    assert client.delete(f"/api/own/rules/{rule['rule_id']}", headers=iap(LEAD)).json() == {"ok": True}
    assert client.delete(f"/api/own/rules/{rule['rule_id']}", headers=iap(LEAD)).status_code == 404 and rules.list_rules(ctx) == []
    saved = client.get("/api/audit", params={"action": "own.rule_saved"}, headers=iap(ADMIN)).json()["entries"]
    removed = client.get("/api/audit", params={"action": "own.rule_removed"}, headers=iap(ADMIN)).json()["entries"]
    assert len(saved) == 2 and len(removed) == 1 and saved[0]["actor"] == LEAD and "Recall or safety notice" in saved[0]["summary"]


@pytest.mark.parametrize("change,says", [
    ({"rule_name": " "}, "Give the rule a name."),
    ({"required_keywords_any": []}, "A rule needs at least one condition"),
    ({"forced_severity": "P9"}, "must be one of the severities"),
    ({"target_sources": ["nowhere"]}, "reads no source called nowhere"),
])
def test_a_rule_that_cannot_be_kept_is_refused_in_plain_words(ctx, client, world, change, says):
    got = client.post("/api/own/rules", json={**RULE, **change}, headers=iap(LEAD))
    assert got.status_code == 422 and says in got.json()["error"] and rules.list_rules(ctx) == []


# -- an analyst's verdict --------------------------------------------------------------------------------------------------
def test_an_analyst_gives_a_verdict_and_can_change_it(ctx, client, world):
    ready(ctx, world)
    doc = decided(ctx, world)
    url = f"/api/own/decisions/{doc['id']}/verdict"
    assert client.post(url, json={"verdict": "TRUE_POSITIVE"}, headers=iap(VIEWER)).status_code == 403
    got = client.post(url, json={"verdict": "TRUE_POSITIVE"}, headers=iap(IM))
    assert got.status_code == 200
    assert (got.json()["decision"]["verdict"], got.json()["decision"]["verdict_by"]) == ("TRUE_POSITIVE", IM)
    again = client.post(url, json={"verdict": "FALSE_POSITIVE"}, headers=iap(LEAD)).json()["decision"]
    assert (again["verdict"], again["verdict_by"]) == ("FALSE_POSITIVE", LEAD) and len(world.rows_in("feedback")) == 2
    entry = client.get("/api/audit", params={"action": "own.verdict"}, headers=iap(ADMIN)).json()["entries"][0]
    assert entry["actor"] == LEAD and entry["target_id"] == doc["id"] and "False positive" in entry["summary"]


def test_a_verdict_that_cannot_be_kept_says_why(ctx, client, world):
    ready(ctx, world)
    doc = decided(ctx, world)
    url = f"/api/own/decisions/{doc['id']}/verdict"
    assert client.post(url, json={"verdict": "MAYBE"}, headers=iap(IM)).status_code == 422
    missing = client.post("/api/own/decisions/own-gone/verdict", json={"verdict": "TRUE_POSITIVE"}, headers=iap(IM))
    assert missing.status_code == 404 and missing.json()["error"] == "That alert is no longer kept."
    world.fail_insert = "feedback"
    refused = client.post(url, json={"verdict": "TRUE_POSITIVE"}, headers=iap(IM))
    assert refused.status_code == 502 and "BigQuery did not keep the verdict" in refused.json()["error"]
    assert ctx.store.get_doc(review.DECISIONS, doc["id"])["verdict"] == ""


# -- its settings page -----------------------------------------------------------------------------------------------------
def test_agent_alerts_has_its_own_settings_page(ctx, client):
    parts = {p["key"]: p for p in client.get("/api/platform", headers=iap(ADMIN)).json()["parts"]}
    assert parts["own_alerts"]["label"] == "Agent alerts" and parts["own_alerts"]["group"] == "decide"
    assert parts["own_alerts"]["description"].endswith(".")
    page = client.get("/api/platform/own_alerts", headers=iap(ADMIN)).json()
    assert page["value"]["reviews_per_minute"] == 25 and "review_seconds" in page["schema"]["properties"]
    saved = client.put("/api/platform/own_alerts", json={"value": {**page["value"], "reviews_per_minute": 10}}, headers=iap(ADMIN))
    assert saved.status_code == 200 and ctx.config.platform.own_alerts.reviews_per_minute == 10


# -- its place on the Integrations page ----------------------------------------------------------------------------------
SEVEN = ["alerts", "sonar", "brandwatch", "sprinklr", "tubular", "owned", "story"]


def tables_of(ctx) -> list[str]:
    return [s.key for s in ctx.config.platform.temp_check.sources]


def test_find_and_fill_adds_the_two_tables_and_ticks_all_seven_for_agent_alerts(ctx, client, own_secrets):
    got = client.post("/api/connections/autofill", headers=iap(ADMIN)).json()
    plat = ctx.config.platform
    assert tables_of(ctx) == SEVEN and [s.enabled for s in plat.temp_check.sources] == [True] * 5 + [False] * 2, "temp checks do not search the two new tables"
    assert plat.own_alerts.sources == SEVEN and plat.flags.own_alerts is False, "nothing is read until the switch is turned ON"
    filled = {f["path"]: f for f in got["filled"]}
    assert (filled["platform.own_alerts.sources"]["tool"], filled["platform.own_alerts.sources"]["label"]) == ("BigQuery", "Tables agent alerts read")
    assert filled["platform.own_alerts.sources"]["value"] == ("Sundar all mentions, Sonar, Brandwatch stored mentions, Sprinklr comments, Tubular videos, "
                                                              "Sprinklr owned posts, DSD story selection")
    again = client.post("/api/connections/autofill", headers=iap(ADMIN)).json()
    assert "platform.own_alerts.sources" not in {f["path"] for f in again["filled"]} and tables_of(ctx) == SEVEN, "a second fill adds nothing twice"


def test_find_and_fill_reaches_a_console_that_already_holds_the_five_tables(ctx, client, own_secrets):
    from triage_agent import tempcheck

    cfg = ctx.config.platform.temp_check
    five = [t.model_dump(mode="json") for t in tempcheck.app_setup()["tables"]]
    five[4]["enabled"] = False  # a person switched one off for temp checks
    assert client.put("/api/platform/temp_check", json={"value": {**cfg.model_dump(mode="json"), "sources": five}}, headers=iap(ADMIN)).status_code == 200
    client.post("/api/connections/autofill", headers=iap(ADMIN))
    plat = ctx.config.platform
    assert tables_of(ctx) == SEVEN and plat.own_alerts.sources == SEVEN
    assert [s.enabled for s in plat.temp_check.sources] == [True, True, True, True, False, False, False], "what was set stays as it was"


def test_find_and_fill_leaves_the_tables_a_person_chose_for_agent_alerts(ctx, client, own_secrets):
    client.post("/api/connections/autofill", headers=iap(ADMIN))
    page = client.get("/api/platform/own_alerts", headers=iap(ADMIN)).json()
    assert client.put("/api/platform/own_alerts", json={"value": {**page["value"], "sources": ["sonar"]}}, headers=iap(ADMIN)).status_code == 200
    again = client.post("/api/connections/autofill", headers=iap(ADMIN)).json()
    assert ctx.config.platform.own_alerts.sources == ["sonar"] and "platform.own_alerts.sources" not in {f["path"] for f in again["filled"]}


def test_find_and_fill_ticks_the_tables_again_once_none_is_ticked_and_adds_none_twice(ctx, client, own_secrets):
    client.post("/api/connections/autofill", headers=iap(ADMIN))
    page = client.get("/api/platform/own_alerts", headers=iap(ADMIN)).json()
    assert client.put("/api/platform/own_alerts", json={"value": {**page["value"], "sources": []}}, headers=iap(ADMIN)).status_code == 200
    client.post("/api/connections/autofill", headers=iap(ADMIN))
    assert tables_of(ctx) == SEVEN and ctx.config.platform.own_alerts.sources == SEVEN


def test_find_and_fill_does_not_add_a_table_already_listed_under_another_name(ctx, client, own_secrets):
    from triage_agent import tempcheck
    from triage_agent.config import TempCheckSource

    cfg = ctx.config.platform.temp_check
    mine = TempCheckSource(key="dsd", label="The DSD pool", table="brand-social-central-data.DSD.DSD-story-selection", text_columns=["text"],
                           url_column="url", time_column="posted")
    listed = [t.model_dump(mode="json") for t in [*tempcheck.app_setup()["tables"], mine]]
    assert client.put("/api/platform/temp_check", json={"value": {**cfg.model_dump(mode="json"), "sources": listed}}, headers=iap(ADMIN)).status_code == 200
    client.post("/api/connections/autofill", headers=iap(ADMIN))
    assert tables_of(ctx) == [*SEVEN[:5], "dsd", "owned"], "the DSD table is there already, as the person set it up"
    assert ctx.config.platform.own_alerts.sources == [*SEVEN[:5], "owned"], "theirs is left for them to tick"


def test_find_and_fill_adds_nothing_for_agent_alerts_beside_tables_a_person_set_up_themselves(ctx, client, own_secrets):
    from triage_agent.config import TempCheckSource

    cfg = ctx.config.platform.temp_check
    mine = TempCheckSource(key="mine", label="My table", table="p.d.mine", text_columns=["text"], url_column="url", time_column="posted")
    client.put("/api/platform/temp_check", json={"value": {**cfg.model_dump(mode="json"), "sources": [mine.model_dump(mode="json")]}}, headers=iap(ADMIN))
    client.post("/api/connections/autofill", headers=iap(ADMIN))
    assert tables_of(ctx) == ["mine"] and ctx.config.platform.own_alerts.sources == []


def test_the_bigquery_card_shows_and_changes_which_tables_agent_alerts_read(ctx, client, own_secrets):
    client.post("/api/connections/autofill", headers=iap(ADMIN))
    rows = {r["name"]: r for r in bigquery_card(client)["tables"]}
    assert rows["Sonar"]["post"] == {"key": "sonar", "temp_checks": True, "early": False, "watches": False, "own": True}
    assert rows["Sundar all mentions"]["reads"] == ["Temp checks", "Agent alerts"] and rows["Sprinklr owned posts"]["reads"] == ["Agent alerts"]
    assert rows["Sonar"]["reads"] == ["Temp checks", "Agent alerts", "Find missing links"], "one row for a table several features read"
    reads = [{"key": "sonar", "temp_checks": True, "early": False, "watches": False, "own": False}]
    saved = client.put("/api/connections/bigquery/tables", json={"reads": reads}, headers=iap(ADMIN))
    assert saved.status_code == 200 and ctx.config.platform.own_alerts.sources == [k for k in SEVEN if k != "sonar"]
    assert {r["name"]: r for r in saved.json()["connection"]["tables"]}["Sonar"]["reads"] == ["Temp checks", "Find missing links"]
    client.put("/api/connections/bigquery/tables", json={"reads": [{"key": "sonar", "temp_checks": True, "early": True, "watches": False, "own": True}]}, headers=iap(ADMIN))
    assert ctx.config.platform.own_alerts.sources == [k for k in SEVEN if k != "sonar"] + ["sonar"]
    client.put("/api/connections/bigquery/tables", json={"reads": [{"key": "tubular", "temp_checks": False, "early": True, "watches": False}]}, headers=iap(ADMIN))
    assert "tubular" in ctx.config.platform.own_alerts.sources, "a save that does not mention agent alerts leaves its tables as they are"


def test_bigquery_is_said_to_serve_agent_alerts(ctx, client):
    assert "Agent alerts" in bigquery_card(client)["uses"]


# -- its help page -------------------------------------------------------------------------------------------------------
def test_agent_alerts_has_a_help_page_that_leads_with_what_to_do(ctx, client):
    topics = {t["id"]: t for t in client.get("/api/help", headers=iap(IM)).json()["topics"]}
    topic = topics["agent-alerts"]
    assert topic["title"] == "Agent alerts" and topic["page"] == "Agent alerts" and topic["summary"].endswith(".")
    headings = [s["heading"] for s in topic["sections"]]
    assert headings == ["Work an alert", "How an alert is made", "Rules", "The tabs", "Turn it on"]
    assert all(step[0].isupper() for s in topic["sections"] for step in s.get("steps", []))
    said = " ".join(str(v) for s in topic["sections"] for v in (*s.get("steps", []), *s.get("items", []), s.get("text", "")))
    assert "never posted in the source space" in said and "Our own alerts" in said, "it says how it differs from the page with the near name"


# -- its place on the AI page --------------------------------------------------------------------------------------------
def test_the_ai_page_says_which_engines_agent_alerts_uses(ctx, client):
    engines = {e["key"]: e for e in client.get("/api/ai", headers=iap(VIEWER)).json()["engines"]}
    assert "review of each agent alert" in engines["gemini"]["does"]
    bigquery = engines["bigquery"]
    assert "Agent alerts checks each new post against its rules" in bigquery["does"]
    assert {"name": "own_alerts", "title": "Agent alerts", "on": False} in bigquery["switches"]
    assert {"label": "Agent alerts", "to": "/settings/own_alerts"} in bigquery["settings"]
