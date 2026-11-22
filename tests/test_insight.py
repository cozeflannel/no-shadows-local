"""Stories (the bot's same-story rules), the comparison page, alert pop-up settings and the Admin overview.

Alerts go through the real pipeline on the local store; the API is called through the FastAPI app.
"""

from __future__ import annotations

from datetime import timedelta

import pytest

from conftest import GOOD_ALERT
from console.backend import connections
from test_platform import ADMIN, IM, LEAD, _llm, alert, client, flags, iap, triage  # noqa: F401 - fixtures
from triage_agent import knowledge, stories


def named(n: int, issue: str, **more: str) -> str:
    return alert(n, Issue_Name=issue, **more)


def arrive(ctx, clock, text: str = GOOD_ALERT):
    """An alert posted now (a Chat message carries its own time)."""
    return triage(ctx, text, create_time=clock.now)


# -- the same-story rules, as the Chat bot's alert memory has them -------------------------------------------------------------
def test_story_text_and_identifiers(ctx):
    cfg = ctx.config.platform.stories
    text = stories.story_text({"issue_name": "Gemini outage", "product": "Gemini App", "exposure_tag": "Product - Outage",
                               "summary": "Automated Alert via Burson (beta)\nUsers cannot log in. " + "x" * 600}, cfg)
    assert text.startswith("Gemini outage. Gemini App. Product - Outage. Users cannot log in.") and "Automated Alert" not in text
    assert len(text) <= len("Gemini outage. Gemini App. Product - Outage. ") + 400
    assert stories.story_text({"product": "x"}, cfg) == ""
    idt = stories.idents("CVE-2026-12345 hits @vendor and @poster: 25,000 likes, build 12345678 https://x.com/a/status/99999", ["@poster"])
    assert idt == {"c": ["CVE-2026-12345"], "n": ["12345678"], "a": ["vendor"]}, "links, counts and the post's own author are left out"
    assert stories.idents_clash({"c": ["CVE-2026-1"], "n": [], "a": []}, {"c": ["CVE-2026-2"], "n": [], "a": []})
    assert not stories.idents_clash({"c": ["CVE-2026-1"], "n": [], "a": ["x"]}, {"c": [], "n": [], "a": ["x", "y"]})


def test_same_story_by_meaning_and_by_words(ctx):
    cfg = ctx.config.platform.stories
    a = {"tag": "Product - Outage", "product": "Gemini App", "idt": {}}
    b = {"tag": "product - outage", "product": "gemini app", "idt": {}}
    other = {"tag": "Brand - Boycott", "product": "Gemini App", "idt": {}}
    assert stories.same_story(0.86, a, other, cfg), "this alike is the same story whatever the tag"
    assert stories.same_story(0.81, a, b, cfg) and not stories.same_story(0.81, a, other, cfg), "the gray band needs the same tag and product"
    assert not stories.same_story(0.79, a, b, cfg)
    assert not stories.same_story(0.99, {**a, "idt": {"c": ["CVE-2026-1"]}}, {**b, "idt": {"c": ["CVE-2026-2"]}}, cfg)
    words = stories.same_story_words({**a, "tok": ["gemini", "fabricate", "citation"]}, {**b, "tok": ["gemini", "fabricate", "citation", "again"]}, 0.6)
    assert words == 0.75 and stories.same_story_words({**a, "tok": ["gemini"]}, {**other, "tok": ["gemini"]}, 0.6) == 0, "by words, only with the same tag"


