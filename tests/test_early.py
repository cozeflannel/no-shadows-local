"""Early Detection: BigQuery reads the post tables, embeds each post with Vertex AI and groups like posts into stories.

BigQuery is replaced by a stand-in that records every statement and hands back the rows a test queues (no network);
Gemini Decisions' HTTP call is replaced the same way. The statements, their parameters, the scoring rules, the
write-up and the Console routes are the real code.
"""

from __future__ import annotations

import json
from datetime import timedelta
from typing import Any

import pytest

from test_console_api import ADMIN, IM, VIEWER, api, console_ctx, seeded  # noqa: F401 - fixtures
from test_platform import flags
from triage_agent import bq_admin, decisions, early
from triage_agent.config import TempCheckSource
from triage_agent.platform_jobs import run_job

HOME = "proj.slrr"
T = {name: f"{HOME}.agent_{name}" for name in early.TABLES}


class BigQuery:
    """Records each statement with its parameters and location; SELECTs answer with the rows queued for them."""

    project = "proj"

    def __init__(self):
        self.ran: list[dict[str, Any]] = []
        self.dry: list[dict[str, Any]] = []
        self.inserted: list[tuple[str, list[dict[str, Any]]]] = []
        self.created: list[str] = []
        self.raised: list[dict[str, Any]] = []      # what the "read raised stories" statement returns
        self.remote_posts: list[dict[str, Any]] = []  # what a table in another location hands over
        self.fail: str = ""

    def query(self, sql: str, params: dict[str, Any] | None = None, *, location: str | None = None, max_rows: int = 10000, labels=None):
        self.ran.append({"sql": sql, "params": dict(params or {}), "location": location})
        if self.fail and self.fail in sql:
            raise RuntimeError("403 Access Denied: the table can't be read")
        if sql.startswith("SELECT g.signal_id"):
            rows, self.raised = self.raised, []
            return rows
        if sql.startswith("WITH new_posts"):
            return self.remote_posts
        if sql.startswith("SELECT ARRAY_LENGTH(AI.EMBED("):
            return [{"n": 768}]
        return []

    def dry_run(self, sql: str, params: dict[str, Any] | None = None, *, location: str | None = None) -> int:
        self.dry.append({"sql": sql, "params": dict(params or {}), "location": location})
        if self.fail and self.fail in sql:
            raise RuntimeError("400 Unrecognized name: first_seen at [3:120]")
        return 1048576

    def insert_rows(self, table: str, rows: list[dict[str, Any]]) -> None:
        self.inserted.append((table, rows))

    def get_dataset(self, dataset: str):
        return {"dataset": dataset}

    def get_table(self, table: str):
        if table not in self.created:
            raise RuntimeError("404 Not found")
        return {"full_id": table}

    def create_table(self, table: str, fields, **kw: Any):
        self.created.append(table)
        return {"full_id": table}

    def kinds(self) -> list[str]:
        return [r["sql"].split("\n")[0][:40] for r in self.ran]


def post(n: int, text: str, platform: str = "x") -> dict[str, Any]:
    return {"url": f"https://x.example/p/{n}", "platform": platform, "author": f"acct{n}", "text": text, "posted": "2026-11-21T10:00:00+00:00",
            "followers": 120, "engagement": 4.0}


def raised(n: int, kind: str = "story", accounts: int = 6, **over: Any) -> dict[str, Any]:
    return {"signal_id": f"sig-{n}", "story_id": f"story-{n}", "kind": kind, "raised": "2026-11-21T12:00:00+00:00", "accounts": accounts,
            "posts": accounts + 1, "platforms": "reddit,x", "first_posted": "2026-11-21T10:00:00+00:00", "last_posted": "2026-11-21T11:50:00+00:00",
            "items": [post(i, f"Chrome keeps logging me out after today's update, attempt {i}") for i in range(1, 4)], **over}


@pytest.fixture
def bq(api, monkeypatch) -> BigQuery:
    gw = BigQuery()
    cfg = api.ctx.config.platform
    cfg.bigquery.dataset, cfg.bigquery.location = HOME, "US"
    cfg.temp_check.sources = [
        TempCheckSource(key="comments", table="proj.reporting.comments", location="US", text_columns=["message"], url_column="permalink",
                        time_column="created_time", author_column="author_name", platform_value="Facebook", language_column="lang"),
        TempCheckSource(key="sonar", table="other.google_bg.sonar_raw", location="us-central1", text_columns=["title", "body"], url_column="url",
                        time_column="first_seen", author_column="author", platform_column="network", followers_column="followers",
                        engagement_expr="likes + shares", filter_sql="is_own = FALSE"),
    ]
    cfg.early.sources = ["comments", "sonar"]
    cfg.flags.bigquery_admin = True
    monkeypatch.setattr(bq_admin, "get_gateway", lambda ctx: gw)
    return gw


