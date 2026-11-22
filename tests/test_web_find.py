"""Searching the web from a temp check: an analyst asks what they need to know about that temp check's issue, Gemini
searches Google for it, and the analyst who asked gets the answer with its sources and Google's search suggestions.

Gemini is stood in for by purpose (no model is called); Brandwatch and BigQuery as in the form's tests. The switch,
what is asked, what comes back, what is kept (nothing) and the record of who asked are the real code.
"""

from __future__ import annotations

from typing import Any

import pytest

from triage_agent import tempcheck, webfind
from triage_agent.llm import LLMError

from test_tempcheck_form import IM, QUERY, VIEWER, client, hour, iap, now, run, setup  # noqa: F401 - fixtures

OTHER_IM = "im2@ops.test"
CHIPS = '<style>.chip{color:#1f1f1f}</style><div class="container"><a class="chip" href="https://www.google.com/search?q=gmail+outage">gmail outage</a></div>'
SAID = "Posts on X report being locked out of Gmail. A Reddit thread blames an update."
FOUND = {
    "text": SAID, "queries": ["gmail outage site:x.com", "gmail outage reddit"],
    "sources": [{"title": "x.com", "domain": "x.com", "uri": "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AAA"},
                {"title": "Gmail down? : r/GMail", "domain": "reddit.com", "uri": "https://vertexaisearch.cloud.google.com/grounding-api-redirect/BBB"}],
    "cites": [{"start": 0, "end": SAID.index("Gmail.") + len("Gmail."), "sources": [0]},
              {"start": SAID.index("A Reddit"), "end": len(SAID), "sources": [1, 0]}],
    "suggestions": CHIPS,
}


@pytest.fixture
def check(ctx, setup, fake_llm) -> tempcheck.TempCheck:
    """One finished temp check on a Brandwatch query, with the web search switch ON and Gemini's answer scripted."""
    setup(hours={3: 150})
    ctx.config.platform.flags.temp_check_web = True
    fake_llm.on("temp_check.web", FOUND)
    return run(ctx, query_ref=str(QUERY["id"]), own_on=True)


def ask(client, check_id: str, need: str = "Are people on Reddit blaming an update?", who: str = IM):
    return client.post(f"/api/temp-checks/{check_id}/web", json={"need": need}, headers=iap(who))


def web_calls(fake_llm) -> list[dict[str, Any]]:
    return [c for c in fake_llm.calls if c.get("kind") == "web"]


# -- the switch ---------------------------------------------------------------------------------------------------------
def test_the_switch_is_off_until_someone_turns_it_on(ctx, setup, client, fake_llm):
    assert type(ctx.config.platform.flags).model_fields["temp_check_web"].default is False
    setup(hours={3: 150})
    made = run(ctx, query_ref=str(QUERY["id"]))
    listed = client.get("/api/temp-checks", headers=iap(VIEWER)).json()
    assert listed["web_enabled"] is False
    r = ask(client, made.check_id)
    assert r.status_code == 409 and r.json()["error"] == 'Searching the web from a temp check is switched off. An admin can turn on "Search the web in a temp check" under Settings, Switches.'
    assert web_calls(fake_llm) == [], "nothing is asked of Google while the switch is OFF"
    ctx.config.platform.flags.temp_check_web = True
    assert client.get("/api/temp-checks", headers=iap(VIEWER)).json()["web_enabled"] is True


def test_no_temp_check_searches_the_web_on_its_own(ctx, check, fake_llm):
    assert check.status == "complete" and web_calls(fake_llm) == [], "a search is made only when an analyst asks for one"


