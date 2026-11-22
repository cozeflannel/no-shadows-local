"""The temp check's tables of posts, read the way the temp check app reads them.

tests/parity/tempcheck_own_sql.json holds the app's own five tables (tempcheck-app/lib/owndata.js SOURCES) and the
statements its sqlFor builds for four queries. The Console keeps the same tables as data in
config/temp_check_app.yaml; here they go through the Console's search builder and must give the same statements.
The WHERE condition made from the query is the converter's work (bwquery) and is not part of this comparison: each
statement is compared outside it. tests/parity/make_tempcheck_own_sql.js makes the file.
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

from triage_agent import bwquery, tempcheck
from triage_agent.config import TempCheckSource

APP = json.loads((Path(__file__).parent / "parity" / "tempcheck_own_sql.json").read_text())
START = datetime.fromtimestamp(APP["from"] / 1000, tz=timezone.utc)
END = datetime.fromtimestamp(APP["to"] / 1000, tz=timezone.utc)
WHERE = re.compile(r"(hits AS \(\s*SELECT \* FROM typed\s*WHERE ).*?(\s*QUALIFY )", re.S)


def outside_the_query(sql: str) -> str:
    """A statement without the condition made from the query, and without differences in spacing."""
    assert WHERE.search(sql), "the statement has the hits step with its WHERE and QUALIFY"
    return re.sub(r"\s+", " ", WHERE.sub(r"\1<the query>\2", sql)).strip()


def whole(sql: str) -> str:
    """A whole statement, the query's condition included, without differences in spacing."""
    return re.sub(r"\s+", " ", sql).strip()


def tables() -> dict[str, TempCheckSource]:
    return {t.key: t for t in tempcheck.app_setup()["tables"]}


def test_the_setup_file_names_the_apps_five_tables_as_the_app_has_them():
    ours = tempcheck.app_setup()["tables"]
    assert [t.key for t in ours] == [t["key"] for t in APP["tables"]], "the same tables, in the app's order"
    for mine, theirs in zip(ours, APP["tables"]):
        assert (mine.label, mine.what, mine.table, mine.location) == (theirs["label"], theirs["what"], theirs["table"], theirs["location"])
        assert sorted(mine.has) == theirs["has"] and mine.dedupe_by == theirs["keyBy"]
        assert mine.enabled and mine.read_sql.count("{table}") == 1
    assert [t.key for t in ours if t.x_lookup] == ["alerts"], "the app looks X posts' words up in the alert rows only"
    assert tempcheck.app_setup()["brandwatch"]["brandwatch_project_id"] == str(APP["brandwatchProject"])


@pytest.mark.parametrize("text", list(APP["queries"]))
def test_each_table_is_searched_with_the_statements_the_app_builds(text: str):
    plan = bwquery.convert(text).plan
    for key, theirs in APP["queries"][text].items():
        mine = tempcheck.source_sql(tables()[key], plan, START, END, APP["rowLimit"])
        if "skip" in theirs:
            assert mine.get("skip") == theirs["skip"], f"{key}: {text}"
            continue
        assert not mine.get("skip"), f"{key} is searched for: {text}"
        assert whole(mine["posts"]) == whole(theirs["posts"]), f"{key} posts: {text}"
        assert whole(mine["counts"]) == whole(theirs["counts"]), f"{key} counts: {text}"
        assert mine["removed"] == theirs["removed"], f"{key} left out: {text}"
        assert mine["location"] == theirs["location"] and mine["params"]["lim"] == theirs["lim"]
        assert mine["params"]["t_from"] == START and mine["params"]["t_to"] == END