@pytest.fixture
def dec(api, monkeypatch):
    """Gemini Decisions answering with the scores a test sets."""
    api.ctx.config.platform.decisions.secret = "decisions-key"
    scores = {"about": 0.95, "risk": 0.9, "independent": 0.7, "noise": 0.1, "category": early.OTHER_RISK, "severity": 3}
    calls: list[dict[str, Any]] = []

    def answer(url, key, body, timeout):
        calls.append(body)
        levels = {str(i): (0.8 if i == scores["severity"] else 0.05) for i in range(5)}
        return 200, json.dumps({"answers": {
            **{k: {"type": "noul", "noul": scores[k], "confidence": 0.9} for k in ("about", "risk", "independent", "noise")},
            "category": {"type": "choice", "choice": scores["category"], "probabilities": {scores["category"]: 0.8}},
            "severity": {"type": "score", "score": float(scores["severity"]), "probabilities": levels}}})

    monkeypatch.setattr(decisions, "_post", answer)
    monkeypatch.setattr(decisions, "_key", lambda c: "k")
    return type("Dec", (), {"scores": scores, "calls": calls})


def write_up(api, call: str = "escalate", confidence: float = 0.9, **over: Any) -> None:
    api.ctx.llm.on(early.PURPOSE, {"headline": "Chrome update logs people out", "call": call, "severity": "high", "confidence": confidence,
                                   "story": "Several accounts say Chrome signs them out since today's update.", "why": "Independent first-hand reports.",
                                   "exposure_tag": "", "next_steps": ["Size it with a temp check"], "temp_check_query": "chrome logged out update", **over})


def test_off_reads_nothing(api, bq):
    assert early.check(api.ctx) == {"ok": True, "off": True} and bq.ran == []
    assert api.get("/api/early", user=IM).json()["state"]["on"] is False


def test_a_read_embeds_new_posts_in_bigquery_and_groups_them_there(api, bq):
    flags(api.ctx, early_detection=True)
    result = early.check(api.ctx)
    assert result["ok"] and result["due"], result
    assert sorted(bq.created) == sorted(T.values()), "the tables are created on the first read"
    home, remote = bq.ran[0], bq.ran[1]
    assert home["location"] == "US" and home["sql"].startswith(f"INSERT INTO `{T['early_posts']}`"), "same location: written in one job"
    assert "AI.EMBED(f.txt, endpoint => 'text-embedding-005', task_type => 'SEMANTIC_SIMILARITY')" in home["sql"]
    assert "'facebook'" in home["sql"] and "LIKE 'en%'" in home["sql"] and "h.post_id IS NULL" in home["sql"]
    assert home["params"]["max_followers"] == 5000 and home["params"]["min_chars"] == 40 and home["params"]["skip_authors"] == ["grok", "automoderator", "[deleted]"]
    assert remote["location"] == "us-central1" and remote["sql"].startswith("WITH new_posts") and "(is_own = FALSE)" in remote["sql"]
    assert "SAFE_CAST((likes + shares) AS FLOAT64)" in remote["sql"] and "INSERT" not in remote["sql"]
    join, start, lift, read = bq.ran[2:6]
    assert "ML.DISTANCE(pool.embedding, c.centre, 'COSINE')" in join["sql"] and join["params"]["join_sim"] == 0.82
    assert start["params"]["start_sim"] == 0.80 and start["params"]["top_k"] == 20 and "COUNT(DISTINCT IFNULL(author, post_id)) >= 2" in start["sql"]
    assert (lift["params"]["min_accounts"], lift["params"]["min_accounts_multi"], lift["params"]["min_links"], lift["params"]["early"]) == (5, 4, 2, False)
    assert read["sql"].startswith("SELECT g.signal_id") and {r["location"] for r in bq.ran[2:6]} == {"US"}
    assert early.check(api.ctx)["due"] is False, "not again within the interval"


def test_posts_from_another_location_are_written_to_the_agents_table_once(api, bq):
    flags(api.ctx, early_detection=True)
    bq.remote_posts = [{"post_id": "a1", "source": "sonar", "platform": "x", "author": "acct", "text": "t", "url": "https://x.example/1",
                        "posted": "2026-11-21T10:00:00+00:00", "seen": "x", "followers": 5, "engagement": 1.0, "embedding": [0.1, 0.2]}]
    early.check(api.ctx)
    table, rows = bq.inserted[0]
    assert table == T["early_posts"] and rows[0]["post_id"] == "a1" and rows[0]["embedding"] == [0.1, 0.2]
    state = api.get("/api/early").json()["state"]
    assert {s["key"]: s["how"] for s in state["sources"]} == {"comments": "written in BigQuery", "sonar": "read there, written here"}


