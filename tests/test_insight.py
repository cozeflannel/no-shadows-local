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
    assert set(by) == {"gcp", "gemini", "runtime", "chat", "bigquery", "delivery", "secrets", "gmail", "drive", "brandwatch", "campaigns"}, \
        "BigQuery is one card: its own dataset and every table it reads"
    assert by["bigquery"]["state"] == "incomplete" and by["bigquery"]["missing"] == ["Dataset"] and by["bigquery"]["required"] is True
    assert {"tool": "bigquery", "name": "BigQuery", "text": "Set Dataset", "required": True} in got["todo"]
    assert not any(item["tool"] == "brandwatch" for item in got["todo"]), "an optional tool nobody started is not on the list"
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

    # Simplified "user" / "admin" role workflow + optional display name + invite-only vs workspace viewer toggle
    quick = client.put("/api/admin/people/alex.morgan@ops.test", json={"role": "user"}, headers=iap(ADMIN))
    assert quick.status_code == 200
    assert quick.json()["person"]["name"] == "Alex Morgan" and quick.json()["person"]["role"] == "analyst"
    me_user = client.get("/api/me", headers=iap("alex.morgan@ops.test")).json()
    assert me_user["can_act"] is True and me_user["is_admin"] is False

    promoted = client.put("/api/admin/people/alex.morgan@ops.test", json={"role": "admin"}, headers=iap(ADMIN))
    assert promoted.status_code == 200 and promoted.json()["person"]["role"] == "admin"
    assert client.get("/api/me", headers=iap("alex.morgan@ops.test")).json()["is_admin"] is True

    opened = client.put("/api/admin/access", json={"open_domain_viewers": True, "domain": "ops.test"}, headers=iap(ADMIN))
    assert opened.status_code == 200 and opened.json()["access"]["viewer_domains"] == ["ops.test"]
    assert client.get("/api/me", headers=iap("unlisted@ops.test")).json()["role"] == "viewer"
    closed = client.put("/api/admin/access", json={"open_domain_viewers": False}, headers=iap(ADMIN))
    assert closed.status_code == 200 and closed.json()["access"]["viewer_domains"] == []
    assert client.get("/api/me", headers=iap("unlisted@ops.test")).json()["role"] == "none"


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
    assert {"tool": "bigquery", "name": "BigQuery", "text": "Set Dataset", "required": True} in got["todo"], "what is left comes back with the fill"
    again = client.post("/api/connections/autofill", headers=iap(ADMIN)).json()
    assert again["filled"] == [], "a value already set is never changed"


def test_find_and_fill_brings_the_temp_check_apps_tables_and_brandwatch_values(ctx, client, own_secrets):
    from triage_agent import tempcheck

    app = tempcheck.app_setup()
    got = client.post("/api/connections/autofill", headers=iap(ADMIN)).json()
    filled = {f["path"]: f for f in got["filled"]}
    cfg = ctx.config.platform.temp_check
    assert [s.key for s in cfg.sources] == ["alerts", "sonar", "brandwatch", "sprinklr", "tubular", "owned", "story"], \
        "the five the temp check app searches, then the two only agent alerts read (tests/test_own_console.py)"
    assert cfg.sources[1].read_sql == app["tables"][1].read_sql
    assert filled["platform.temp_check.sources"]["tool"] == "BigQuery"
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


class ReadTables:
    """BigQuery as its card meets it: the agent's own dataset is there, each table says where it lives, every read is
    estimated, the Sonar dataset refuses this account and Tubular's read names a column its table does not have."""

    project = "this-project"

    def __init__(self):
        self.asked: list[tuple[str, dict, str | None]] = []

    def test(self):
        return {"ok": True, "project": self.project, "location": "US", "identity": "agent@project.test"}

    def get_dataset(self, dataset):
        return {"dataset": dataset.split(".")[-1], "project": dataset.split(".")[0], "location": "US"}

    def get_table(self, table_id):
        if ".google_bg." in table_id:
            raise RuntimeError("403 Access Denied: Table sonar_raw: User does not have bigquery.tables.get permission")
        if table_id.endswith(".gone"):
            raise RuntimeError(f"404 Not found: Table {table_id} was not found in location US")
        return {"full_id": table_id, "rows": 12, "location": "EU" if "brandwatch_raw" in table_id else "us-central1" if "tubular" in table_id else "US"}

    def dry_run(self, sql, params=None, *, location=None):
        self.asked.append((sql, dict(params or {}), location))
        if "tubular_videos" in sql:
            raise RuntimeError("400 Unrecognized name: video_title at [1:40]")
        return 3 * 1024 ** 3