# -- grouping real alerts -------------------------------------------------------------------------------------------------------
def test_alerts_on_one_story_are_grouped_with_their_smaller_stories(ctx, clock):
    arrive(ctx, clock)                                                      # "Gemini fabricates academic citations"
    clock.advance(hours=1)
    arrive(ctx, clock, named(2, "Gemini fabricates academic citations again"))
    clock.advance(hours=1)
    arrive(ctx, clock, named(3, "Chrome update breaks the password manager"))
    assert stories.refresh(ctx) == 3 and stories.refresh(ctx) == 0, "each alert is placed once"
    found = stories.list_stories(ctx, since=clock.now - timedelta(days=1))
    assert sorted(len(s.members) for s in found) == [1, 2]
    big = next(s for s in found if len(s.members) == 2)
    assert big.title == "Gemini fabricates academic citations" and [m.case_id for m in big.members] == ["TRG-1001", "TRG-1002"]
    card = stories.summary(ctx, big, since=clock.now - timedelta(days=1))
    assert card["alerts"] == 2 and card["engagement"] == 4900 and card["status"] == "growing"
    assert [(s["name"], s["alerts"]) for s in card["sub"]] == [("Gemini fabricates academic citations", 1), ("Gemini fabricates academic citations again", 1)]
    assert [p["alerts"] for p in card["growth"]][-3:] == [1, 2, 2], "the growth line is cumulative by the hour"
    clock.advance(hours=7)
    assert stories.summary(ctx, big, since=clock.now - timedelta(days=1))["status"] == "quiet"


def test_different_identifiers_and_old_stories_start_new_ones(ctx, clock):
    arrive(ctx, clock, named(1, "Chrome zero day CVE-2026-11111 exploited"))
    arrive(ctx, clock, named(2, "Chrome zero day CVE-2026-22222 exploited"))
    stories.refresh(ctx)
    assert len(stories.list_stories(ctx, since=clock.now - timedelta(days=1))) == 2, "two CVEs are two stories, however alike the words"
    clock.advance(days=ctx.config.platform.stories.keep_days + 1)
    arrive(ctx, clock, named(3, "Chrome zero day CVE-2026-11111 exploited"))
    stories.refresh(ctx)
    assert len(stories.list_stories(ctx, since=clock.now - timedelta(days=60))) == 3, "a story silent past its keep-time is over"


def test_meaning_is_used_when_an_embedding_model_is_set(ctx, clock, monkeypatch):
    ctx.config.platform.knowledge.embedding_model = "text-embedding-test"
    vectors = {"Gemini invents sources": [1.0, 0.0], "Made-up references in AI answers": [0.9, 0.3], "Pixel battery drain": [0.0, 1.0]}
    monkeypatch.setattr(knowledge, "embed", lambda ctx_, texts: [next(v for k, v in vectors.items() if t.startswith(k)) for t in texts])
    for i, name in enumerate(vectors, start=1):
        triage(ctx, named(i, name))
    stories.refresh(ctx)
    found = stories.list_stories(ctx, since=clock.now - timedelta(days=1))
    assert sorted(len(s.members) for s in found) == [1, 2], "no shared words, yet the same story by meaning (cosine 0.95)"


# -- the API ---------------------------------------------------------------------------------------------------------------------
def test_story_map_and_drill_down(ctx, client, clock):
    arrive(ctx, clock)
    clock.advance(minutes=30)
    arrive(ctx, clock, named(2, "Gemini fabricates academic citations again"))
    got = client.get("/api/stories", params={"hours": 24}, headers=iap(IM)).json()
    assert got["size_by"] == "engagement" and len(got["stories"]) == 1 and got["stories"][0]["alerts"] == 2
    story = got["stories"][0]
    assert story["needs"] == 2 and story["platforms"] == ["X"] and len(story["sub"]) == 2
    detail = client.get(f"/api/stories/{story['story_id']}", headers=iap(IM)).json()
    assert [a["case_id"] for a in detail["alerts"]] == ["TRG-1002", "TRG-1001"] and detail["alerts"][0]["post_url"].startswith("https://x.com/")
    assert {c["case_id"] for c in detail["chat"]} == {"TRG-1001", "TRG-1002"} and detail["story"]["title"] == story["title"]
    assert client.get("/api/stories/STORY-nope", headers=iap(IM)).status_code == 404