def test_a_table_given_by_its_columns_is_read_into_the_same_shape():
    src = TempCheckSource(key="comments", label="Comments", table="p.d.comments", text_columns=["title", "message"], url_column="permalink",
                          id_column="comment_id", dedupe_by="id", time_column="created_time", platform_value="YouTube", author_column="who",
                          followers_column="subs", engagement_expr="likes + replies", filter_sql="is_own = FALSE")
    read = re.sub(r"\s+", " ", tempcheck.read_of(src))
    assert read.startswith("SELECT ") and "FROM `p.d.comments` WHERE created_time >= @t_from AND created_time < @t_to AND (is_own = FALSE)" in read
    for column in ("AS platform", "AS author", "AS text", "AS url", "created_time AS posted", "AS followers", "AS eng", "AS sentiment", "AS language",
                   "CAST(NULL AS INT64) AS shares", "CAST(NULL AS INT64) AS replies", "created_time AS seen", "AS one"):
        assert column in read, column
    assert "'youtube'" in read and "CAST(comment_id AS STRING)" in read, "the platform it holds, and a row is itself by its id"
    built = tempcheck.source_sql(src, bwquery.convert("gmail").plan, START, END, 500)
    theirs = APP["queries"]["gmail AND (outage OR down)"]["sonar"]
    after_base = lambda sql: outside_the_query(sql).split("typed AS (", 1)[1]  # noqa: E731
    assert after_base(built["posts"]) == after_base(theirs["posts"]), "after its own read, the statement is the app's"
    assert tempcheck.source_has(src) == {"text", "author", "url", "platform", "followers"}


def test_a_read_must_be_one_select_that_names_where_the_table_goes():
    ok = {"key": "t", "table": "p.d.t", "has": ["text"], "read_sql": "SELECT 1 AS one FROM `{table}`"}
    assert TempCheckSource(**ok).read_sql
    for bad, why in (({"read_sql": "SELECT 1 FROM `p.d.t`"}, "{table}"), ({"read_sql": "DELETE FROM `{table}`"}, "SELECT"),
                     ({"read_sql": "SELECT 1 FROM `{table}`; DROP TABLE x"}, "one statement"), ({"has": []}, "text")):
        with pytest.raises(ValidationError) as err:
            TempCheckSource(**{**ok, **bad})
        assert why in str(err.value)


# -- the search itself, as the app's search() runs it ---------------------------------------------------------------------------
class Tables:
    """Stands in for BigQuery: each table's rows by its name in the statement, and every statement asked."""

    project = "p"
    _settings_key = ("", "", 0)

    def __init__(self, rows: dict[str, list[dict[str, Any]]], counts: dict[str, list[dict[str, Any]]] | None = None, scan: int = 1_000_000_000):
        self.rows, self.counts, self.scan, self.asked, self.estimated = rows, counts or {}, scan, [], []

    def _table(self, sql: str) -> str:
        return next(t for t in {**self.rows, **self.counts} if f"`{t}`" in sql)

    def query(self, sql: str, params: dict[str, Any] | None = None, **kw: Any) -> list[dict[str, Any]]:
        counting = "GROUP BY 1, 2, 3" in sql
        self.asked.append(("counts" if counting else "posts", self._table(sql), dict(params or {}), kw))
        return (self.counts if counting else self.rows).get(self._table(sql), [])

    def dry_run(self, sql: str, params: dict[str, Any] | None = None, **kw: Any) -> int:
        self.estimated.append(self._table(sql))
        return self.scan


NOW = datetime(2026, 11, 22, 10, 20, tzinfo=timezone.utc)
FROM = NOW.replace(minute=0) - timedelta(hours=6)


def row(url: str, text: str = "gmail outage", *, eng: float | None = 10, hours_ago: float = 1, platform: str = "x", sentiment: str | None = None,
        followers: int | None = None, shares: int | None = None, replies: int | None = None, one: str = "", matched: int = 0) -> dict[str, Any]:
    at = NOW - timedelta(hours=hours_ago)
    return {"platform": platform, "author": "@someone", "text": text, "url": url, "posted": at, "followers": followers, "eng": eng, "sentiment": sentiment,
            "language": None, "shares": shares, "replies": replies, "one": one or url, "matched": matched, "newest": at}


def search(ctx, gw: Tables, keys: list[str] | None = None, **settings: Any) -> dict[str, Any]:
    cfg = ctx.config.platform.temp_check
    cfg.sources = tempcheck.app_setup()["tables"]
    for name, value in settings.items():
        setattr(cfg, name, value)
    ctx.bq = gw
    return tempcheck.search_own(ctx, bwquery.convert("gmail AND outage").plan, FROM, NOW, keys)


ALERTS, SONAR = "brand-social-central-data.social_alerts_dataset.all_sundar_mentions", "bsip-s-bsip-gg-26-2cf3.google_bg.sonar_raw"
SPRINKLR = "brand-social-central-data.reporting_data.sprinklr_inbound_comments"