class OnlySonarRefuses(ReadTables):
    """Every read is taken; the Sonar dataset alone has not let this account in yet."""

    def dry_run(self, sql, params=None, *, location=None):
        self.asked.append((sql, dict(params or {}), location))
        return 3 * 1024 ** 3


class MayNotRunQueries(ReadTables):
    """The account may see every table and may not run a query in its own project."""

    def get_table(self, table_id):
        return {"full_id": table_id, "rows": 12, "location": "US"}

    def dry_run(self, sql, params=None, *, location=None):
        raise RuntimeError("403 Access Denied: Project this-project: User does not have bigquery.jobs.create permission in project this-project.")


def bigquery_card(client):
    return next(c for c in client.get("/api/connections", headers=iap(IM)).json()["connections"] if c["key"] == "bigquery")


def own_dataset(client, ctx):
    """The agent's own dataset and its events table, as a deploy leaves them."""
    value = {**ctx.config.platform.bigquery.model_dump(mode="json"), "dataset": "this-project.slrr_triage", "tables": {"events": "this-project.slrr_triage.agent_events"}}
    assert client.put("/api/platform/bigquery", json={"value": value, "note": "as deployed"}, headers=iap(ADMIN)).status_code == 200


def test_the_bigquery_card_lists_each_table_the_app_reads_once_with_what_reads_it(ctx, client, own_secrets):
    rows = bigquery_card(client)["tables"]
    assert [(r["name"], r["reads"]) for r in rows] == [("Story selection view", []), ("Alert log", []), ("Sonar", []), ("Billing export", [])], \
        "before any table of posts is set, with Our own alerts and Find missing links OFF"
    ctx.config.inhouse.enabled = ctx.config.sonar_lookup.enabled = True
    rows = bigquery_card(client)["tables"]
    assert [r["reads"] for r in rows] == [["Our own alerts"], ["Find missing links"], ["Find missing links"], []], "a feature reads a table while it is ON"
    assert rows[-1]["set"] is False and rows[-1]["table"] == "" and all(r["post"] is None for r in rows)

    client.post("/api/connections/autofill", headers=iap(ADMIN))
    rows = bigquery_card(client)["tables"]
    assert [r["name"] for r in rows] == ["Sundar all mentions", "Sonar", "Brandwatch stored mentions", "Sprinklr comments", "Tubular videos",
                                         "Sprinklr owned posts", "DSD story selection", "Alert log", "Billing export"]
    sonar = rows[1]
    assert sonar["table"] == "bsip-s-bsip-gg-26-2cf3.google_bg.sonar_raw" and sonar["location"] == "us-central1"
    assert sonar["reads"] == ["Temp checks", "Agent alerts", "Find missing links"], "one row for the table three settings name"
    assert sonar["post"] == {"key": "sonar", "temp_checks": True, "early": False, "watches": False, "own": True}
    assert rows[6]["reads"] == ["Agent alerts", "Our own alerts"], "the story selection view is the DSD story table: one row, read by both"
    assert rows[0]["reads"] == ["Temp checks", "Agent alerts"] and rows[7]["table"] == ctx.config.inhouse.alert_log_table and rows[7]["status"] is None