def test_comparison_page_numbers(ctx, client, clock, fake_llm):
    from test_platform import assess_ok

    triage(ctx)                                                             # passes as Burson sent it
    assess_ok(fake_llm, exposure_tag_fit={"ok": False, "confidence": 0.75, "finding": "medical claim",
                                          "proposed_value": "Product - Dangerous results (e.g. medical/legal)"})
    triage(ctx, alert(2))                                                   # held for an IM
    client.post("/api/feed/TRG-1001/assessment", json={"agree": True}, headers=iap(IM))
    client.post("/api/feed/TRG-1002/assessment", json={"agree": False, "verdict": "PASS"}, headers=iap(IM))
    clock.advance(minutes=1)
    got = client.get("/api/compare", params={"days": 7}, headers=iap(IM)).json()
    rows = {r["key"]: r for s in got["sections"] for r in s["rows"]}
    assert [s["key"] for s in got["sections"]] == ["burson", "detection", "ims", "speed"]
    assert rows["alerts_received"]["value"] == 2 and rows["first_pass_yield"]["value"] == 0.5 and rows["held_for_review"]["value"] == 1
    assert rows["im_agreement"]["value"] == 0.5 and rows["im_right"]["value"] == 1 and rows["im_wrong"]["value"] == 1
    assert rows["parity_recall"]["value"] is None and "in-house" in rows["parity_recall"]["note"].lower()
    assert all({"key", "label", "value", "unit"} <= set(r) for r in rows.values())


def test_popups_are_off_until_switched_on_and_carry_their_settings(ctx, client):
    assert client.get("/api/meta", headers=iap(IM)).json()["notifications"]["enabled"] is False
    flags(ctx, alert_popups=True)
    ctx.config.platform.notifications.popup_seconds = 20
    got = client.get("/api/meta", headers=iap(IM)).json()["notifications"]
    assert got == {"enabled": True, "event_types": ["alert.received"], "sources": ["burson_chat"], "seconds": 20, "max_on_screen": 3}
    triage(ctx)
    item = next(i for i in client.get("/api/live/feed", headers=iap(IM)).json()["items"] if i["event_type"] == "alert.received")
    assert item["payload"]["source"] == "burson_chat" and item["case"]["alert_name"], "a pop-up has the alert's name and source to show"


def test_admin_overview(ctx, client, clock):
    from triage_agent import platform_jobs

    assert client.get("/api/admin/overview", headers=iap(IM)).status_code == 403, "leads and admins only"
    triage(ctx)
    client.put("/api/platform/flags", json={"value": {"alert_popups": True}}, headers=iap(ADMIN))
    platform_jobs.run_job(ctx, "maintenance")
    got = client.get("/api/admin/overview", headers=iap(LEAD)).json()
    people = {p["email"]: p for p in got["people"]}
    assert people[ADMIN]["role"] == "admin" and people[IM]["on_roster"] is True and people[IM]["role"] in ("im", "analyst", "lead", "admin")
    assert got["access"]["viewer_domains"] and got["status"]["tick"]["minutes_ago"] == 0 and got["status"]["tick"]["ok"] is True
    assert got["status"]["safety"]["passed"] is True and got["status"]["switches_on"] == ["alert_popups"]
    assert got["changes"][0]["action"] == "settings.flags" and got["changes"][0]["actor"] == ADMIN
    assert any(a["actor"] == ADMIN and a["actions"] >= 1 for a in got["active"])


# -- integrations: each tool is connected in one place ---------------------------------------------------------------------------
def test_integrations_catalog_says_what_each_tool_still_needs(ctx, client):
    got = client.get("/api/connections", headers=iap(IM)).json()
    by = {c["key"]: c for c in got["connections"]}
    assert {"gcp", "gemini", "runtime", "chat", "bigquery", "delivery", "secrets", "gmail", "drive", "brandwatch", "inhouse"} <= set(by)
    assert by["bigquery"]["state"] == "incomplete" and by["bigquery"]["missing"] == ["Dataset"] and by["bigquery"]["required"] is True
    assert by["brandwatch"]["state"] == "not_connected" and by["brandwatch"]["required"] is False
    assert by["chat"]["state"] == "ready", "the agent's account and both spaces are set; nothing has tested it yet"
    assert got["summary"]["required"] == sum(1 for c in by.values() if c["required"]) and got["summary"]["ready"] < got["summary"]["required"]
    assert all(f["path"] and f["label"] for c in by.values() for f in c["fields"]) and all(c["steps"] for c in by.values())