def test_a_post_in_two_tables_is_counted_once_with_the_most_engagement_known(ctx):
    post = "https://x.com/someone/status/1845123456789012345"
    gw = Tables({ALERTS: [row(post, eng=40, sentiment="negative", followers=900, matched=2), row("https://www.reddit.com/r/gmail/comments/abc1/", eng=5, platform="reddit", matched=2)],
                 SONAR: [row(post.replace("x.com", "twitter.com"), eng=75, shares=12, replies=3, hours_ago=1, matched=1)]})
    got = search(ctx, gw, ["alerts", "sonar"])
    assert got["error"] == "" and got["complete"] is True and got["total"] == 2, "every match was read, so each post is counted once"
    top = got["posts"][0]
    assert top["eng"] == 75 and top["table"] == "sonar" and top["also"] == ["alerts"], "the copy with the most engagement is kept"
    assert top["sentiment"] == "negative" and top["followers"] == 900 and top["negative"] is True, "what the other copy knew is kept with it"
    assert top["key"] == "x:1845123456789012345" and top["source"] == "X" and top["table_label"] == "Sonar"
    assert got["spread"] == {"counted": 1, "reposts": 12, "replies": 3}, "the posts' own repost and reply counters, where they came with any"
    assert [k for kind, *_ in gw.asked for k in [kind]] == ["posts", "posts"], "no counting statement is run when every match was read"
    by_key = {t["key"]: t for t in got["tables"]}
    assert (by_key["alerts"]["matched"], by_key["alerts"]["read"]) == (2, 2) and by_key["sonar"]["matched"] == 1
    assert by_key["sonar"]["newest"] == (NOW - timedelta(hours=1)).isoformat() and by_key["sonar"]["bytes"] == 1_000_000_000
    assert got["sources"] == [{"label": "X", "n": 1}, {"label": "Reddit", "n": 1}] and got["sentiment"] == {"negative": 1}


def test_on_equal_engagement_the_earlier_table_in_settings_wins(ctx):
    post = "https://x.com/someone/status/1845123456789012345"
    gw = Tables({SONAR: [row(post, eng=40, matched=1)], ALERTS: [row(post, eng=40, sentiment="neutral", matched=1)]})
    got = search(ctx, gw, ["alerts", "sonar"])
    assert got["posts"][0]["table"] == "alerts" and got["posts"][0]["also"] == ["sonar"] and got["total"] == 1


def test_comments_under_one_post_are_each_their_own(ctx):
    under = "https://www.instagram.com/p/Cabc123XYZ/"
    gw = Tables({SPRINKLR: [row(under, "gmail outage again", one="c1", platform="instagram", matched=2), row(under, "outage for gmail", one="c2", platform="instagram", matched=2)]})
    got = search(ctx, gw, ["sprinklr"])
    assert got["total"] == 2 and {p["key"] for p in got["posts"]} == {"sprinklr:c1", "sprinklr:c2"}


def test_a_table_with_more_matches_than_were_read_is_counted_by_its_counting_statement(ctx):
    hr = lambda h: int((NOW.replace(minute=0, second=0, microsecond=0) - timedelta(hours=h)).timestamp() * 1000)  # noqa: E731
    gw = Tables({SONAR: [row(f"https://x.com/a/status/184512345678901234{i}", eng=100 - i, matched=640) for i in range(3)],
                 ALERTS: [row("https://www.reddit.com/r/gmail/comments/abc1/", platform="reddit", sentiment="negative", matched=1)]},
                counts={SONAR: [{"platform": "x", "hr": hr(3), "sentiment": "", "n": 240, "eng": 9000, "shares": 50, "replies": 20, "counted": 200},
                                {"platform": "youtube", "hr": hr(2), "sentiment": "", "n": 400, "eng": 5000, "shares": 0, "replies": 0, "counted": 0}]})
    got = search(ctx, gw, ["alerts", "sonar"], row_limit=3)
    assert got["complete"] is False and got["total"] == 641, "the table's own count, plus the other table's posts"
    assert ("counts", SONAR) in [(kind, table) for kind, table, *_ in gw.asked] and ("counts", ALERTS) not in [(kind, table) for kind, table, *_ in gw.asked]
    assert got["sources"] == [{"label": "YouTube", "n": 400}, {"label": "X", "n": 240}, {"label": "Reddit", "n": 1}]
    assert got["spread"] == {"counted": 200, "reposts": 50, "replies": 20} and got["sentiment"] == {"negative": 1}
    hours = {h["at"]: h["n"] for h in got["hours"]}
    assert hours[NOW.replace(minute=0) - timedelta(hours=3)] == 240 and hours[NOW.replace(minute=0) - timedelta(hours=1)] == 1
    assert {t["key"]: (t["matched"], t["read"]) for t in got["tables"]}["sonar"] == (640, 3)