# -- what is asked ------------------------------------------------------------------------------------------------------
def test_gemini_is_asked_about_this_temp_checks_issue_and_what_the_analyst_needs(ctx, check, client, fake_llm):
    cfg = ctx.config.platform.temp_check
    assert cfg.web_search == "google" and cfg.web_sites == ["x.com", "reddit.com", "linkedin.com"] and cfg.web_exclude_sites == []
    assert ask(client, check.check_id).status_code == 200
    call = web_calls(fake_llm)[0]
    assert call["purpose"] == "temp_check.web" and call["search"] == "google" and call["exclude_sites"] == []
    assert call["model"] == (cfg.model or ctx.config.models.drafting)
    asked = call["prompt"]
    assert "<issue>\nAlleged Gmail Outage\n</issue>" in asked and "<query>\ngmail AND outage\n</query>" in asked
    assert "<need>\nAre people on Reddit blaming an update?\n</need>" in asked
    assert "<sites>\nx.com, reddit.com, linkedin.com\n</sites>" in asked
    assert check.window_from.isoformat() in asked and check.window_to.isoformat() in asked, "the stretch the temp check counted"
    assert "gmail is down again" not in asked, "the posts in our tables are not sent to the search"
    assert "numbers" in call["system"] and "untrusted" in call["system"]


def test_the_settings_choose_the_search_the_sites_and_what_is_left_out(ctx, check, client, fake_llm):
    cfg = ctx.config.platform.temp_check
    cfg.web_search, cfg.web_sites, cfg.web_exclude_sites = "enterprise", ["bsky.app"], ["spam.test"]
    assert ask(client, check.check_id).status_code == 200
    call = web_calls(fake_llm)[0]
    assert call["search"] == "enterprise" and call["exclude_sites"] == ["spam.test"] and "<sites>\nbsky.app\n</sites>" in call["prompt"]
    cfg.web_sites = []
    ask(client, check.check_id)
    assert "<sites>" not in web_calls(fake_llm)[1]["prompt"], "with no sites named, Gemini is not pointed anywhere first"


def test_with_nothing_typed_the_issue_itself_is_what_is_looked_into(ctx, check, client, fake_llm):
    got = ask(client, check.check_id, need="   ")
    assert got.status_code == 200 and got.json()["need"] == "What people are saying about it"
    assert "<need>\nWhat people are saying about it\n</need>" in web_calls(fake_llm)[0]["prompt"]


def test_a_temp_check_with_no_query_is_looked_into_by_its_issue_and_alert(ctx, setup, client, fake_llm):
    setup(hours={})
    ctx.config.platform.flags.temp_check_web = True
    fake_llm.on("temp_check.web", FOUND)
    made = run(ctx, issue="Gmail outage", boolean="gmail AND (outage OR down)", alert_text="Is Gmail down for anyone else?", alert_at=ctx.now())
    assert ask(client, made.check_id).status_code == 200
    asked = web_calls(fake_llm)[0]["prompt"]
    assert "<issue>\nGmail outage\n</issue>" in asked and "<query>\ngmail AND (outage OR down)\n</query>" in asked
    assert "<alert>\nIs Gmail down for anyone else?\n</alert>" in asked


# -- what comes back ----------------------------------------------------------------------------------------------------
def test_the_analyst_gets_the_answer_its_numbered_sources_and_googles_suggestions_unchanged(ctx, check, client):
    got = ask(client, check.check_id)
    assert got.status_code == 200, got.text
    body = got.json()
    assert body["need"] == "Are people on Reddit blaming an update?" and body["search"] == "google" and body["at"] == ctx.now().isoformat()
    assert body["parts"] == [{"text": "Posts on X report being locked out of Gmail.", "sources": [1]},
                             {"text": " A Reddit thread blames an update.", "sources": [1, 2]}]
    assert body["sources"] == [{"n": 1, "title": "x.com", "site": "x.com", "url": "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AAA"},
                               {"n": 2, "title": "Gmail down? : r/GMail", "site": "reddit.com", "url": "https://vertexaisearch.cloud.google.com/grounding-api-redirect/BBB"}]
    assert body["queries"] == ["gmail outage site:x.com", "gmail outage reddit"]
    assert body["suggestions"] == CHIPS, "Google's suggestions go to the page exactly as Google gave them"
    assert set(body) == {"at", "need", "search", "parts", "sources", "queries", "suggestions"}


def test_words_with_no_source_behind_them_come_back_unmarked(ctx, check, client, fake_llm):
    fake_llm.on("temp_check.web", {**FOUND, "text": SAID + " Nothing was found on LinkedIn."})
    parts = ask(client, check.check_id).json()["parts"]
    assert parts[-1] == {"text": " Nothing was found on LinkedIn.", "sources": []} and "".join(p["text"] for p in parts) == SAID + " Nothing was found on LinkedIn."