def test_connecting_a_tool_saves_its_values_once_and_is_audited(ctx, client, clock):
    values = {"platform.bigquery.dataset": "proj.slrr_triage", "platform.bigquery.location": "US"}
    assert client.put("/api/connections/bigquery", json={"values": values}, headers=iap(IM)).status_code == 403
    assert client.put("/api/connections/bigquery", json={"values": {"platform.safety.testing": False}}, headers=iap(ADMIN)).status_code == 422, \
        "a connection only writes its own fields"
    saved = client.put("/api/connections/bigquery", json={"values": values}, headers=iap(ADMIN))
    assert saved.status_code == 200 and saved.json()["connection"]["state"] == "ready" and saved.json()["connection"]["missing"] == []
    fresh = client.get("/api/platform/bigquery", headers=iap(ADMIN)).json()["value"]
    assert fresh["dataset"] == "proj.slrr_triage" and fresh["location"] == "US" and fresh["hot_window_hours"] == 48, "the other settings stay"
    space = client.put("/api/connections/chat", json={"values": {"spaces.youtube.url": "https://chat.google.com/room/AAAAyt"}}, headers=iap(ADMIN))
    assert space.status_code == 200 and ctx.store.get_config_overrides()["spaces"]
    clock.advance(minutes=1)
    entry = client.get("/api/audit", params={"action": "connection."}, headers=iap(ADMIN)).json()["entries"][0]
    assert entry["action"] == "connection.save" and entry["actor"] == ADMIN and entry["target_id"] == "chat"


def test_testing_a_tool_is_a_live_check_whose_result_is_kept_until_its_values_change(ctx, client):
    assert client.post("/api/connections/gemini/test", headers=iap(IM)).status_code == 403
    ran = client.post("/api/connections/gemini/test", headers=iap(ADMIN)).json()
    assert ran["test"]["ok"] is True and ran["connection"]["state"] == "connected" and ran["test"]["details"][0]["label"] == "Model for alerts"
    again = {c["key"]: c for c in client.get("/api/connections", headers=iap(IM)).json()["connections"]}
    assert again["gemini"]["state"] == "connected" and again["gemini"]["test"]["at"]
    client.put("/api/connections/gemini", json={"values": {"models.triage": "gemini-next"}}, headers=iap(ADMIN))
    after = {c["key"]: c for c in client.get("/api/connections", headers=iap(IM)).json()["connections"]}
    assert after["gemini"]["state"] == "ready" and after["gemini"]["test"] is None, "a test of the old values proves nothing about the new ones"
    cloud = client.post("/api/connections/bigquery/test", headers=iap(ADMIN)).json()
    assert cloud["test"]["ok"] is False and cloud["connection"]["state"] == "incomplete" and "Dataset" in cloud["test"]["message"]


def test_disconnecting_clears_an_optional_tool_and_never_a_required_one(ctx, client):
    client.put("/api/connections/brandwatch", json={"values": {"platform.temp_check.brandwatch_project_id": "123",
                                                               "platform.temp_check.brandwatch_token_secret": "bw-token"}}, headers=iap(ADMIN))
    assert client.delete("/api/connections/gemini", headers=iap(ADMIN)).status_code == 422
    gone = client.delete("/api/connections/brandwatch", headers=iap(ADMIN)).json()
    assert gone["connection"]["state"] == "not_connected" and ctx.store.get_config_overrides().get("platform", {}).get("temp_check", {}).get("brandwatch_project_id") in (None, "")