def test_a_search_over_the_cap_is_skipped_with_the_reason_and_costs_nothing(ctx):
    gw = Tables({SONAR: [row("https://x.com/a/status/1845123456789012345", matched=1)]}, scan=30 * 1024 ** 3)
    got = search(ctx, gw, ["sonar"], max_scan_gb=20)
    assert got["total"] == 0 and gw.asked == [] and gw.estimated == [SONAR]
    assert got["tables"][0]["skipped"] == "It would scan 30.0 GB, over the 20 GB cap. Use a shorter window."


def test_x_posts_are_looked_up_only_in_the_tables_marked_for_it(ctx):
    cfg = ctx.config.platform.temp_check
    cfg.sources = tempcheck.app_setup()["tables"]

    class XRows(Tables):
        def query(self, sql, params=None, **kw):
            self.asked.append((sql, dict(params or {}), kw))
            return [{"id": "1845123456789012345", "author": "@someone", "text": "gmail is down", "url": "https://x.com/someone/status/1845123456789012345", "eng": 12}]

    ctx.bq = gw = XRows({})
    found = tempcheck.find_x_posts(ctx, ["1845123456789012345", "not-an-id"], FROM, NOW)
    assert found["1845123456789012345"]["text"] == "gmail is down" and found["1845123456789012345"]["from"] == "our own rows"
    assert len(gw.asked) == 1, "one table is asked: the one marked for it"
    sql, params, kw = gw.asked[0]
    assert f"`{ALERTS}`" in sql and "platform = 'x'" in sql and "IN UNNEST(@ids)" in sql and kw["location"] == "US"
    assert params["ids"] == ["1845123456789012345"] and params["t_from"] == FROM and params["t_to"] == NOW


def test_facebook_permalinks_are_told_apart_by_the_ids_in_their_query():
    one = tempcheck.post_key("https://www.facebook.com/permalink.php?story_fbid=111&id=999&ref=share")
    same = tempcheck.post_key("https://m.facebook.com/permalink.php?id=999&story_fbid=111")
    other = tempcheck.post_key("https://www.facebook.com/permalink.php?story_fbid=222&id=999")
    assert one == same == "facebook.com/permalink.php?story_fbid=111&id=999" and other != one
    assert tempcheck.post_key("https://mobile.twitter.com/a/status/123456") == "x:123456"
    assert tempcheck.post_key("https://mobile.reddit.com/r/gmail/comments/abc1/") == "reddit.com/r/gmail/comments/abc1"


def test_a_temp_check_keeps_how_its_own_tables_were_counted(ctx, fake_llm, clock):
    ctx.config.platform.flags.temp_checks = True
    ctx.config.platform.temp_check.sources = tempcheck.app_setup()["tables"]
    now = clock.now
    at = now - timedelta(hours=2)
    posts = [{**row(f"https://x.com/a/status/184512345678901234{i}", eng=50 - i, shares=4, replies=1, matched=2), "posted": at, "newest": at} for i in range(2)]
    ctx.bq = Tables({SONAR: posts})
    fake_llm.on("temp_check.writeup", {"summary": "People report an outage.", "negativity_drivers": "", "themes": ""})
    check = tempcheck.run(ctx, tempcheck.TempCheckRequest(issue="Alleged Gmail Outage", boolean="gmail AND outage", own_sources=["sonar"], requested_by="im1@ops.test"))
    assert check.status == "complete" and check.basis == "own" and check.total == 2
    assert check.own["complete"] is True and check.own["spread"] == {"counted": 2, "reposts": 8, "replies": 2}
    table = check.tables[0]
    assert (table["key"], table["matched"], table["read"], table["newest"]) == ("sonar", 2, 2, at.isoformat())
    again = tempcheck.run(ctx, tempcheck.TempCheckRequest(issue="Alleged Gmail Outage", boolean="gmail AND outage", own_sources=["sonar"], reuse=check.check_id,
                                                          requested_by="im1@ops.test"))
    assert again.own["reused"]["kept"] == 2 and again.own["complete"] is True and again.own["spread"]["counted"] == 2, "kept posts carry their counters"