def test_changing_a_table_on_the_bigquery_card_changes_it_in_every_setting_that_names_it(ctx, client, clock, own_secrets):
    client.post("/api/connections/autofill", headers=iap(ADMIN))
    ctx.config.sonar_lookup.enabled = True
    sonar = bigquery_card(client)["tables"][1]
    body = {"tables": [{"id": sonar["id"], "table": "other-project.listening.sonar_events"}]}
    assert client.put("/api/connections/bigquery/tables", json=body, headers=iap(IM)).status_code == 403
    bad = client.put("/api/connections/bigquery/tables", json={"tables": [{"id": sonar["id"], "table": "sonar_events"}]}, headers=iap(ADMIN))
    assert bad.status_code == 422 and "project.dataset.table" in bad.json()["error"]
    assert client.put("/api/connections/bigquery/tables", json={"tables": [{"id": "platform.safety.testing", "table": "a.b.c"}]}, headers=iap(ADMIN)).status_code == 422
    clock.advance(minutes=1)
    saved = client.put("/api/connections/bigquery/tables", json=body, headers=iap(ADMIN))
    assert saved.status_code == 200
    cfg = ctx.config
    assert (cfg.inhouse.sonar_table, cfg.sonar_lookup.table, cfg.platform.temp_check.sources[1].table) == ("other-project.listening.sonar_events",) * 3
    row = saved.json()["connection"]["tables"][1]
    assert row["table"] == "other-project.listening.sonar_events" and row["reads"] == ["Temp checks", "Agent alerts", "Find missing links"]
    entry = client.get("/api/audit", params={"action": "connection.save"}, headers=iap(ADMIN)).json()["entries"][0]
    assert entry["target_id"] == "bigquery" and "inhouse.sonar_table" in entry["summary"] and "sonar_lookup.table" in entry["summary"]

    billing = saved.json()["connection"]["tables"][-1]
    client.put("/api/connections/bigquery/tables", json={"tables": [{"id": billing["id"], "table": "this-project.billing.export_v1"}]}, headers=iap(ADMIN))
    assert ctx.config.platform.costs.billing_export_table == "this-project.billing.export_v1"
    client.put("/api/connections/bigquery/tables", json={"tables": [{"id": billing["id"], "table": ""}]}, headers=iap(ADMIN))
    assert ctx.config.platform.costs.billing_export_table == "", "a table nothing needs can be cleared"


def test_the_bigquery_card_chooses_what_reads_each_table_of_posts(ctx, client, own_secrets):
    client.post("/api/connections/autofill", headers=iap(ADMIN))
    reads = [{"key": "alerts", "temp_checks": True, "early": True, "watches": True}, {"key": "tubular", "temp_checks": False, "early": True, "watches": False}]
    saved = client.put("/api/connections/bigquery/tables", json={"reads": reads}, headers=iap(ADMIN))
    assert saved.status_code == 200
    plat = ctx.config.platform
    assert plat.early.sources == ["alerts", "tubular"] and plat.campaigns.watch_sources == ["alerts"]
    assert [s.enabled for s in plat.temp_check.sources] == [True, True, True, True, False, False, False]
    rows = {r["name"]: r for r in saved.json()["connection"]["tables"]}
    assert rows["Sundar all mentions"]["reads"] == ["Temp checks", "Early Detection", "Watches", "Agent alerts"]
    assert rows["Tubular videos"]["reads"] == ["Early Detection", "Agent alerts"], "a save that leaves agent alerts out leaves its tick as it was"
    client.put("/api/connections/bigquery/tables", json={"reads": [{"key": "alerts", "temp_checks": True, "early": False, "watches": True}]}, headers=iap(ADMIN))
    assert ctx.config.platform.early.sources == ["tubular"], "the other tables' choices stay"
    assert client.put("/api/connections/bigquery/tables", json={"reads": [{"key": "nope", "temp_checks": True, "early": False, "watches": False}]},
                      headers=iap(ADMIN)).status_code == 422
    assert client.put("/api/connections/bigquery/tables", json={}, headers=iap(ADMIN)).status_code == 422