# -- people: one record, access everywhere ------------------------------------------------------------------------------------------
def test_adding_a_person_once_gives_them_their_role_and_their_place_on_the_roster(ctx, client):
    new = "nia@ops.test"
    body = {"name": "Nia New", "role": "im", "on_roster": True}
    assert client.put(f"/api/admin/people/{new}", json=body, headers=iap(LEAD)).status_code == 403
    made = client.put(f"/api/admin/people/{new}", json=body, headers=iap(ADMIN))
    assert made.status_code == 200 and made.json()["person"]["on_roster"] is True and made.json()["person"]["role"] == "im"
    assert client.get("/api/me", headers=iap(new)).json()["role"] == "im"
    roster = client.get("/api/rosters/slrr_im", headers=iap(ADMIN)).json()
    assert any(p["email"] == new and p["name"] == "Nia New" for p in roster["roster"]["people"])
    lead = client.put(f"/api/admin/people/{new}", json={"name": "Nia New", "role": "lead", "on_roster": False}, headers=iap(ADMIN)).json()
    assert lead["person"]["role"] == "lead" and lead["person"]["on_roster"] is False
    assert client.get("/api/me", headers=iap(new)).json()["role"] == "lead"
    assert client.put("/api/admin/people/not-an-address", json=body, headers=iap(ADMIN)).status_code == 422


def test_removing_a_person_takes_their_access_and_keeps_the_console_and_the_shifts_safe(ctx, client):
    assert client.delete(f"/api/admin/people/{ADMIN}", headers=iap(ADMIN)).status_code == 422, "the last admin stays"
    held = client.delete(f"/api/admin/people/{IM}", headers=iap(ADMIN))
    assert held.status_code == 422 and "shift" in held.json()["error"], "someone holding shifts is moved off them first"
    client.put("/api/admin/people/temp@ops.test", json={"name": "Temp", "role": "analyst", "on_roster": True}, headers=iap(ADMIN))
    assert client.delete("/api/admin/people/temp@ops.test", headers=iap(ADMIN)).status_code == 200
    assert client.get("/api/me", headers=iap("temp@ops.test")).json()["role"] == "none"
    emails = {p["email"] for p in client.get("/api/admin/overview", headers=iap(ADMIN)).json()["people"]}
    assert "temp@ops.test" not in emails


@pytest.fixture
def own_secrets(ctx, tmp_path):
    """An empty secret store of the test's own, so Find and fill sees no secret a developer keeps locally."""
    from triage_agent import secret_admin

    ctx.secrets = secret_admin.LocalSecrets(tmp_path / "secrets.json")
    return ctx.secrets


def test_find_and_fill_writes_what_the_service_can_see_and_lists_what_is_left(ctx, client, monkeypatch, own_secrets):
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "seen-project")
    monkeypatch.setenv("GOOGLE_CLOUD_REGION", "us-central1")
    assert client.post("/api/connections/autofill", headers=iap(IM)).status_code == 403
    got = client.post("/api/connections/autofill", headers=iap(ADMIN)).json()
    seen = {(f["path"], f["value"]) for f in got["filled"] if f["tool"] == "Google Cloud"}
    assert seen == {("platform.gcp.project", "seen-project"), ("platform.gcp.region", "us-central1")}
    assert ctx.store.get_config_overrides()["platform"]["gcp"] == {"project": "seen-project", "region": "us-central1"}
    assert {"tool": "bigquery", "name": "BigQuery", "label": "Dataset", "required": True} in got["left"]
    again = client.post("/api/connections/autofill", headers=iap(ADMIN)).json()
    assert again["filled"] == [], "a value already set is never changed"