# -- the other readers of these tables: Early Detection, watches, and the momentum re-read -----------------------------------------
def one_line(sql: str) -> str:
    return re.sub(r"\s+", " ", sql)


def test_early_detection_reads_a_table_through_its_own_read(ctx):
    from triage_agent import early

    cfg = ctx.config.platform
    cfg.temp_check.sources = tempcheck.app_setup()["tables"]
    cfg.early.sources = ["sonar", "alerts"]
    cfg.bigquery.location, cfg.bigquery.dataset = "us-central1", "proj.slrr"
    ctx.bq = Tables({})
    ctx.bq._settings_key = ("", "us-central1", 0)  # the stand-in is the gateway for these BigQuery settings
    sonar = tables()["sonar"]
    sql = one_line(early.ingest_sql(sonar, cfg.early))
    assert "JSON_VALUE(payload, '$.detail.post.snippet.text') AS text" in sql and f"FROM `{SONAR}`" in sql, "the table is read the way the temp check reads it"
    assert "WHERE seen >= @since AND seen < @until AND posted >= @posted_since" in sql, "new rows are the ones that arrived since the last read"
    assert "LOWER(IFNULL(language, 'en')) LIKE 'en%'" in sql and "TO_HEX(MD5(one)) AS post_id" in sql
    assert "LOWER(IFNULL(language" not in one_line(early.ingest_sql(tables()["alerts"], cfg.early)), "a table with no language is not asked for one"
    reads = {s["source"]: s for s in early.plan(ctx, NOW) if s["kind"].startswith("ingest")}
    assert set(reads) == {"sonar", "alerts"} and reads["sonar"]["location"] == "us-central1" and reads["alerts"]["location"] == "US"
    for step in reads.values():
        assert step["params"]["t_from"] == step["params"]["since"] and step["params"]["t_to"] == step["params"]["until"] == NOW


def test_a_watch_reads_a_table_through_its_own_read(ctx):
    from triage_agent import watches

    cfg = ctx.config.platform.campaigns
    watch = watches.Watch(watch_id="W-1", name="Outage talk", question="Is this about a Gmail outage?", enabled=True, created_by="lead@ops.test")
    sql, params = watches.look_sql(tables()["sprinklr"], [watch], cfg)
    flat = one_line(sql)
    assert "comment_text AS text" in flat and f"FROM `{SPRINKLR}`" in flat and "IFNULL(is_brand_post, '') != 'Brand'" in flat
    assert "WHERE seen >= @since AND seen < @until" in flat and "PARTITION BY one ORDER BY seen DESC" in flat
    assert params["w0_cond"] == "Is this about a Gmail outage?"


def test_a_post_is_read_again_through_a_tables_own_read(ctx, clock):
    cfg = ctx.config.platform.temp_check
    cfg.sources = [tables()["sonar"], tables()["brandwatch"]]

    class Again(Tables):
        def query(self, sql, params=None, **kw):
            self.asked.append((sql, dict(params or {}), kw))
            return [{"post_eng": 900.0 if SONAR in sql else 400.0}]

    ctx.bq = gw = Again({})
    since = clock.now - timedelta(hours=6)
    assert tempcheck.post_engagement(ctx, "https://x.com/someone/status/1845123456789012345", since) == 900.0, "the largest value across the tables"
    assert len(gw.asked) == 2
    sql, params, kw = gw.asked[0]
    assert "MAX(eng) AS post_eng" in sql and f"`{SONAR}`" in sql and "REGEXP_CONTAINS(LOWER(url), @pat)" in sql and kw["location"] == "us-central1"
    assert params["t_from"] == since and params["t_to"] == clock.now and "1845123456789012345" in params["pat"]
