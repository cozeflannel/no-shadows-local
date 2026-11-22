"""The New temp check form's rules: what each field of the form does to the count.

The workspace can't reach Brandwatch or BigQuery, so both are stood in for at the edge: Brandwatch at the HTTP call
(the bodies are in the API's own shape and go through the real parsers), BigQuery at the gateway. Everything between
(the look-back, the start, the search of our tables, the concern level, the write-up, the steps) is the real code.
"""

from __future__ import annotations

import re
import warnings
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse

import pytest

from triage_agent import secret_admin, tempcheck
from triage_agent.config import TempCheckSource

IM = "im1@ops.test"
QUERY = {"id": 2004162030, "name": "[G EVENT] NOV26 Alleged Gmail Outage", "state": "active", "booleanQuery": "gmail AND outage"}


def bw_time(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000+0000")


class Answer:
    def __init__(self, body: Any, status: int = 200):
        self.body, self.status_code, self.text = body, status, str(body)[:200]

    def json(self) -> Any:
        return self.body


class Brandwatch:
    """Stands in for Brandwatch's API: answers each call in the API's shape and keeps what was asked."""

    def __init__(self, queries: list[dict[str, Any]], hours: dict[datetime, int] | None = None, mentions: list[dict[str, Any]] | None = None):
        self.queries, self.hours, self.mentions, self.asked = queries, hours or {}, mentions or [], []
        self.dashboards: list[dict[str, Any]] = []

    def get(self, url: str, headers: dict[str, str] | None = None, timeout: float | None = None) -> Answer:
        parts = urlparse(url)
        q = {k: v[0] if len(v) == 1 else v for k, v in parse_qs(parts.query).items()}
        self.asked.append((parts.path.split("/projects/77/")[-1], q))
        path = parts.path
        values = lambda rows: Answer({"results": [{"values": rows}]})  # noqa: E731
        if path.endswith("/queries/summary"):
            return Answer({"results": [{k: v for k, v in q.items() if k != "booleanQuery"} for q in self.queries]})
        one = re.search(r"/queries/(\d+)$", path)
        if one:
            found = [q for q in self.queries if str(q["id"]) == one.group(1)]
            return Answer(found[0]) if found else Answer({"errors": [{"message": "Query not found"}]}, 404)
        if path.endswith("/dashboards/summary"):
            return Answer({"results": self.dashboards})
        if path.endswith("/volume/queries/hours"):
            return values([{"id": bw_time(at), "value": n} for at, n in self.hours.items()])
        if path.endswith("/volume/queries/sentiment"):
            return values([{"id": "negative", "value": 60}, {"id": "neutral", "value": 30}, {"id": "positive", "value": 10}])
        if path.endswith("/volume/queries/pageTypes"):
            return values([{"id": "twitter", "name": "Twitter", "value": 80}, {"id": "reddit", "name": "Reddit", "value": 20}])
        if path.endswith("/volume/queries/threadEntryTypes"):
            return values([{"id": "post", "value": 40}, {"id": "share", "value": 50}, {"id": "reply", "value": 10}])
        if path.endswith("/engagementScore/queries/pageTypes"):
            return values([{"id": "twitter", "name": "Twitter", "value": 9000}])
        if path.endswith("/data/mentions"):
            return Answer({"results": self.mentions})
        return Answer({"error": "not found"}, 404)

    def calls(self, ending: str) -> list[dict[str, Any]]:
        return [q for path, q in self.asked if path.endswith(ending)]


class Tables:
    """Stands in for BigQuery: gives each table's rows and keeps every statement with its parameters."""

    project = "p"
    _settings_key = ("", "", 0)

    def __init__(self, posts: list[dict[str, Any]] | None = None, counts: list[dict[str, Any]] | None = None):
        self.posts, self.counts, self.asked = posts or [], counts or [], []
        self.x_rows: list[dict[str, Any]] = []
        self.x_asked: list[tuple[str, dict[str, Any]]] = []

    def query(self, sql: str, params: dict[str, Any] | None = None, **kw: Any) -> list[dict[str, Any]]:
        if "UNNEST(@ids)" in sql:  # X posts looked up by their ids
            self.x_asked.append((sql, dict(params or {})))
            return self.x_rows
        self.asked.append((sql, dict(params or {})))
        return self.counts if "GROUP BY 1, 2, 3" in sql else self.posts

    def dry_run(self, sql: str, params: dict[str, Any] | None = None, **kw: Any) -> int:
        return 2_000_000_000

    def searched(self, table: str) -> list[dict[str, Any]]:
        return [p for sql, p in self.asked if f"`{table}`" in sql and "GROUP BY 1, 2, 3" not in sql]


def source(key: str = "sonar", table: str = "p.d.sonar_raw") -> TempCheckSource:
    return TempCheckSource(key=key, label=key.title(), table=table, text_columns=["text"], url_column="url", time_column="posted",
                           author_column="author", platform_column="platform", engagement_expr="likes + shares", sentiment_column="sentiment")


def post(n: int, at: datetime, text: str = "gmail is down again, outage everywhere") -> dict[str, Any]:
    return {"platform": "x", "author": f"@person{n}", "text": text, "url": f"https://x.com/p/status/{1000 + n}", "posted": at,
            "followers": 100, "eng": float(100 - n), "sentiment": "negative", "language": "en", "one": f"u{n}", "matched": 3}


def reddit(n: int, at: datetime) -> dict[str, Any]:
    return {"pageType": "reddit", "title": f"Gmail outage thread {n}", "snippet": "Anyone else locked out of gmail?",
            "url": f"https://www.reddit.com/r/gmail/comments/{n}", "engagementScore": 500 - n, "sentiment": "negative", "date": bw_time(at)}


@pytest.fixture
def now(clock) -> datetime:
    return clock.now


@pytest.fixture
def hour(now) -> datetime:
    return now.replace(minute=0, second=0, microsecond=0)


@pytest.fixture
def setup(ctx, monkeypatch, fake_llm, hour):
    """Temp checks ON, Brandwatch and one table set up, Gemini's lines scripted."""
    cfg = ctx.config.platform.temp_check
    ctx.config.platform.flags.temp_checks = True
    cfg.brandwatch_project_id, cfg.brandwatch_token_secret, cfg.event_query_prefix = "77", "bw-token", "[G EVENT]"
    cfg.sources = [source()]
    monkeypatch.setattr(secret_admin, "read", lambda _ctx, name: "token-value")
    monkeypatch.setattr(tempcheck, "_LISTS", {})
    fake_llm.on("temp_check.writeup", {"summary": "People report being locked out.", "negativity_drivers": "Lost mail.", "themes": "Workarounds."})

    def make(*, created_hours_ago: float = 10, hours: dict[int, int] | None = None, queries: list[dict[str, Any]] | None = None,
             rows: list[dict[str, Any]] | None = None) -> tuple[Brandwatch, Tables]:
        created = ctx.now() - timedelta(hours=created_hours_ago)
        bw = Brandwatch(queries if queries is not None else [{**QUERY, "creationDate": bw_time(created)}],
                        {hour - timedelta(hours=h): n for h, n in (hours or {}).items()},
                        [reddit(i, hour - timedelta(hours=1)) for i in range(3)])
        monkeypatch.setattr("requests.get", bw.get)
        tables = Tables(rows if rows is not None else [post(i, hour - timedelta(hours=1)) for i in range(3)],
                        [{"platform": "x", "hr": int((hour - timedelta(hours=1)).timestamp() * 1000), "sentiment": "negative", "n": 3, "eng": 290}])
        ctx.bq = tables
        return bw, tables

    return make


def run(ctx, **request: Any) -> tempcheck.TempCheck:
    return tempcheck.run(ctx, tempcheck.TempCheckRequest(requested_by=IM, **request))


def asked_from(call: dict[str, Any]) -> datetime:
    return datetime.fromisoformat(call["startDate"].replace("Z", "+00:00"))


# -- Count from -------------------------------------------------------------------------------------------------------------
def test_with_a_query_the_search_for_its_start_goes_back_two_days_before_the_query_was_made(ctx, setup, hour):
    bw, _ = setup(created_hours_ago=10, hours={3: 150, 2: 400, 1: 90})
    check = run(ctx, query_ref=str(QUERY["id"]))
    assert check.status == "complete", check.error
    created = ctx.now() - timedelta(hours=10)
    assert asked_from(bw.calls("/volume/queries/hours")[0]) == tempcheck.floor_hour(created - timedelta(hours=48))
    assert (check.start["at"], check.start["why"]) == ((hour - timedelta(hours=3)).isoformat(), "spike") and check.total == 640


def test_an_old_query_is_never_looked_back_further_than_the_look_back_setting(ctx, setup, hour):
    bw, _ = setup(created_hours_ago=24 * 30, hours={2: 5})
    run(ctx, query_ref=str(QUERY["id"]))
    back = ctx.config.platform.temp_check.lookback_hours
    assert asked_from(bw.calls("/volume/queries/hours")[0]) == tempcheck.floor_hour(ctx.now() - timedelta(hours=back))


def test_counting_from_a_chosen_time_starts_there_and_gives_no_concern_level(ctx, setup, hour):
    bw, _ = setup(hours={8: 500, 3: 150, 2: 400, 1: 90})
    chosen = ctx.now() - timedelta(hours=5, minutes=20)
    check = run(ctx, query_ref=str(QUERY["id"]), since=chosen)
    start = tempcheck.floor_hour(chosen)
    assert asked_from(bw.calls("/volume/queries/hours")[0]) == start
    assert (check.start["at"], check.start["why"]) == (start.isoformat(), "since") and check.total == 640
    assert check.concern_level == "" and check.level["why"] == "A count from a time you chose is not ranked against past issues."


@pytest.mark.parametrize("ago", [timedelta(hours=-2), timedelta(days=40)])
def test_a_chosen_time_must_be_in_the_past_and_within_the_limit(ctx, setup, ago):
    setup()
    check = run(ctx, query_ref=str(QUERY["id"]), since=ctx.now() - ago)
    assert check.status == "failed" and check.error == '"Count from" must be in the past and within the last 31 days.'


def test_with_no_query_the_day_before_the_alert_is_counted(ctx, setup, hour):
    _, tables = setup(queries=[])
    fired = ctx.now() - timedelta(hours=3)
    check = run(ctx, issue="Alleged Gmail Outage", boolean="gmail AND outage", alert_at=fired, alert_text="Gmail is down")
    assert check.status == "complete", check.error
    asked = tables.searched("p.d.sonar_raw")[0]
    assert asked["t_from"] == tempcheck.floor_hour(fired - timedelta(hours=24)) and asked["t_to"] == ctx.now()
    assert check.basis == "own" and check.start["why"] == "look" and check.alert_text == "Gmail is down"
    assert check.level["why"] == "A count of posts in our own tables is not ranked against past issues' Brandwatch mention counts."


def test_a_count_from_the_standing_queries_is_not_ranked(ctx, setup, hour):
    bw, _ = setup(queries=[], hours={2: 40, 1: 10})
    ctx.config.platform.temp_check.landscape_query_ids = ["501", "502"]
    check = run(ctx, issue="Alleged Gmail Outage", boolean="gmail AND outage")
    asked = bw.calls("/volume/queries/hours")[0]
    assert asked["queryId"] == ["501", "502"] and unquote(asked["search"]) == "gmail AND outage"
    assert asked_from(asked) == tempcheck.floor_hour(ctx.now() - timedelta(hours=24))
    assert check.basis == "brandwatch" and check.standing and check.total == 50 and check.start["why"] == "look"
    assert check.level["why"] == ("A count found by searching Brandwatch's standing Google queries is not ranked against past issues, "
                                  "which are ranked by their own queries' counts.")


# -- Our own data -----------------------------------------------------------------------------------------------------------
def test_with_a_query_our_tables_are_searched_from_the_start_brandwatch_found(ctx, setup, hour):
    _, tables = setup(hours={6: 120, 2: 30})
    check = run(ctx, query_ref=str(QUERY["id"]))
    assert tables.searched("p.d.sonar_raw")[0]["t_from"] == hour - timedelta(hours=6)
    assert check.own_total == 3 and check.query["origin"] == "query"


def test_our_tables_are_left_alone_when_the_box_is_not_ticked(ctx, setup):
    _, tables = setup(hours={3: 150})
    check = run(ctx, query_ref=str(QUERY["id"]), own_on=False)
    assert check.status == "complete" and tables.asked == [] and check.tables == [] and check.own_total is None


def test_with_no_query_our_tables_are_always_searched(ctx, setup):
    _, tables = setup(queries=[])
    check = run(ctx, issue="Alleged Gmail Outage", boolean="gmail AND outage", own_on=False)
    assert tables.searched("p.d.sonar_raw") and check.basis == "own"


def test_only_the_tables_picked_are_searched(ctx, setup):
    _, tables = setup(queries=[])
    ctx.config.platform.temp_check.sources = [source(), source("comments", "p.d.comments")]
    check = run(ctx, issue="Alleged Gmail Outage", boolean="gmail AND outage", own_sources=["comments"])
    assert tables.searched("p.d.comments") and not tables.searched("p.d.sonar_raw")
    assert [t["key"] for t in check.tables] == ["comments"]


def test_a_typed_boolean_searches_our_tables_while_brandwatch_keeps_the_querys_own_numbers(ctx, setup):
    bw, tables = setup(hours={3: 150})
    check = run(ctx, query_ref=str(QUERY["id"]), boolean='"locked out"')
    assert "search" not in bw.calls("/volume/queries/hours")[0], "Brandwatch counts the query itself"
    assert "locked" in str(tables.searched("p.d.sonar_raw")[0]["q0"]) and check.query["origin"] == "typed"
    assert check.query["boolean"] == '"locked out"' and check.query["query_boolean"] == "gmail AND outage"


def test_the_filter_form_is_written_as_a_query(ctx, setup):
    _, tables = setup(queries=[])
    check = run(ctx, issue="Alleged Gmail Outage", filters={"all": "gmail", "any": "outage, down", "none": "giveaway", "platforms": ["X", "Reddit"],
                                                            "authors": "@gmail", "min_followers": 1000})
    assert check.status == "complete", check.error
    assert check.query["origin"] == "filters" and check.query["boolean"] == (
        "(gmail AND (outage OR down) AND site:(twitter.com OR reddit.com) AND author:(gmail) AND authorFollowers:[1000 TO *]) NOT (giveaway)")
    asked = tables.searched("p.d.sonar_raw")[0]
    assert {"x", "reddit"} <= {v for v in asked.values() if isinstance(v, str)}, "the platforms picked are asked of the table's platform column"


# -- Gemini's lines ---------------------------------------------------------------------------------------------------------
def test_geminis_lines_are_not_written_when_the_box_is_not_ticked(ctx, setup, fake_llm):
    setup(hours={3: 150})
    check = run(ctx, query_ref=str(QUERY["id"]), writeup=False)
    assert check.status == "complete" and check.gem == {"why": "the write-up lines were not asked for"}
    assert not [c for c in fake_llm.calls if c.get("purpose") == "temp_check.writeup"]
    assert "Not written (the write-up lines were not asked for)." in check.writeup_text


# -- which query ------------------------------------------------------------------------------------------------------------
def test_a_query_that_is_not_active_is_refused_in_plain_words(ctx, setup):
    setup(queries=[{**QUERY, "state": "deactivated", "creationDate": bw_time(ctx.now() - timedelta(days=3))}])
    check = run(ctx, query_ref=str(QUERY["id"]))
    assert check.status == "failed" and check.error == (
        '"[G EVENT] NOV26 Alleged Gmail Outage" is deactivated in Brandwatch, and Brandwatch only gives numbers for an active query.')


def test_the_issue_is_named_after_the_query_without_its_tags(ctx, setup):
    setup(hours={3: 150})
    assert run(ctx, query_ref=str(QUERY["id"])).issue == "Alleged Gmail Outage"


def test_finding_a_query_by_its_words(ctx, setup):
    made = bw_time(ctx.now() - timedelta(days=2))
    names = ["[G EVENT] NOV26 Alleged Gmail Outage", "[G EVENT] NOV26 Gmail Phishing Wave", "[V2] MAIN G Landscape (EN)", "[G EVENT] OCT26 Pixel Recall"]
    setup(queries=[{"id": 2004162030 + i, "name": n, "state": "active", "creationDate": made, "booleanQuery": "x"} for i, n in enumerate(names)])
    bw = tempcheck.Brandwatch(ctx)
    assert tempcheck.match_query(bw, "alleged gmail outage")["query"]["id"] == 2004162030, "its name without the tags"
    assert tempcheck.match_query(bw, "pixel recall query please")["query"]["name"].endswith("Pixel Recall")
    several = tempcheck.match_query(bw, "gmail")
    assert "query" not in several and [q["id"] for q in several["choices"]] == [2004162031, 2004162030], "newest first"
    near = tempcheck.match_query(bw, "gmail meltdown")
    assert near["choices"] == [] and {q["id"] for q in near["near"]} == {2004162030, 2004162031}
    assert tempcheck.match_query(bw, "https://app.brandwatch.com/project/77/queries/2004162033")["query"]["name"].endswith("Pixel Recall")
    assert tempcheck.match_query(bw, "2004169999") == {"choices": [], "near": [], "missing": 2004169999}


# -- the steps ---------------------------------------------------------------------------------------------------------------
def test_each_step_is_kept_on_the_check_in_order(ctx, setup):
    setup(hours={3: 150})
    check = run(ctx, query_ref=str(QUERY["id"]))
    said = [s["text"] for s in check.steps]
    assert said[:4] == ["Finding the Brandwatch query", "Reading the hourly counts from Brandwatch",
                        "Reading sentiment, sources, mention types and the top posts from Brandwatch", "Searching our own tables (Sonar)"]
    assert re.fullmatch(r"Asking Gemini for the summary, negativity drivers and themes \(\d+ posts read\)", said[4]) and said[5:] == ["Saving"]
    assert all(s["at"] for s in check.steps)


def test_the_brandwatch_link_is_the_querys_newest_dashboard(ctx, setup):
    bw, _ = setup(hours={3: 150})
    bw.dashboards = [{"id": 900, "settings": {"queryId": QUERY["id"]}}, {"id": 905, "settings": {"queryId": QUERY["id"]}}, {"id": 990, "settings": {"queryId": 1}}]
    check = run(ctx, query_ref=str(QUERY["id"]))
    assert check.query["url"] == "https://app.brandwatch.com/project/77/dashboards/905"
    assert "BW source: Link <https://app.brandwatch.com/project/77/dashboards/905>" in check.writeup_text


def test_a_query_with_no_dashboard_links_to_the_projects_queries(ctx, setup):
    setup(hours={3: 150})
    assert run(ctx, query_ref=str(QUERY["id"])).query["url"] == "https://app.brandwatch.com/project/77/queries"


# -- how a query converts ------------------------------------------------------------------------------------------------
def test_the_conversion_report_counts_what_was_read_and_says_which_way_each_gap_leans():
    from triage_agent import bwquery

    c = bwquery.convert('gmail AND "locked out" AND {Gmail} AND outag* AND (down NEAR/3 again) AND title:(broken) AND country:us')
    assert c.ok and c.report["summary"] == {"terms": 6, "phrases": 1, "near": 1, "wildcards": 1, "case_sensitive": 1}
    notes = {n["status"]: n for n in c.report["notes"]}
    assert notes["approximated"]["note"].startswith("title:") and notes["approximated"]["effect"] == "wider"
    assert notes["left out"]["note"].startswith("country:") and notes["left out"]["effect"] == "wider"
    narrower = bwquery.convert("gmail AND (outage OR country:us)").report["notes"]
    assert [n["effect"] for n in narrower] == ["narrower"]


# -- reusing posts gathered earlier ------------------------------------------------------------------------------------------
WORDS = ["gmail outage again", "gmail has me locked out", "another outage for gmail"]


def gathered(ctx, setup, hour) -> tuple[tempcheck.TempCheck, Tables]:
    _, tables = setup(queries=[], rows=[post(i, hour - timedelta(hours=1), WORDS[i]) for i in range(3)])
    return run(ctx, issue="Alleged Gmail Outage", boolean="gmail"), tables


def test_posts_gathered_earlier_are_reused_and_only_the_time_since_is_searched(ctx, setup, clock, hour):
    first, tables = gathered(ctx, setup, hour)
    assert first.own["kept"] == 3 and len(tempcheck.kept_posts(ctx, first.check_id)) == 3
    clock.advance(hours=2)
    tables.asked.clear()
    tables.posts = [post(9, ctx.now() - timedelta(minutes=30), "locked out of gmail too")]
    second = run(ctx, issue="Alleged Gmail Outage", boolean="gmail AND locked", reuse=first.check_id)
    assert second.status == "complete", second.error
    assert tables.searched("p.d.sonar_raw")[0]["t_from"] == tempcheck.floor_hour(first.window_to), "only the time since is searched"
    assert second.own["reused"] == {
        "id": first.check_id, "gathered_at": first.window_to.isoformat(), "kept": 1, "since": 1,
        "note": "Posts up to then are the ones the earlier search found. If this query is wider than that one, search afresh."}
    assert second.own_total == 2 and second.total == 2, "the earlier post that matches the new query, and the one found since"
    assert "Filtering the posts gathered earlier, and searching our tables for what came after" in [s["text"] for s in second.steps]


def test_an_earlier_check_that_does_not_reach_back_far_enough_is_searched_afresh(ctx, setup, clock, hour):
    first, tables = gathered(ctx, setup, hour)
    tables.asked.clear()
    earlier = first.window_from - timedelta(hours=5)
    second = run(ctx, issue="Alleged Gmail Outage", boolean="gmail", reuse=first.check_id, since=earlier)
    assert tables.searched("p.d.sonar_raw")[0]["t_from"] == earlier and "reused" not in second.own


def test_the_posts_kept_with_a_check_stop_at_the_setting(ctx, setup, hour):
    ctx.config.platform.temp_check.keep_posts = 2
    first, _ = gathered(ctx, setup, hour)
    assert first.own["kept"] == 2 and [p["text"] for p in tempcheck.kept_posts(ctx, first.check_id)] == WORDS[:2], "the most engaged are kept"


# -- the broad draft, and what happens when it finds nothing ---------------------------------------------------------------
def test_the_broad_draft_is_put_together_from_geminis_two_lists_by_fixed_rules(ctx, setup, fake_llm):
    setup(queries=[])
    fake_llm.on("temp_check.suggest", {"subject": 'Gmail OR "Google Mail" OR (#gmail) OR gmail', "angle": "outage* OR down, broken AND NOT fix*",
                                       "why": "Catches  the product and how people say it broke."})
    d = tempcheck.suggest_query(ctx, "Alleged Gmail Outage\nGmail is down for everyone")
    assert d["wide"] == '(Gmail OR "Google Mail" OR #gmail)', "each term once, in any case"
    assert d["boolean"] == '(Gmail OR "Google Mail" OR #gmail) AND (outage* OR down OR broken OR fix*)'
    assert d["why"] == "Catches the product and how people say it broke."
    with pytest.raises(tempcheck.Refused):
        tempcheck.draft_from("", "outage")


class Twice(Tables):
    """A table that finds nothing the first time it is searched and the posts the second time."""

    def query(self, sql: str, params: dict[str, Any] | None = None, **kw: Any) -> list[dict[str, Any]]:
        self.asked.append((sql, dict(params or {})))
        first = len(self.asked) <= 2
        return [] if first else (self.counts if "GROUP BY 1, 2, 3" in sql else self.posts)


def test_a_drafted_query_that_finds_nothing_is_tried_once_more_with_the_subject_alone(ctx, setup, fake_llm, hour):
    _, tables = setup(queries=[])
    ctx.bq = Twice(tables.posts, tables.counts)
    fake_llm.on("temp_check.suggest", {"subject": "gmail", "angle": "meltdown*", "why": "the product and one word"})
    check = run(ctx, issue="Alleged Gmail Outage", alert_text="Gmail is down", broad_draft=True, trigger="alert")
    assert check.status == "complete", check.error
    assert check.query["widened"] == {"from": "(gmail) AND (meltdown*)", "why": "The drafted query matched nothing, so every post about the subject was gathered instead."}
    assert check.query["boolean"] == "(gmail)" and check.query["origin"] == "drafted" and check.total == 3 and check.trigger == "alert"
    said = [s["text"] for s in check.steps]
    assert said[0] == "Drafting a broad query from the alert (Gemini)" and "Nothing matched the drafted query: searching for the subject alone" in said
    assert "relevance" not in check.query, "the analyst sees a broad draft, so it is not checked against the posts"


# -- the page's calls ---------------------------------------------------------------------------------------------------------
with warnings.catch_warnings():
    warnings.simplefilter("ignore")
    from fastapi.testclient import TestClient

from console.backend.app import create_app  # noqa: E402
from console.backend.auth import VIEWER_DOMAIN  # noqa: E402

VIEWER = "viewer@" + VIEWER_DOMAIN  # a made-up person at the default viewer domain (no address is written out)


def iap(email: str) -> dict[str, str]:
    return {"X-Goog-Authenticated-User-Email": f"accounts.google.com:{email}"}


@pytest.fixture
def client(ctx, monkeypatch):
    for var in ("TRIAGE_IAP_AUDIENCE", "TRIAGE_DEV_USER", "K_SERVICE", "TRIAGE_BOOTSTRAP_ADMIN"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setenv("TRIAGE_BACKEND", "local")
    with TestClient(create_app(ctx=ctx)) as c:
        yield c


def several(ctx) -> list[dict[str, Any]]:
    made = bw_time(ctx.now() - timedelta(days=2))
    names = [("[G EVENT] NOV26 Alleged Gmail Outage", "active"), ("[G EVENT] NOV26 Gmail Phishing Wave", "deactivated"),
             ("[V2] MAIN G Landscape (EN)", "active"), ("[G EVENT] OCT26 Pixel Recall", "active")]
    return [{"id": 2004162030 + i, "name": n, "state": state, "creationDate": made, "booleanQuery": f"query {i}"} for i, (n, state) in enumerate(names)]


def test_the_query_box_lists_the_event_queries_that_have_every_word_newest_first(ctx, setup, client):
    setup(queries=several(ctx))
    every = client.get("/api/temp-checks/queries", headers=iap(VIEWER)).json()
    assert [q["id"] for q in every["queries"]] == [2004162033, 2004162031, 2004162030], "event queries only"
    found = client.get("/api/temp-checks/queries", params={"q": "gmail wave"}, headers=iap(VIEWER)).json()["queries"]
    assert [(q["name"], q["state"]) for q in found] == [("[G EVENT] NOV26 Gmail Phishing Wave", "deactivated")]
    assert client.get("/api/temp-checks/queries", params={"q": "nothing here"}, headers=iap(VIEWER)).json()["queries"] == []


def test_a_picked_query_shows_its_boolean(ctx, setup, client):
    setup(queries=several(ctx))
    one = client.get("/api/temp-checks/queries/2004162033", headers=iap(VIEWER)).json()
    assert one["name"].endswith("Pixel Recall") and one["boolean"] == "query 3"
    assert client.get("/api/temp-checks/queries/2004169999", headers=iap(VIEWER)).status_code == 404


def test_drafting_a_broad_query_gives_the_boolean_to_check_before_running(ctx, setup, client, fake_llm):
    setup(queries=[])
    fake_llm.on("temp_check.suggest", {"subject": "gmail", "angle": "outage* OR down", "why": "the product and how it broke"})
    r = client.post("/api/temp-checks/suggest", json={"text": "Alleged Gmail Outage\nGmail is down"}, headers=iap(IM))
    assert r.status_code == 200 and r.json() == {"boolean": "(gmail) AND (outage* OR down)", "wide": "(gmail)", "why": "the product and how it broke"}
    assert client.post("/api/temp-checks/suggest", json={"text": "x"}, headers=iap(VIEWER)).status_code == 403
    assert client.post("/api/temp-checks/suggest", json={"text": " "}, headers=iap(IM)).status_code == 400


def test_showing_how_a_query_converts_says_where_it_came_from_what_it_would_scan_and_the_sql(ctx, setup, client):
    setup(created_hours_ago=10)
    r = client.post("/api/temp-checks/convert", json={"query": str(QUERY["id"]), "sources": ["sonar"], "estimate": True}, headers=iap(VIEWER)).json()
    assert r["ok"] and r["origin"] == "query" and r["boolean"] == "gmail AND outage" and r["report"]["summary"]["terms"] == 2
    assert r["estimate"] == {"sonar": {"bytes": 2_000_000_000, "left_out": []}}
    assert r["sql"][0]["table"] == "Sonar" and "FROM `p.d.sonar_raw`" in r["sql"][0]["sql"]
    created = ctx.now() - timedelta(hours=10)
    assert r["window"]["from"] == tempcheck.floor_hour(created - timedelta(hours=48)).isoformat()
    typed = client.post("/api/temp-checks/convert", json={"query": str(QUERY["id"]), "boolean": '"locked out"'}, headers=iap(VIEWER)).json()
    assert typed["origin"] == "typed" and "estimate" not in typed
    form = client.post("/api/temp-checks/convert", json={"filters": {"all": "gmail", "platforms": ["Reddit"]}}, headers=iap(VIEWER)).json()
    assert form["origin"] == "filters" and form["boolean"] == "gmail AND site:(reddit.com)"
    none = client.post("/api/temp-checks/convert", json={}, headers=iap(VIEWER)).json()
    assert not none["ok"] and none["error"] == "There is no query to convert yet."


def test_a_run_from_the_form_can_be_followed_by_its_key_and_ends_in_the_list(ctx, setup, client):
    setup(hours={3: 150})
    waiting = client.get("/api/temp-checks/run/key-1", headers=iap(VIEWER)).json()
    assert waiting == {"check_id": "", "status": "starting", "steps": [], "error": "", "started_at": None}
    r = client.post("/api/temp-checks", json={"query_ref": str(QUERY["id"]), "own_on": True, "own_sources": ["sonar"], "writeup": True,
                                              "run_key": "key-1"}, headers=iap(IM))
    assert r.status_code == 200, r.text
    check = r.json()["check"]
    assert check["status"] == "complete" and check["issue"] == "Alleged Gmail Outage"
    followed = client.get("/api/temp-checks/run/key-1", headers=iap(VIEWER)).json()
    assert followed["check_id"] == check["check_id"] and followed["status"] == "complete" and followed["steps"][-1]["text"] == "Saving"
    assert followed["started_at"] == check["created_at"], "each step's seconds are counted from when the run started"
    listed = client.get("/api/temp-checks", headers=iap(VIEWER)).json()
    row = listed["checks"][0]
    assert row["title"] == check["title"] and row["basis"] == "brandwatch" and row["own_posts"] == 3 and row["own_from"] == check["own"]["from"]
    assert listed["form"]["tables"] == [{"key": "sonar", "label": "Sonar", "freshness": ""}] and listed["form"]["spike_mentions"] == 100
    assert listed["form"]["no_query_hours"] == 24 and "Reddit" in listed["form"]["platforms"] and listed["form"]["event_query_prefix"] == "[G EVENT]"


def test_a_query_named_by_words_that_fit_several_is_offered_as_a_choice_and_nothing_runs(ctx, setup, client):
    setup(queries=several(ctx))
    r = client.post("/api/temp-checks", json={"query_ref": "gmail"}, headers=iap(IM))
    assert r.status_code == 200 and "check" not in r.json()
    assert [q["name"] for q in r.json()["needs"]["choices"]] == ["[G EVENT] NOV26 Gmail Phishing Wave", "[G EVENT] NOV26 Alleged Gmail Outage"]
    assert tempcheck.list_checks(ctx) == []


def test_a_run_marked_as_from_an_alert_keeps_the_alert_and_says_so_in_the_list(ctx, setup, client):
    setup(queries=[])
    fired = (ctx.now() - timedelta(hours=2)).isoformat()
    r = client.post("/api/temp-checks", json={"issue": "Alleged Gmail Outage", "boolean": "gmail AND outage", "alert_at": fired,
                                              "alert_text": "Gmail is down", "from_alert": True}, headers=iap(IM))
    assert r.status_code == 200, r.text
    check = r.json()["check"]
    assert check["trigger"] == "alert" and check["alert_text"] == "Gmail is down" and check["alert_at"].startswith(fired[:19])
    assert client.get("/api/temp-checks", headers=iap(VIEWER)).json()["checks"][0]["trigger"] == "alert"


# -- keep refreshed for a day -----------------------------------------------------------------------------------------------
def test_keep_refreshed_for_a_day_marks_the_check_and_stop_clears_it(ctx, setup, client):
    setup(hours={3: 150})
    first = run(ctx, query_ref=str(QUERY["id"]))
    r = client.post(f"/api/temp-checks/{first.check_id}/action", json={"action": "keep_refreshed"}, headers=iap(IM))
    assert r.status_code == 200, r.text
    hours = ctx.config.platform.temp_check.keep_refreshed_hours
    assert hours == 24 and tempcheck.get(ctx, first.check_id).keep_refreshed_until == ctx.now() + timedelta(hours=hours)
    assert client.post(f"/api/temp-checks/{first.check_id}/action", json={"action": "keep_refreshed"}, headers=iap(VIEWER)).status_code == 403
    client.post(f"/api/temp-checks/{first.check_id}/action", json={"action": "stop_refresh"}, headers=iap(IM))
    assert tempcheck.get(ctx, first.check_id).keep_refreshed_until is None


def test_a_check_kept_refreshed_is_refreshed_on_the_hour_while_automatic_checks_are_off(ctx, setup, clock):
    setup(hours={3: 150})
    assert not ctx.config.platform.flags.auto_temp_checks
    first = run(ctx, query_ref=str(QUERY["id"]))
    tempcheck.record_action(ctx, first.check_id, IM, "keep_refreshed")
    clock.advance(minutes=20)
    assert tempcheck.auto_run(ctx)["refreshed"] == 0, "not before the time between refreshes has passed"
    clock.advance(minutes=45)
    assert tempcheck.auto_run(ctx)["refreshed"] == 1
    newer = [c for c in tempcheck.list_checks(ctx) if c.update_of == first.check_id]
    assert len(newer) == 1 and newer[0].trigger == "scheduled" and newer[0].status == "complete"
    assert newer[0].keep_refreshed_until == tempcheck.get(ctx, first.check_id).keep_refreshed_until, "the newest one carries the day on"
    assert tempcheck.auto_run(ctx)["refreshed"] == 0, "one refresh at a time: the newest is refreshed next, an hour on"
    clock.advance(hours=24)
    assert tempcheck.auto_run(ctx)["refreshed"] == 0, "it stops when the day is over"
    ctx.config.platform.flags.auto_temp_checks = True
    assert tempcheck.auto_run(ctx)["refreshed"] == 0 and tempcheck.auto_run(ctx)["refreshed"] == 0, "the count is reported with the switch ON too"


# -- the posts read, as the temp check app picks them -------------------------------------------------------------------------
def x_mention(post_id: str, eng: float, negative: bool = False) -> dict[str, Any]:
    """An X post as Brandwatch gives it: no words, no author, no link."""
    return {"pageType": "twitter", "guid": post_id, "engagementScore": eng, "sentiment": "negative" if negative else "neutral", "date": "2026-10-12T10:00:00.000+0000"}


SERVED, IN_ROWS, NOWHERE = "1845000000000000001", "1845000000000000002", "1845000000000000003"


@pytest.fixture
def reading(ctx, setup, monkeypatch, hour):
    """A Brandwatch query whose top posts are three X posts and two Reddit threads; X serves one X post, our rows hold another."""
    bw, tables = setup(hours={3: 150})
    bw.mentions = [x_mention(SERVED, 900), x_mention(IN_ROWS, 800), x_mention(NOWHERE, 700), reddit(1, hour), reddit(2, hour)]
    tables.x_rows = [{"id": IN_ROWS, "author": "@rowsauthor", "text": "kept in our rows: gmail outage", "url": f"https://x.com/rowsauthor/status/{IN_ROWS}", "eng": 800.0}]
    real = bw.get

    def get(url: str, headers: dict[str, str] | None = None, timeout: float | None = None):
        if "cdn.syndication.twimg.com" in url:
            if f"id={SERVED}&" in url:
                return Answer({"id_str": SERVED, "text": "gmail is down &amp; out", "user": {"screen_name": "served"}, "favorite_count": 40, "conversation_count": 2})
            return Answer({}, 404)
        return real(url, headers, timeout)
    monkeypatch.setattr("requests.get", get)
    return bw, tables


def test_brandwatchs_x_posts_get_their_words_from_x_and_our_rows_fill_the_gaps(ctx, reading):
    check = run(ctx, query_ref=str(QUERY["id"]))
    assert check.status == "complete", check.error
    by_key = {p["id"] or p["key"]: p for p in check.read_posts}
    assert by_key[SERVED]["key"] == f"x:{SERVED}", "an X post has the same key whether Brandwatch or our own tables gave it"
    assert by_key[SERVED]["text"] == "gmail is down & out" and by_key[SERVED]["text_from"] == "X embed data"
    assert (by_key[SERVED]["author"], by_key[SERVED]["likes"], by_key[SERVED]["replies"]) == ("served", 40, 2)
    assert by_key[SERVED]["url"] == f"https://x.com/served/status/{SERVED}"
    assert by_key[IN_ROWS]["text"] == "kept in our rows: gmail outage" and by_key[IN_ROWS]["text_from"] == "our own rows"
    assert NOWHERE not in by_key, "a post with no words anywhere is not read"
    assert check.coverage == {"ranked": 10, "x": 3, "from_embed": 1, "in_rows": 1, "from_rows_only": 1, "no_words": 1}
    assert "Looking up the words of 3 X posts (X's embed data, and our own rows)" in [s["text"] for s in check.steps]


def test_the_posts_are_ranked_by_what_is_known_of_their_engagement(ctx, reading):
    check = run(ctx, query_ref=str(QUERY["id"]))
    order = [p["key"] for p in check.posts]
    # our rows' post keeps Brandwatch's 800; the Reddit threads have 499 and 498; X's own counters (40 likes + 2 replies) rank the served one last
    assert order == [f"x:{IN_ROWS}", "reddit.com/r/gmail/comments/1", "reddit.com/r/gmail/comments/2", f"x:{SERVED}"]
    assert [p["key"] for p in check.read_posts] == order, "what Gemini reads starts with the write-up's posts"
    assert not [p for p in check.read_posts if p.get("table")], "with Brandwatch's numbers the posts read are Brandwatch's: our own stay on their own side"
    assert "served on X" in check.writeup_text and "(42 Engagements)" in check.writeup_text


def test_the_write_up_lists_as_many_posts_as_the_setting_and_gemini_reads_up_to_its_own(ctx, reading):
    cfg = ctx.config.platform.temp_check
    cfg.writeup_posts, cfg.gemini_posts = 2, 3
    check = run(ctx, query_ref=str(QUERY["id"]))
    assert len(check.posts) == 2 and len(check.read_posts) == 3
    assert check.writeup_text.count("  • ") == 2 and re.search(r"\(3 posts read\)", " ".join(s["text"] for s in check.steps))


def test_with_our_own_tables_as_the_basis_the_posts_read_are_our_own(ctx, setup, hour):
    setup(queries=[])
    check = run(ctx, issue="Alleged Gmail Outage", boolean="gmail AND outage")
    assert check.basis == "own" and [p["key"] for p in check.read_posts] == [f"x:{1000 + i}" for i in range(3)]
    assert check.read_posts[0]["x"] and check.read_posts[0]["id"] == "1000" and check.read_posts[0]["text_from"] == "Sonar"
    assert check.coverage == {} and check.chart["unit"] == "Posts" and check.chart["points"], "the chart's hours are kept with the check"