def test_find_and_fill_brings_the_temp_check_apps_tables_and_brandwatch_values(ctx, client, own_secrets):
    from triage_agent import tempcheck

    app = tempcheck.app_setup()
    got = client.post("/api/connections/autofill", headers=iap(ADMIN)).json()
    filled = {f["path"]: f for f in got["filled"]}
    cfg = ctx.config.platform.temp_check
    assert [s.key for s in cfg.sources] == ["alerts", "sonar", "brandwatch", "sprinklr", "tubular"] and cfg.sources[1].read_sql == app["tables"][1].read_sql
    assert filled["platform.temp_check.sources"]["tool"] == "Post tables"
    assert filled["platform.temp_check.sources"]["value"] == "Sundar all mentions, Sonar, Brandwatch stored mentions, Sprinklr comments, Tubular videos"
    assert (cfg.brandwatch_project_id, cfg.event_query_prefix, cfg.standing_query_name, cfg.standing_query_skip) == ("1998344909", "[G EVENT]", "[V2] MAIN G Landscape (", "benchmark")
    assert filled["platform.temp_check.brandwatch_project_id"]["tool"] == "Brandwatch" and filled["platform.temp_check.standing_query_name"]["label"] == "Standing query names start with"
    assert cfg.brandwatch_token_secret == "" and any("slrr-campaigns-bw-token" in note for note in got["notes"]), "a secret the project does not hold is not named"
    assert ctx.config.platform.early.sources == [] and ctx.config.platform.campaigns.watch_sources == [], "which tables Early Detection and watches read stays a person's choice"

    own_secrets.create("slrr-campaigns-bw-token", "token-value")
    cfg.sources[0].enabled = False
    again = client.post("/api/connections/autofill", headers=iap(ADMIN)).json()
    assert [f["path"] for f in again["filled"]] == ["platform.temp_check.brandwatch_token_secret"], "only what was still empty; the tables already there are left alone"
    assert ctx.config.platform.temp_check.brandwatch_token_secret == "slrr-campaigns-bw-token"


def test_find_and_fill_leaves_tables_and_brandwatch_values_a_person_set(ctx, client, own_secrets):
    from triage_agent.config import TempCheckSource

    cfg = ctx.config.platform.temp_check
    mine = TempCheckSource(key="mine", label="My table", table="p.d.mine", text_columns=["text"], url_column="url", time_column="posted")
    client.put("/api/platform/temp_check", json={"value": {**cfg.model_dump(mode="json"), "sources": [mine.model_dump(mode="json")], "brandwatch_project_id": "77",
                                                          "event_query_prefix": "[EVENT]"}, "note": "set by hand"}, headers=iap(ADMIN))
    got = client.post("/api/connections/autofill", headers=iap(ADMIN)).json()
    cfg = ctx.config.platform.temp_check
    assert [s.key for s in cfg.sources] == ["mine"] and cfg.brandwatch_project_id == "77" and cfg.event_query_prefix == "[EVENT]"
    assert "platform.temp_check.sources" not in {f["path"] for f in got["filled"]}


class SomeDenied:
    """BigQuery as the post tables check meets it: every read is estimated, and the Sonar dataset refuses this account."""

    project = "this-project"
    _settings_key = ("", "", 0)

    def __init__(self):
        self.asked: list[tuple[str, dict, str | None]] = []

    def test(self):
        return {"ok": True, "project": self.project, "location": "US", "identity": "agent@project.test"}

    def dry_run(self, sql, params=None, *, location=None):
        self.asked.append((sql, dict(params or {}), location))
        if "sonar_raw" in sql:
            raise RuntimeError("403 Access Denied: Table sonar_raw: User does not have permission to query table")
        if "tubular_videos" in sql:
            raise RuntimeError("400 Unrecognized name: video_title at [1:40]")
        return 3 * 1024 ** 3