def test_a_source_whose_link_is_not_a_web_address_is_left_out_and_the_rest_keep_their_numbers(ctx, check, client, fake_llm):
    fake_llm.on("temp_check.web", {**FOUND, "sources": [{"title": "bad", "domain": "bad.test", "uri": "javascript:alert(1)"}, FOUND["sources"][1]]})
    body = ask(client, check.check_id).json()
    assert body["sources"] == [{"n": 1, "title": "Gmail down? : r/GMail", "site": "reddit.com", "url": "https://vertexaisearch.cloud.google.com/grounding-api-redirect/BBB"}]
    assert [p["sources"] for p in body["parts"]] == [[], [1]]


def test_when_google_refuses_the_search_the_page_is_told_why(ctx, check, client, fake_llm):
    def refuse(call: dict[str, Any]) -> Any:
        raise LLMError("Gemini call failed (gemini-test @ global): 400 Search grounding is not enabled for this project")

    fake_llm.on("temp_check.web", refuse)
    got = ask(client, check.check_id)
    assert got.status_code == 503 and got.json()["error"].startswith("The web could not be searched: ") and "not enabled for this project" in got.json()["error"]


def test_an_answer_with_no_sources_says_nothing_was_found_instead_of_showing_unsourced_words(ctx, check, client, fake_llm):
    fake_llm.on("temp_check.web", {"text": "Gmail had an outage, as far as I recall.", "queries": [], "sources": [], "cites": [], "suggestions": ""})
    body = ask(client, check.check_id).json()
    assert body["parts"] == [] and body["sources"] == [] and body["queries"] == [] and body["suggestions"] == ""


# -- who may ask, and what is kept --------------------------------------------------------------------------------------
def test_a_viewer_cannot_search_and_an_unknown_temp_check_is_not_found(ctx, check, client, fake_llm):
    assert ask(client, check.check_id, who=VIEWER).status_code == 403
    assert ask(client, "TC-NOPE").status_code == 404
    assert web_calls(fake_llm) == []


def test_a_temp_check_that_counted_nothing_can_still_be_looked_into(ctx, setup, client, fake_llm):
    setup(hours={})
    ctx.config.platform.flags.temp_check_web = True
    fake_llm.on("temp_check.web", FOUND)
    made = run(ctx, query_ref=str(QUERY["id"]))
    assert made.status == "empty"
    got = ask(client, made.check_id)
    assert got.status_code == 200 and got.json()["sources"], "an issue nothing was counted for is when an analyst looks elsewhere"


def test_nothing_that_was_found_is_kept_and_no_number_or_write_up_changes(ctx, check, client):
    before = tempcheck.get(ctx, check.check_id).model_dump(mode="json")
    assert ask(client, check.check_id).status_code == 200
    after = tempcheck.get(ctx, check.check_id).model_dump(mode="json")
    assert after == before, "the temp check, its numbers and its write-up are as they were"
    again = client.get(f"/api/temp-checks/{check.check_id}", headers=iap(OTHER_IM)).json()
    kept = str(again) + str(client.get("/api/temp-checks", headers=iap(OTHER_IM)).json())
    assert "grounding-api-redirect" not in kept and "locked out of Gmail" not in kept and "class=\"chip\"" not in kept, "another analyst is shown none of it"


def test_who_asked_and_what_for_is_on_record_without_what_google_gave(ctx, check, client):
    ask(client, check.check_id)
    entry = client.get("/api/audit", params={"action": "temp_check.web"}, headers=iap(IM)).json()["entries"][0]
    assert entry["actor"] == IM and entry["target_id"] == check.check_id and entry["surface"] == "console"
    assert entry["detail"] == {"need": "Are people on Reddit blaming an update?", "search": "google"}
    assert "grounding-api-redirect" not in str(entry) and "locked out" not in str(entry)


def test_why_it_is_off_is_said_in_plain_words(ctx):
    assert webfind.why_off(ctx) == 'Searching the web from a temp check is switched off. An admin can turn on "Search the web in a temp check" under Settings, Switches.'
    ctx.config.platform.flags.temp_check_web = True
    assert webfind.why_off(ctx) == ""