def test_a_table_that_cannot_be_read_is_named_and_the_others_carry_on(api, bq):
    flags(api.ctx, early_detection=True)
    bq.fail = "other.google_bg.sonar_raw"
    result = early.check(api.ctx)
    assert result["ok"] is False and result["error"] == "Could not read: sonar"
    state = api.get("/api/early").json()["state"]
    failing = next(s for s in state["sources"] if s["key"] == "sonar")
    assert failing["status"] == "failing" and "Access Denied" in failing["error"] and len(bq.ran) == 6, "the grouping still ran"


def test_a_raised_story_is_written_up_by_gemini_and_people_act_on_it(api, bq):
    flags(api.ctx, early_detection=True)
    bq.raised = [raised(1)]
    assert early.check(api.ctx)["raised"] == 1
    waiting = api.get("/api/early").json()["signals"][0]
    assert waiting["status"] == "queued" and waiting["review"] is None and waiting["accounts"] == 6 and waiting["platforms"] == ["reddit", "x"]
    write_up(api)
    assert run_job(api.ctx, "maintenance")["jobs"]["early"]["written"] == 1
    story = api.get("/api/early", user=IM).json()["signals"][0]
    assert story["status"] == "new" and story["review"]["headline"] == "Chrome update logs people out" and story["review"]["call"] == "escalate"
    prompt = next(c for c in api.ctx.llm.calls if c["purpose"] == early.PURPOSE)["prompt"]
    assert "P1 [x, 2026-11-21T10:00]" in prompt and "logging me out" in prompt and "acct1" not in prompt, "posts go in; account names do not"

    assert api.post(f"/api/early/{story['id']}/action", {"action": "escalate"}, user=VIEWER).status_code == 403
    done = api.post(f"/api/early/{story['id']}/action", {"action": "escalate", "note": "Raising with comms"}, user=IM).json()
    assert (done["status"], done["by"], done["note"]) == ("escalated", IM, "Raising with comms")
    entry = api.get("/api/audit", action="early.").json()["entries"][0]
    assert entry["action"] == "early.escalate" and entry["actor"] == IM


def test_gemini_is_not_sure_enough_to_escalate_so_the_call_is_monitor_and_a_dismissal_is_not_shown_as_new(api, bq):
    flags(api.ctx, early_detection=True)
    bq.raised = [raised(1), raised(2)]
    early.check(api.ctx)
    replies = iter([("escalate", 0.6), ("dismiss", 0.9)])

    def respond(call: dict[str, Any]) -> dict[str, Any]:
        verdict, confidence = next(replies)
        return {"headline": "A headline", "call": verdict, "severity": "medium", "confidence": confidence, "story": "s", "why": "w"}

    api.ctx.llm.on(early.PURPOSE, respond)
    early.drain(api.ctx)
    by_id = {s["id"]: s for s in api.get("/api/early").json()["signals"]}
    assert by_id["sig-1"]["review"]["call"] == "monitor" and by_id["sig-1"]["status"] == "new"
    assert by_id["sig-2"]["status"] == "dismissed"


def test_gemini_decisions_holds_back_noise_and_writes_up_the_most_severe_first(api, bq, dec):
    flags(api.ctx, early_detection=True, early_fast_triage=True)
    dec.scores.update(about=0.05, risk=0.1, noise=0.95, severity=0, category=early.NO_CATEGORY)
    bq.raised = [raised(1)]
    result = early.check(api.ctx)
    assert (result["raised"], result["held"]) == (0, 1)
    held = api.get("/api/early", status="held").json()["signals"][0]
    assert held["held_why"] == "not about the company" and held["decisions"]["noise"] == 0.95
    sent = json.loads(dec.calls[0]["input"])
    assert sent["accounts"] == 6 and sent["snippets"][0]["text"].startswith("Chrome keeps logging me out") and "author" not in json.dumps(sent)
    assert list(dec.calls[0]["questions"]) == ["about", "risk", "independent", "noise", "category", "severity"]

    api.ctx.now = lambda at=api.ctx.now() + timedelta(minutes=20): at
    dec.scores.update(about=0.95, risk=0.9, noise=0.1, severity=2, category=early.OTHER_RISK)
    bq.raised = [raised(3)]
    early.check(api.ctx)
    api.ctx.now = lambda at=api.ctx.now() + timedelta(minutes=20): at
    dec.scores.update(severity=4)
    bq.raised = [raised(4)]
    early.check(api.ctx)
    api.ctx.config.platform.early.reviews_per_minute = 1
    write_up(api)
    early.drain(api.ctx)
    by_id = {s["id"]: s for s in api.get("/api/early").json()["signals"]}
    assert by_id["sig-4"]["status"] == "new" and by_id["sig-3"]["status"] == "queued", "the critical story is written up first"