def test_the_bigquery_card_checks_every_table_and_names_each_grant_once(ctx, client, monkeypatch, own_secrets):
    client.post("/api/connections/autofill", headers=iap(ADMIN))
    own_dataset(client, ctx)
    ctx.config.inhouse.enabled = ctx.config.sonar_lookup.enabled = True
    assert bigquery_card(client)["state"] == "ready"
    client.put("/api/connections/bigquery/tables", json={"reads": [{"key": "sprinklr", "temp_checks": False, "early": False, "watches": False, "own": False}]},
               headers=iap(ADMIN))

    monkeypatch.setattr(connections, "_on_cloud", lambda: True)  # the check runs as it does on Cloud Run
    ctx.bq = gw = ReadTables()
    assert client.post("/api/connections/bigquery/test", headers=iap(IM)).status_code == 403
    got = client.post("/api/connections/bigquery/test", headers=iap(ADMIN)).json()
    lines = {d["label"]: d for d in got["test"]["details"]}
    assert got["test"]["ok"] is False and got["connection"]["state"] == "failing"
    assert list(lines) == ["Queries", "Dataset", "Events table", "Sundar all mentions", "Sonar", "Brandwatch stored mentions", "Tubular videos",
                           "Sprinklr owned posts", "DSD story selection", "Alert log"], "a table nothing reads, and one that is not set, are not asked for"
    assert lines["Sundar all mentions"]["ok"] is True and lines["Sundar all mentions"]["message"] == "Readable. A day's read scans 3.0 GB."
    grant = 'GRANT `roles/bigquery.dataViewer` ON SCHEMA `bsip-s-bsip-gg-26-2cf3`.`google_bg` TO "serviceAccount:agent@project.test"'
    assert lines["Sonar"]["ok"] is False and lines["Sonar"]["waiting"] is True
    assert lines["Sonar"]["message"] == f"Waiting for access. It is skipped until then. The dataset's owners run: {grant}"
    named = f"-- Sonar: bsip-s-bsip-gg-26-2cf3.google_bg.sonar_raw\n{grant};"
    assert got["test"]["grants"] == [named], "one line for the dataset, though three settings read its table, and it says which table it is for"
    assert got["test"]["message"].startswith("Tubular videos: "), "what the card says first is the table that failed, not the one that is waiting"
    assert lines["Tubular videos"]["ok"] is False and lines["Tubular videos"]["message"].startswith("BigQuery would not take this table's read: 400 Unrecognized name: video_title")
    assert lines["DSD story selection"]["message"] == "Readable. A day's read scans 3.0 GB." and lines["Alert log"]["ok"] is True
    assert lines["Sprinklr owned posts"]["ok"] is True, "the two tables only agent alerts read are checked with their own reads"

    assert lines["Brandwatch stored mentions"]["message"] == "Readable. A day's read scans 3.0 GB. Its location is now set to EU."
    assert ctx.config.platform.temp_check.sources[2].location == "EU", "a table's location is read from BigQuery, not typed"
    sql, params, location = next(a for a in gw.asked if "brandwatch_raw" in a[0])
    assert location == "EU" and params["t_to"] - params["t_from"] == timedelta(days=1), "the table's own read, over a day, where the table lives"
    assert next(a for a in gw.asked if "DSD-story-selection" in a[0])[2] == "US"

    card = bigquery_card(client)
    rows = {r["name"]: r for r in card["tables"]}
    assert card["state"] == "failing" and rows["Sonar"]["status"]["ok"] is False and rows["Sundar all mentions"]["status"]["ok"] is True
    assert rows["Sonar"]["status"]["waiting"] is True and rows["Tubular videos"]["status"]["waiting"] is False
    assert rows["Sprinklr comments"]["status"] is None and rows["Brandwatch stored mentions"]["location"] == "EU"
    listed = client.get("/api/connections", headers=iap(IM)).json()
    assert {"tool": "bigquery", "name": "BigQuery", "text": "Sonar: waiting for access. Send the statement below to the dataset's owners.", "required": True} in listed["todo"]
    assert listed["grants"] == [named], "the line itself is listed once, to copy"

    alert_log = rows["Alert log"]
    client.put("/api/connections/bigquery/tables", json={"tables": [{"id": alert_log["id"], "table": "this-project.slrr_alerts.gone"}]}, headers=iap(ADMIN))
    assert bigquery_card(client)["test"] is None, "a check is forgotten once a table changes"
    ctx.bq = ReadTables()
    again = client.post("/api/connections/bigquery/test", headers=iap(ADMIN)).json()
    gone = next(d for d in again["test"]["details"] if d["label"] == "Alert log")
    assert gone["ok"] is False and gone["message"] == "BigQuery has no table this-project.slrr_alerts.gone."