def test_the_post_tables_card_checks_each_table_and_names_the_grant_it_needs(ctx, client, monkeypatch, own_secrets):
    by = lambda: {c["key"]: c for c in client.get("/api/connections", headers=iap(IM)).json()["connections"]}  # noqa: E731
    card = by()["post_tables"]
    assert card["state"] == "not_connected" and card["required"] is False and card["missing"] == ["A table of posts"]
    client.post("/api/connections/autofill", headers=iap(ADMIN))
    card = by()["post_tables"]
    assert card["state"] == "ready" and [f["label"] for f in card["facts"]][:2] == ["Sundar all mentions", "Sonar"]
    assert card["facts"][1]["value"] == "bsip-s-bsip-gg-26-2cf3.google_bg.sonar_raw"

    monkeypatch.setattr(connections, "_on_cloud", lambda: True)  # the check runs as it does on Cloud Run
    ctx.bq = gw = SomeDenied()
    assert client.post("/api/connections/post_tables/test", headers=iap(IM)).status_code == 403
    got = client.post("/api/connections/post_tables/test", headers=iap(ADMIN)).json()
    lines = {d["label"]: d for d in got["test"]["details"]}
    assert got["test"]["ok"] is False and got["connection"]["state"] == "failing"
    assert lines["Sundar all mentions"] == {"label": "Sundar all mentions", "ok": True, "message": "Readable. A day's read scans 3.0 GB."}
    assert lines["Sonar"]["message"] == ("Access denied. The dataset's owners run: GRANT `roles/bigquery.dataViewer` ON SCHEMA "
                                         '`bsip-s-bsip-gg-26-2cf3`.`google_bg` TO "serviceAccount:agent@project.test"')
    assert lines["Tubular videos"]["ok"] is False and lines["Tubular videos"]["message"].startswith("BigQuery would not take this table's read: 400 Unrecognized name: video_title")
    sql, params, location = next(a for a in gw.asked if "sonar_raw" in a[0])
    assert "JSON_VALUE(payload" in sql and location == "us-central1" and params["t_to"] - params["t_from"] == timedelta(days=1), "the table's own read, over a day"

    ctx.config.platform.temp_check.sources[1].enabled = False
    assert by()["post_tables"]["test"] is None, "a check is forgotten once the tables change"


def test_the_deployer_is_listed_as_the_admin_until_an_admin_is_named(ctx, client, monkeypatch):
    ctx.config.analysts = []
    monkeypatch.setenv("TRIAGE_BOOTSTRAP_ADMIN", "deployer@ops.test")
    got = client.get("/api/admin/overview", headers=iap("deployer@ops.test")).json()
    row = next(p for p in got["people"] if p["email"] == "deployer@ops.test")
    assert row["role"] == "admin" and row["role_source"] == "deploy", "the person who can sign in as admin is on the list"


class DeniedSonar:
    """BigQuery as the in-house check meets it: queries run, and the Sonar dataset refuses this account."""

    project = "this-project"
    _settings_key = ("", "", 0)

    def test(self):
        return {"ok": True, "project": self.project, "location": "US", "identity": "agent@project.test"}

    def dry_run(self, sql, params=None, *, location=None):
        if "sonar" in sql:
            raise RuntimeError("403 Access Denied: Table sonar_raw: User does not have permission to query table")
        return 2048


def test_a_denied_table_names_the_account_and_the_grant_to_run(ctx, client, monkeypatch):
    monkeypatch.setattr(connections, "_on_cloud", lambda: True)  # the check runs as it does on Cloud Run
    ctx.bq = DeniedSonar()
    got = client.post("/api/connections/inhouse/test", headers=iap(ADMIN)).json()
    lines = {d["label"]: d for d in got["test"]["details"]}
    project, dataset, _ = ctx.config.inhouse.sonar_table.split(".")
    assert got["test"]["ok"] is False and got["connection"]["state"] == "failing"
    assert lines["Alert log table"]["ok"] is True and lines["Story selection view"]["ok"] is True
    assert lines["Sonar table"]["message"] == ("Access denied. The dataset's owners run: GRANT `roles/bigquery.dataViewer` ON SCHEMA "
                                               f'`{project}`.`{dataset}` TO "serviceAccount:agent@project.test"')


class OwnTables:
    """BigQuery as the Console meets it in its own project: two datasets, one of them holding the agent's tables."""

    project = "seen-project"
    _settings_key = ("seen-project", "", 0)

    def test(self):
        return {"ok": True, "project": self.project, "location": "US", "identity": "agent@project.test"}

    def list_datasets(self):
        return [{"dataset": name, "project": self.project, "full_id": f"{self.project}.{name}"} for name in ("marketing", "slrr_triage")]

    def get_dataset(self, dataset):
        return {"dataset": dataset.split(".")[-1], "project": self.project, "location": "US"}

    def get_table(self, table_id):
        if not table_id.startswith("seen-project.slrr_triage."):
            raise RuntimeError(f"404 Not found: {table_id}")
        return {"full_id": table_id, "rows": 12}