def test_a_small_story_is_raised_early_only_when_gemini_decisions_scores_it_high(api, bq, dec):
    flags(api.ctx, early_detection=True, early_fast_triage=True)
    bq.raised = [raised(1, kind="early", accounts=3)]
    assert early.check(api.ctx)["raised"] == 1
    assert next(r for r in bq.ran if r["sql"].startswith(f"INSERT INTO `{T['early_signals']}`"))["params"]["early"] is True
    api.ctx.now = lambda at=api.ctx.now() + timedelta(minutes=20): at
    dec.scores.update(independent=0.1)
    bq.raised = [raised(2, kind="early", accounts=3)]
    assert early.check(api.ctx)["held"] == 1
    assert {s["id"]: s["held_why"] for s in api.get("/api/early", status="held").json()["signals"]} == {"sig-2": "below the early-signal bars"}


def test_only_a_lead_starts_a_read_by_hand_and_the_page_says_what_ran_last(api, bq):
    flags(api.ctx, early_detection=True)
    assert api.post("/api/early/check", user=IM).status_code == 403
    r = api.post("/api/early/check").json()
    assert r["ok"] and r["due"]
    state = api.get("/api/early").json()["state"]
    assert state["on"] and state["last"] and state["named_sources"] == ["comments", "sonar"] and state["endpoint"] == "text-embedding-005"


# ---------------------------------------------------------------------------------------------------------------
# The AI page: the three engines and document search, side by side, each checked live
# ---------------------------------------------------------------------------------------------------------------

def test_the_ai_page_shows_what_each_engine_is_for_and_whether_it_is_connected(api, bq):
    engines = {e["key"]: e for e in api.get("/api/ai", user=IM).json()["engines"]}
    assert [(e["name"], e["role"]) for e in engines.values()] == [
        ("Gemini", "Talks with people"), ("Gemini Decisions", "Decides"), ("Vertex AI in BigQuery", "Reads the post tables"),
        ("Document search", "Grounds the answers")]
    assert engines["decisions"]["state"] == "not_connected" and engines["bigquery"]["state"] == "ready"
    assert {s["name"]: s["on"] for s in engines["bigquery"]["switches"]} == {"early_detection": False, "watches": False, "early_cards": False}
    api.ctx.config.platform.decisions.secret = "decisions-key"
    assert {e["key"]: e["state"] for e in api.get("/api/ai").json()["engines"]}["decisions"] == "ready"


def test_the_bigquery_check_dry_runs_every_statement_and_names_the_one_that_fails(api, bq):
    assert api.post("/api/ai/bigquery/check", user=IM).status_code == 403
    good = api.post("/api/ai/bigquery/check").json()
    assert good["ok"] and good["steps"][0] == {"step": "Vertex AI makes an embedding from BigQuery", "ok": True, "detail": "768 numbers", "ms": good["steps"][0]["ms"]}
    assert [d["location"] for d in bq.dry] == ["US", "us-central1", "US", "US", "US", "US"] and all(d["params"] for d in bq.dry)
    assert "valid, would read 1,048,576 bytes" in good["steps"][1]["detail"]
    bq.fail = "other.google_bg.sonar_raw"
    bad = api.post("/api/ai/bigquery/check").json()
    failing = [s for s in bad["steps"] if not s["ok"]]
    assert bad["ok"] is False and [s["step"] for s in failing] == ["Early Detection: read sonar"] and "Unrecognized name: first_seen" in failing[0]["detail"]
    assert api.get("/api/ai").json()["engines"][2]["check"]["ok"] is False, "the last check stays on the page"


def test_each_engine_check_says_why_when_it_cannot_run(api, bq, dec):
    api.ctx.config.platform.decisions.secret = ""
    r = api.post("/api/ai/decisions/check").json()
    assert r["ok"] is False and r["steps"][0]["detail"] == "no API key is set (Settings, Gemini Decisions)"
    api.ctx.config.platform.decisions.secret = "decisions-key"
    dec.scores.update(risk=0.97)
    assert "answered 0.97" in api.post("/api/ai/decisions/check").json()["steps"][0]["detail"]
    api.ctx.llm.on("ai.check", "ready")
    assert all("said: ready" in s["detail"] for s in api.post("/api/ai/gemini/check").json()["steps"])
    assert api.post("/api/ai/documents/check").json()["steps"][0]["step"] == "A search finds passages"
    assert api.post("/api/ai/nothing/check").status_code == 404