def checked_card(ctx, client, monkeypatch, gw):
    """The BigQuery card after its check, with every table of posts read by something and `gw` standing in for BigQuery."""
    client.post("/api/connections/autofill", headers=iap(ADMIN))
    own_dataset(client, ctx)
    ctx.config.inhouse.enabled = ctx.config.sonar_lookup.enabled = True
    monkeypatch.setattr(connections, "_on_cloud", lambda: True)
    ctx.bq = gw
    return client.post("/api/connections/bigquery/test", headers=iap(ADMIN)).json()


def test_a_table_waiting_for_access_does_not_fail_the_bigquery_card(ctx, client, monkeypatch, own_secrets):
    got = checked_card(ctx, client, monkeypatch, OnlySonarRefuses())
    lines = {d["label"]: d for d in got["test"]["details"]}
    assert [label for label, d in lines.items() if not d["ok"]] == ["Sonar"] and lines["Sonar"]["waiting"] is True
    assert got["test"]["ok"] is True and got["connection"]["state"] == "connected", "a table its owners have not opened yet is not a broken connection"
    assert got["test"]["message"] == "Connected. Waiting for access to 1 table: Sonar."

    rows = {r["name"]: r for r in bigquery_card(client)["tables"]}
    assert rows["Sonar"]["status"]["ok"] is False and rows["Sonar"]["status"]["waiting"] is True
    assert rows["Sundar all mentions"]["status"] == {"ok": True, "waiting": False, "message": "Readable. A day's read scans 3.0 GB."}
    listed = client.get("/api/connections", headers=iap(IM)).json()
    assert listed["summary"]["failing"] == 0 and listed["summary"]["connected"] >= 1
    assert {"tool": "bigquery", "name": "BigQuery", "text": "Sonar: waiting for access. Send the statement below to the dataset's owners.", "required": True} in listed["todo"], \
        "sending the line is still on the list of what is left"
    grant = 'GRANT `roles/bigquery.dataViewer` ON SCHEMA `bsip-s-bsip-gg-26-2cf3`.`google_bg` TO "serviceAccount:agent@project.test"'
    assert listed["grants"] == [f"-- Sonar: bsip-s-bsip-gg-26-2cf3.google_bg.sonar_raw\n{grant};"]
    check = client.get("/api/audit", params={"action": "connection.test"}, headers=iap(ADMIN)).json()["entries"][0]
    assert check["status"] == "ok" and check["summary"] == "BigQuery: Connected. Waiting for access to 1 table: Sonar."


def test_a_refusal_that_is_not_about_a_table_is_a_failure_and_names_no_grant(ctx, client, monkeypatch, own_secrets):
    got = checked_card(ctx, client, monkeypatch, MayNotRunQueries())
    tables = [d for d in got["test"]["details"] if d.get("row")]
    assert tables and all(not d["ok"] and not d.get("waiting") and not d.get("grant") for d in tables)
    assert all(d["message"].startswith("BigQuery would not take this table's read: 403 Access Denied: Project this-project") for d in tables)
    assert got["test"]["ok"] is False and got["connection"]["state"] == "failing" and got["test"]["grants"] == [], \
        "letting the account read a dataset would not fix this, so no such line is offered"