def test_on_the_cloud_find_and_fill_picks_the_one_runtime_and_the_dataset_that_holds_the_agents_tables(ctx, client, monkeypatch, own_secrets):
    runtime = "projects/1/locations/us-central1/reasoningEngines/77"
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "seen-project")
    monkeypatch.setenv("GOOGLE_CLOUD_REGION", "us-central1")
    monkeypatch.setattr(connections, "_on_cloud", lambda: True)
    monkeypatch.setattr(connections, "_runtimes", lambda ctx_: [f"{runtime}|triage agent"])  # what the Vertex AI list call returns
    ctx.bq = OwnTables()
    got = client.post("/api/connections/autofill", headers=iap(ADMIN)).json()
    filled = {f["path"]: f["value"] for f in got["filled"]}
    assert filled["platform.gcp.agent_runtime_resource"] == runtime and filled["platform.bigquery.dataset"] == "seen-project.slrr_triage"
    assert filled["platform.bigquery.tables.events"] == "seen-project.slrr_triage.agent_events"
    assert not any(left["tool"] in ("gcp", "runtime", "bigquery") for left in got["left"])
    ctx.bq = OwnTables()  # the saved settings name the same project: the same gateway answers
    choices = client.get("/api/connections/bigquery/options", params={"field": "platform.bigquery.dataset"}, headers=iap(ADMIN)).json()
    assert [o["value"] for o in choices["options"]] == ["seen-project.marketing", "seen-project.slrr_triage"]
    checked = client.post("/api/connections/bigquery/test", headers=iap(ADMIN)).json()
    assert checked["test"]["ok"] is True and checked["connection"]["state"] == "connected"
    assert [d["message"] for d in checked["test"]["details"]][-1] == "seen-project.slrr_triage.agent_events: 12 rows."


# -- plain words: every Settings page and every switch explains itself ---------------------------------------------------------------
def test_every_settings_page_has_a_plain_name_an_explanation_and_a_group(ctx, client):
    parts = client.get("/api/platform", headers=iap(ADMIN)).json()["parts"]
    got = client.get("/api/settings", headers=iap(ADMIN)).json()
    groups = {g["key"] for g in got["groups"]}
    for page in [*parts, *got["sections"]]:
        assert page["label"] and page["description"].endswith("."), f"{page['key']} has no explanation"
        assert page["group"] in groups, f"{page['key']} is not under a heading"
        assert "_" not in page["label"] and page["label"][0].isupper(), f"{page['key']} is named by its internal key"


def test_every_switch_has_a_plain_name_and_says_what_on_and_off_mean(ctx, client):
    from triage_agent.config import FeatureFlags, switch_off

    for name, field in FeatureFlags.model_fields.items():
        assert field.title and "_" not in field.title, f"{name} has no plain name"
        assert field.description.startswith("ON: ") and " OFF: " in field.description, f"{name} does not say what ON and OFF mean"
    names = client.get("/api/meta", headers=iap(IM)).json()["switch_names"]
    assert names["knowledge_rag"] == "Read the Knowledge documents" and set(names) == set(FeatureFlags.model_fields)
    assert switch_off("Temp checks", "temp_checks") == 'Temp checks is switched off. An admin can turn on "Temp checks" under Settings, Switches.'
    refused = client.post("/api/temp-checks", json={"issue": "x"}, headers=iap(IM))
    assert "_" not in refused.json()["error"] and "Settings, Switches" in refused.json()["error"]


def test_no_setting_on_a_settings_page_is_left_unexplained():
    import typing

    from pydantic import BaseModel

    from triage_agent.config import PlatformConfig

    missing: list[str] = []

    def walk(model, prefix, seen=()):
        for name, field in model.model_fields.items():
            nested = [b for a in (field.annotation, *typing.get_args(field.annotation)) for b in (a, *typing.get_args(a))
                      if isinstance(b, type) and issubclass(b, BaseModel) and b not in seen]
            if not nested and not field.description:
                missing.append(f"{prefix}.{name}")
            for sub in nested[:1]:
                walk(sub, f"{prefix}.{name}", (*seen, model))

    walk(PlatformConfig, "platform")
    assert missing == []
