"""Own alerts: each source hands over what is new, personal details are taken out, and the posts are staged.

BigQuery, Cloud DLP, the KOF sheet, Brandwatch and Chat are replaced by stand-ins (tests/own_helpers.py; no network).
The statements, their parameters, the cursors, the hashing, the KOF match and what is written are the real code.
"""

from __future__ import annotations

import hashlib
from datetime import datetime, timedelta, timezone
from typing import Any

import pytest

from own_helpers import COMMENTS, HOME, SONAR, row, set_up
from triage_agent import chatapi, tempcheck, xposts
from triage_agent.ownalerts import ingest, scrub, sources


@pytest.fixture
def world(ctx, monkeypatch):
    return set_up(ctx, monkeypatch)


def run(ctx) -> dict[str, Any]:
    state: dict[str, Any] = ctx.store.get_kv("test:own") or {"cursors": {}, "sources": {}}
    out = ingest.run(ctx, state, ctx.now())
    ctx.store.put_kv("test:own", state)
    return {**out, "state": state}


def sha(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


# -- which sources, and how each table is read ---------------------------------------------------------------------------
def test_every_source_named_in_settings_is_listed_with_where_it_reads(ctx, world):
    own = ctx.config.platform.own_alerts
    own.brandwatch_queries, own.other_alerts_space = ["2004167929"], "https://chat.google.com/room/AAAAother1234"
    ctx.config.platform.temp_check.brandwatch_project_id = "1998344909"
    listed = [(s.key, s.kind, s.system, s.where) for s in sources.listing(ctx)]
    assert listed == [
        ("comments", "table", "comments", f"{COMMENTS} (US)"),
        ("sonar", "table", "sonar", f"{SONAR} (us-central1)"),
        ("brandwatch_api:2004167929", "brandwatch", "brandwatch_api", "Brandwatch's API: project 1998344909, query 2004167929"),
        ("other_alerts", "chat", "other_alerts", "Google Chat: spaces/AAAAother1234"),
    ]


def test_a_key_that_is_not_a_table_of_posts_is_left_out(ctx, world):
    ctx.config.platform.own_alerts.sources = ["comments", "no_such_table"]
    assert [s.key for s in sources.listing(ctx)] == ["comments"]


def test_a_table_is_read_by_its_own_read_after_where_the_last_read_stopped(ctx, world):
    own = ctx.config.platform.own_alerts
    comments, sonar = ctx.config.platform.temp_check.sources
    sql = sources.table_sql(comments, own)
    assert f"FROM `{COMMENTS}` WHERE seen >= @t_from AND seen < @t_to" in sql, "the table's own read is inside"
    assert "WHERE (seen > @since OR (seen = @since AND CAST(one AS STRING) > @after)) AND seen < @until" in sql
    assert "AND one IS NOT NULL AND TRIM(IFNULL(text, '')) != ''" in sql and "(posted IS NULL OR posted >= @posted_since)" in sql
    assert sql.rstrip().endswith("ORDER BY seen, one\nLIMIT @cap")
    assert "language" not in sql.split("FROM (")[1].split(")\nWHERE")[1], "this table gives no language, so none is asked for"
    assert "AND LOWER(IFNULL(language, 'en')) LIKE 'en%'" in sources.table_sql(sonar, own)
    own.english_only = False
    assert "LIKE 'en%'" not in sources.table_sql(sonar, own)


def test_each_table_is_read_in_its_own_location_from_fifteen_minutes_back_the_first_time(ctx, world):
    gw, _ = world
    run(ctx)
    now = ctx.now()
    (c,), (s,) = gw.reads_of(COMMENTS), gw.reads_of(SONAR)
    assert c["location"] == "US" and s["location"] == "us-central1"
    for read in (c, s):
        p = read["params"]
        assert p["since"] == now - timedelta(minutes=15) and p["until"] == now and p["after"] == "" and p["cap"] == 500
        assert p["t_from"] == p["since"] and p["t_to"] == now and p["posted_since"] == now - timedelta(hours=72)


# -- what is staged ------------------------------------------------------------------------------------------------------
def test_a_post_is_staged_without_its_author_its_link_or_a_name(ctx, world):
    gw, dlp = world
    gw.source_rows[SONAR] = [row(1, "Dana Whitfield (@dana_w) says Pixel is down, see https://x.com/dana_w/status/5", author="@Dana_W",
                                 url="https://x.com/dana_w/status/5", followers=4200, eng=310, shares=20, replies=45)]
    out = run(ctx)
    (staged,) = gw.rows_in("posts_staging")
    assert staged == {
        "ingested_at": ctx.now().isoformat(), "post_id": sha("post:x:5"), "source_system": "sonar", "published_at": "2026-11-21T10:00:00+00:00",
        "platform": "x", "author_hash": sha("pepper:dana_w"), "author_followers": 4200, "is_kof": False, "kof_tier": "NON_KOF",
        "sanitized_snippet": "[PERSON_NAME] ([HANDLE]) says Pixel is down, see [URL]", "views": None, "likes": None, "comments": 45, "shares": 20,
        "engagement_total": 310,
    }
    assert "dana" not in str(staged).lower() and "https://" not in str(staged)
    assert dlp.seen == ["Dana Whitfield ([HANDLE]) says Pixel is down, see [URL]"]
    assert out["staged"] == 1 and out["state"]["sources"]["sonar"]["status"] == "live" and out["state"]["sources"]["sonar"]["kept"] == 1


def test_the_vault_gets_the_link_and_a_kof_gets_their_name_and_list(ctx, world):
    gw, _ = world
    gw.source_rows[SONAR] = [row(1, author="@JDoe", url="https://x.com/jdoe/status/9"), row(2, author="someone_else")]
    run(ctx)
    kof_post, other = gw.rows_in("posts_staging")
    assert (kof_post["is_kof"], kof_post["kof_tier"]) == (True, "SLRR Global INFs") and (other["is_kof"], other["kof_tier"]) == (False, "NON_KOF")
    assert gw.rows_in("author_vault_30d") == [
        {"post_id": kof_post["post_id"], "ingested_at": ctx.now().isoformat(), "is_kof": True, "kof_display_label": "Jane Doe (@jdoe)",
         "post_url": "https://x.com/jdoe/status/9"},
        {"post_id": other["post_id"], "ingested_at": ctx.now().isoformat(), "is_kof": False, "kof_display_label": None,
         "post_url": "https://x.com/acct2/status/1002"},
    ]
    tables = [table for table, _ in gw.inserted]
    assert tables.index(f"{HOME}.author_vault_30d") < tables.index(f"{HOME}.posts_staging"), "a staged post always has its link in the vault"


def test_the_same_author_always_gets_the_same_hash_and_no_author_is_anon(ctx, world):
    gw, _ = world
    gw.source_rows[SONAR] = [row(1, author="@Same_One"), row(2, author="same_one"), row(3, author="")]
    gw.source_rows[SONAR][2]["author"] = None
    run(ctx)
    a, b, c = gw.rows_in("posts_staging")
    assert a["author_hash"] == b["author_hash"] == sha("pepper:same_one") and c["author_hash"] == sha("pepper:anon")


def test_a_post_already_kept_is_not_cleaned_or_staged_again(ctx, world):
    gw, dlp = world
    gw.source_rows[SONAR] = [row(1), row(2)]
    gw.held = {sha("post:x:1001")}
    out = run(ctx)
    assert [r["post_id"] for r in gw.rows_in("posts_staging")] == [sha("post:x:1002")] and len(dlp.seen) == 1
    check = next(r for r in gw.ran if r["sql"].startswith("SELECT post_id FROM"))
    assert f"`{HOME}.posts`" in check["sql"] and f"`{HOME}.posts_staging`" in check["sql"] and check["location"] == "US"
    assert out["state"]["sources"]["sonar"]["read"] == 2 and out["state"]["sources"]["sonar"]["kept"] == 1


def test_one_post_seen_through_two_tables_is_staged_once(ctx, world):
    gw, _ = world
    ctx.config.platform.temp_check.sources[0].dedupe_by = "url"
    same = "https://www.reddit.com/r/chrome/comments/abc/logged_out/"
    gw.source_rows[COMMENTS] = [row(1, url=same, platform="reddit")]
    gw.source_rows[SONAR] = [row(2, url="https://reddit.com/r/chrome/comments/abc/logged_out?utm=1", platform="reddit")]
    run(ctx)
    staged = gw.rows_in("posts_staging")
    assert [(s["post_id"], s["source_system"]) for s in staged] == [(sha("post:reddit.com/r/chrome/comments/abc/logged_out"), "comments")]


def test_a_table_whose_rows_share_a_link_keeps_each_row_apart(ctx, world):
    gw, _ = world
    under = "https://www.instagram.com/p/POST1/"
    gw.source_rows[COMMENTS] = [row(1, url=under, one="comment-1", platform="instagram"), row(2, url=under, one="comment-2", platform="instagram")]
    run(ctx)
    assert [s["post_id"] for s in gw.rows_in("posts_staging")] == [sha("post:comments:comment-1"), sha("post:comments:comment-2")]


def test_a_post_with_nothing_left_after_cleaning_is_dropped(ctx, world):
    gw, _ = world
    gw.source_rows[SONAR] = [row(1, "https://example.test/only-a-link @someone"), row(2), row(3, "   ")]
    out = run(ctx)
    assert [s["post_id"] for s in gw.rows_in("posts_staging")] == [sha("post:x:1002")] and out["staged"] == 1
    assert len(gw.rows_in("author_vault_30d")) == 1, "nothing goes to the vault for a post that is not kept"


# -- when something fails ------------------------------------------------------------------------------------------------
def test_when_dlp_cannot_be_reached_nothing_from_that_read_is_kept_and_it_is_read_again(ctx, world):
    gw, dlp = world
    gw.source_rows[SONAR] = [row(1)]
    dlp.down = "Sensitive Data Protection could not be reached: no route"
    out = run(ctx)
    assert gw.inserted == [] and out["staged"] == 0
    entry = out["state"]["sources"]["sonar"]
    assert entry["status"] == "failing" and "could not be reached" in entry["error"] and "sonar" not in out["state"]["cursors"]
    dlp.down = ""
    assert run(ctx)["staged"] == 1, "the same posts are read again once DLP answers"


def test_a_table_that_cannot_be_read_is_noted_and_the_others_carry_on(ctx, world):
    gw, _ = world
    gw.fail = f"`{COMMENTS}`"
    gw.source_rows[SONAR] = [row(1)]
    out = run(ctx)
    assert out["staged"] == 1 and out["state"]["sources"]["comments"]["status"] == "failing"
    assert "403 Access Denied" in out["state"]["sources"]["comments"]["error"] and "comments" not in out["state"]["cursors"]
    assert out["failing"] == ["comments"]


def test_a_read_whose_posts_could_not_be_written_is_read_again(ctx, world):
    gw, _ = world
    gw.source_rows[SONAR] = [row(1)]
    gw.fail_insert = "posts_staging"
    out = run(ctx)
    assert out["state"]["sources"]["sonar"]["status"] == "failing" and "sonar" not in out["state"]["cursors"]


def test_nothing_is_read_until_the_salt_secret_is_set(ctx, world):
    gw, _ = world
    ctx.config.platform.own_alerts.hash_salt_secret = ""
    with pytest.raises(ingest.NotReady, match="salt"):
        run(ctx)
    assert gw.ran == []


# -- where the next read starts ------------------------------------------------------------------------------------------
def test_a_full_read_carries_on_after_its_last_row_and_a_short_one_starts_from_now(ctx, clock, world):
    gw, _ = world
    own = ctx.config.platform.own_alerts
    own.posts_per_read, own.lag_minutes = 2, 2
    gw.source_rows[SONAR] = [row(1, seen="2026-11-21T11:01:00+00:00", one="a"), row(2, seen="2026-11-21T11:01:00+00:00", one="b"),
                             row(3, seen="2026-11-21T11:02:00+00:00", one="c")]
    first = run(ctx)
    assert first["state"]["cursors"]["sonar"] == {"at": "2026-11-21T11:01:00+00:00", "after": "b", "more": True, "same": True}
    assert first["state"]["sources"]["sonar"]["more"] is True
    gw.source_rows[SONAR] = gw.source_rows[SONAR][2:]
    clock.advance(minutes=2)
    second = run(ctx)
    p = gw.reads_of(SONAR)[-1]["params"]
    assert p["since"] == datetime(2026, 11, 21, 11, 1, tzinfo=timezone.utc) and p["after"] == "b", "no step back while a backlog is being worked through"
    assert second["state"]["cursors"]["sonar"] == {"at": ctx.now().isoformat(), "after": "", "more": False, "same": False}
    clock.advance(minutes=2)
    run(ctx)
    p = gw.reads_of(SONAR)[-1]["params"]
    assert p["since"] == ctx.now() - timedelta(minutes=4) and p["after"] == "", "a finished read is followed by one that goes two minutes back again"


def test_after_a_long_pause_a_read_goes_back_six_hours_at_most(ctx, clock, world):
    gw, _ = world
    run(ctx)
    clock.advance(hours=30)
    run(ctx)
    assert gw.reads_of(SONAR)[-1]["params"]["since"] == ctx.now() - timedelta(minutes=360)


# -- Brandwatch's API ----------------------------------------------------------------------------------------------------
class Brandwatch:
    def __init__(self, ctx):
        self.project = "1998344909"
        self.paths: list[str] = []
        Brandwatch.last = self

    def get(self, path: str) -> dict[str, Any]:
        self.paths.append(path)
        return {"results": [
            {"guid": "111", "resourceId": "r1", "pageType": "reddit", "url": "https://www.reddit.com/r/google/comments/xyz/outage/", "author": "u_reporter",
             "title": "Outage", "snippet": "Search is down for Dana Whitfield", "date": "2026-11-21T09:00:00.000+0000", "added": "2026-11-21T11:30:00.000+0000",
             "likes": 40, "comments": 12, "shares": 3, "potentialAudience": 900, "language": "en"},
            {"guid": "1790000000000000001", "resourceId": "r2", "pageType": "twitter", "author": "", "date": "2026-11-21T09:05:00.000+0000",
             "added": "2026-11-21T11:31:00.000+0000", "twitterFollowers": 52000},
            {"guid": "1790000000000000002", "resourceId": "r3", "pageType": "twitter", "date": "2026-11-21T09:06:00.000+0000",
             "added": "2026-11-21T11:32:00.000+0000"},
        ]}


@pytest.fixture
def brandwatch(ctx, world, monkeypatch):
    own = ctx.config.platform.own_alerts
    own.sources, own.brandwatch_queries = [], ["2004167929"]
    monkeypatch.setattr(tempcheck, "Brandwatch", Brandwatch)
    monkeypatch.setattr(xposts, "lookup", lambda ids: {"1790000000000000001": {"author": "big_voice", "text": "Gemini gave me a wrong answer again",
                                                                               "url": "https://x.com/big_voice/status/1790000000000000001", "likes": 800, "replies": 90}})
    return world


def test_a_brandwatch_query_is_asked_for_what_was_added_since_the_last_read(ctx, brandwatch):
    run(ctx)
    now = ctx.now()
    (path,) = Brandwatch.last.paths
    since, start = (now - timedelta(minutes=15)), (now - timedelta(hours=72))
    stamp = lambda d: d.strftime("%Y-%m-%dT%H%%3A%M%%3A%S.000Z")  # noqa: E731
    assert path == (f"/projects/1998344909/data/mentions?queryId=2004167929&startDate={stamp(start)}&endDate={stamp(now)}&sinceAdded={stamp(since)}"
                    "&orderBy=added&orderDirection=asc&pageSize=500&page=0&xthreadEntryType=share&language=en")


def test_brandwatch_mentions_are_staged_and_an_x_post_gets_its_words_from_x(ctx, brandwatch):
    gw, dlp = brandwatch
    out = run(ctx)
    reddit, x_post = gw.rows_in("posts_staging")
    assert reddit["source_system"] == x_post["source_system"] == "brandwatch_api"
    assert (reddit["platform"], reddit["sanitized_snippet"], reddit["engagement_total"], reddit["author_followers"]) == (
        "reddit", "Outage: Search is down for [PERSON_NAME]", 55, None), "on Reddit, Brandwatch's audience figure is not the author's followers"
    assert (x_post["platform"], x_post["sanitized_snippet"], x_post["engagement_total"], x_post["author_followers"]) == (
        "x", "Gemini gave me a wrong answer again", 890, 52000)
    assert x_post["post_id"] == sha("post:x:1790000000000000001") and x_post["author_hash"] == sha("pepper:big_voice")
    entry = out["state"]["sources"]["brandwatch_api:2004167929"]
    assert (entry["read"], entry["kept"], entry["skipped"]) == (3, 2, 1), "an X post X will not show has no words and is not kept"
    assert [v["post_url"] for v in gw.rows_in("author_vault_30d")] == ["https://www.reddit.com/r/google/comments/xyz/outage/",
                                                                       "https://x.com/big_voice/status/1790000000000000001"]


def test_a_full_brandwatch_page_added_in_one_instant_does_not_stall_the_next_read(ctx, clock, brandwatch):
    ctx.config.platform.own_alerts.posts_per_read = 3
    state = {"cursors": {"brandwatch_api:2004167929": {"at": "2026-11-21T11:32:00.250000+00:00", "after": "x", "more": True, "same": True}}, "sources": {}}
    ingest.run(ctx, state, ctx.now())
    assert "&sinceAdded=2026-11-21T11%3A32%3A00.251Z&" in Brandwatch.last.paths[0], "one millisecond past the instant the last page ended on"
    state = {"cursors": {"brandwatch_api:2004167929": {"at": "2026-11-21T11:32:00.250000+00:00", "after": "x", "more": True, "same": False}}, "sources": {}}
    ingest.run(ctx, state, ctx.now())
    assert "&sinceAdded=2026-11-21T11%3A32%3A00.250Z&" in Brandwatch.last.paths[0], "otherwise from the last mention handed over, which is not kept twice"
    assert state["cursors"]["brandwatch_api:2004167929"] == {"at": "2026-11-21T11:32:00+00:00", "after": "x:1790000000000000002", "more": True, "same": False}


def test_brandwatch_not_set_up_is_said_on_its_source(ctx, world, monkeypatch):
    own = ctx.config.platform.own_alerts
    own.sources, own.brandwatch_queries = [], ["2004167929"]
    out = run(ctx)
    entry = out["state"]["sources"]["brandwatch_api:2004167929"]
    assert entry["status"] == "failing" and "Brandwatch isn't set up" in entry["error"]


# -- the Other alerts space ----------------------------------------------------------------------------------------------
class Chat:
    def __init__(self, messages: list[dict[str, Any]]):
        self.messages, self.asked = messages, []

    def list_messages(self, space: str, since: datetime) -> list[dict[str, Any]]:
        self.asked.append((space, since))
        return [m for m in self.messages if m["create_time"] > since]


def message(n: int, text: str, minute: int, **over: Any) -> dict[str, Any]:
    return {"name": f"spaces/AAAAother1234/messages/m{n}", "text": text, "card_text": "", "create_time": datetime(2026, 11, 21, 11, minute, tzinfo=timezone.utc),
            "sender": "users/app1", "sender_type": "BOT", "thread": f"spaces/AAAAother1234/threads/t{n}", "reply": False, "client_id": "", **over}


@pytest.fixture
def other_alerts(ctx, clock, world, monkeypatch):
    own = ctx.config.platform.own_alerts
    own.sources, own.other_alerts_space = [], "spaces/AAAAother1234"
    clock.now = datetime(2026, 11, 21, 11, 30, tzinfo=timezone.utc)
    chat = Chat([
        message(1, "HIGH alert: Dana Whitfield posted about a Pixel recall https://x.com/dana_w/status/77 (@dana_w, 40K followers)", 20),
        message(2, "", 21, card_text="KOF alert: Chrome extension store flooded with fakes <https://example.test/story|Open>"),
        message(3, "thanks, looking", 22, reply=True, sender_type="HUMAN"),
        message(4, "a note the bot posted itself", 23, client_id="client-bqa-abc"),
        message(5, "", 24),
    ])
    monkeypatch.setattr(chatapi, "client_for", lambda c: chat)
    return world, chat


def test_alerts_other_tools_post_are_read_and_staged_without_personal_details(ctx, other_alerts):
    (gw, _), chat = other_alerts
    out = run(ctx)
    assert chat.asked == [("spaces/AAAAother1234", ctx.now() - timedelta(minutes=15))]
    first, second = gw.rows_in("posts_staging")
    assert first["source_system"] == second["source_system"] == "other_alerts" and first["platform"] == "google_chat"
    assert first["post_id"] == sha("post:other_alerts:spaces/AAAAother1234/messages/m1") and first["author_hash"] == sha("pepper:anon")
    assert first["sanitized_snippet"] == "HIGH alert: [PERSON_NAME] posted about a Pixel recall [URL] ([HANDLE], 40K followers)"
    assert second["sanitized_snippet"].startswith("KOF alert: Chrome extension store flooded with fakes")
    assert [v["post_url"] for v in gw.rows_in("author_vault_30d")] == ["https://x.com/dana_w/status/77", "https://example.test/story"]
    entry = out["state"]["sources"]["other_alerts"]
    assert (entry["read"], entry["kept"]) == (2, 2), "a reply, the bot's own post and an empty message are not alerts"


def test_the_other_alerts_space_says_when_the_chatbot_is_not_signed_in(ctx, world, monkeypatch):
    own = ctx.config.platform.own_alerts
    own.sources, own.other_alerts_space = [], "spaces/AAAAother1234"

    def nobody(c):
        raise chatapi.NotSignedIn("The QA chatbot is not signed in to Chat.")

    monkeypatch.setattr(chatapi, "client_for", nobody)
    entry = run(ctx)["state"]["sources"]["other_alerts"]
    assert entry["status"] == "failing" and entry["error"] == "The QA chatbot is not signed in to Chat."


def test_the_patterns_the_job_and_bigquery_use_are_the_same_list():
    assert [name for name, _, _ in scrub.PATTERNS] == ["EMAIL", "URL", "HANDLE", "PHONE"]