def test_what_is_left_says_how_people_connect_gmail(ctx, client):
    people = len({a.email.lower() for a in ctx.config.analysts})
    client.post("/api/connections/gmail/test", headers=iap(ADMIN))
    todo = client.get("/api/connections", headers=iap(IM)).json()["todo"]
    assert {"tool": "gmail", "name": "Gmail", "required": False,
            "text": f"People connected: 0 of {people}. Each person presses Connect Gmail at the top of the page."} in todo


def test_two_tables_read_together_have_to_live_in_one_location(ctx, client, monkeypatch, own_secrets):
    own_dataset(client, ctx)
    ctx.config.inhouse.enabled = ctx.config.inhouse.mark_delivered = True  # Our own alerts reads its view and writes the alert log
    monkeypatch.setattr(connections, "_on_cloud", lambda: True)
    ctx.bq = gw = ReadTables()
    monkeypatch.setattr(gw, "get_table", lambda table_id: {"full_id": table_id, "rows": 1, "location": "EU" if "DSD" in table_id else "US"})
    got = client.post("/api/connections/bigquery/test", headers=iap(ADMIN)).json()
    lines = {d["label"]: d for d in got["test"]["details"]}
    assert lines["Story selection view"]["ok"] is True and ctx.config.inhouse.location == "EU"
    assert lines["Alert log"] == {"label": "Alert log", "row": "inhouse.alert_log_table", "ok": False,
                                  "message": "It is in US and Story selection view is in EU. The two are read together, so they have to be in one location."}


def test_the_deployer_is_listed_as_the_admin_until_an_admin_is_named(ctx, client, monkeypatch):
    ctx.config.analysts = []
    monkeypatch.setenv("TRIAGE_BOOTSTRAP_ADMIN", "deployer@ops.test")
    got = client.get("/api/admin/overview", headers=iap("deployer@ops.test")).json()
    row = next(p for p in got["people"] if p["email"] == "deployer@ops.test")
    assert row["role"] == "admin" and row["role_source"] == "deploy", "the person who can sign in as admin is on the list"


class OwnTables:
    """BigQuery as the Console meets it in its own project: two datasets, one of them holding the agent's tables. The
    tables the app reads live in other projects, and this account can read them."""

    project = "seen-project"
    _settings_key = ("seen-project", "", 0)

    def test(self):
        return {"ok": True, "project": self.project, "location": "US", "identity": "agent@project.test"}

    def list_datasets(self):
        return [{"dataset": name, "project": self.project, "full_id": f"{self.project}.{name}"} for name in ("marketing", "slrr_triage")]

    def get_dataset(self, dataset):
        return {"dataset": dataset.split(".")[-1], "project": self.project, "location": "US"}

    def get_table(self, table_id):
        if table_id.startswith("seen-project.") and not table_id.startswith("seen-project.slrr_triage."):
            raise RuntimeError(f"404 Not found: {table_id}")
        return {"full_id": table_id, "rows": 12, "location": "US"}

    def dry_run(self, sql, params=None, *, location=None):
        return 1024 ** 3


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
    assert not any(item["tool"] in ("gcp", "runtime", "bigquery") for item in got["todo"])
    ctx.bq = OwnTables()  # the saved settings name the same project: the same gateway answers
    choices = client.get("/api/connections/bigquery/options", params={"field": "platform.bigquery.dataset"}, headers=iap(ADMIN)).json()
    assert [o["value"] for o in choices["options"]] == ["seen-project.marketing", "seen-project.slrr_triage"]
    checked = client.post("/api/connections/bigquery/test", headers=iap(ADMIN)).json()
    assert checked["test"]["ok"] is True and checked["connection"]["state"] == "connected"
    lines = {d["label"]: d["message"] for d in checked["test"]["details"]}
    assert lines["Events table"] == "seen-project.slrr_triage.agent_events: 12 rows." and lines["Sundar all mentions"] == "Readable. A day's read scans 1.0 GB."
    assert checked["test"]["grants"] == [] and ctx.config.platform.bigquery.location == "US", "the dataset's location is read, not typed"


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
