"""Stand-ins the own-alerts tests share: BigQuery, Cloud DLP, the KOF sheet, the salt and Chat (no network).

Each records what it was asked and answers with what a test queued. Everything that calls them is the real code.
"""

from __future__ import annotations

from typing import Any

from triage_agent import bq_admin, secret_admin
from triage_agent.config import TempCheckSource
from triage_agent.ownalerts import kof, scrub

HOME = "proj.slrr_triage_agent"
CONNECTION = "proj.US.slrr_vertex_conn"
COMMENTS = "proj.reporting.comments"
SONAR = "other.google_bg.sonar_raw"
KOF_TABS = [("SLRR Global INFs", [["Name", "Handle"], ["Jane Doe", "@jdoe"]])]


class BigQuery:
    """Records each statement that ran, with its parameters and location. A read of a source table answers with the rows queued
    for it; the "already kept" check answers with the ids in `held`; the procedure's call answers with `summary`."""

    project = "proj"

    def __init__(self):
        self.ran: list[dict[str, Any]] = []
        self.inserted: list[tuple[str, list[dict[str, Any]]]] = []
        self.source_rows: dict[str, list[dict[str, Any]]] = {}
        self.held: set[str] = set()
        self.fail = ""
        self.no_access = ""  # a table whose owners have not let this account in yet
        self.refused: list[str] = []  # statements BigQuery was made to refuse
        self.fail_insert = ""
        self.summary: list[dict[str, Any]] = [{"staged": 0, "new_posts": 0, "hard": 0, "single_asked": 0, "single_queued": 0, "embedded": 0,
                                               "stories_asked": 0, "stories_queued": 0}]
        self.answers: list[tuple[str, list[dict[str, Any]]]] = []  # (what the statement starts with or contains, rows)

    def query(self, sql: str, params: dict[str, Any] | None = None, *, location: str | None = None, max_rows: int = 10000, labels=None):
        if self.no_access and self.no_access in sql:
            self.refused.append(sql)
            raise RuntimeError("403 Access Denied: Table p:d.t: User does not have permission to query table p:d.t, or perhaps it does not exist.")
        if self.fail and self.fail in sql:
            self.refused.append(sql)
            raise RuntimeError("403 Access Denied: the table can't be read")
        self.ran.append({"sql": sql, "params": dict(params or {}), "location": location, "labels": labels})
        for mark, rows in self.answers:
            if mark in sql:
                return rows
        if sql.startswith("SELECT post_id FROM"):
            return [{"post_id": i} for i in (params or {}).get("ids", []) if i in self.held]
        if sql.startswith("CALL "):
            return self.summary
        for table, rows in self.source_rows.items():
            if f"`{table}`" in sql:
                return rows[: int((params or {}).get("cap", 10 ** 9))]
        return []

    def insert_rows(self, table: str, rows: list[dict[str, Any]]) -> None:
        if self.fail_insert and self.fail_insert in table:
            raise RuntimeError("BigQuery insert failed: quota")
        self.inserted.append((table, rows))

    def rows_in(self, name: str) -> list[dict[str, Any]]:
        return [r for table, rows in self.inserted if table == f"{HOME}.{name}" for r in rows]

    def reads_of(self, table: str) -> list[dict[str, Any]]:
        return [r for r in self.ran if f"`{table}`" in r["sql"]]


class Dlp:
    """Cloud DLP as the job sees it: every text back, the one name these tests use replaced by its kind."""

    def __init__(self):
        self.seen: list[str] = []
        self.down = ""

    def deidentify(self, texts: list[str], info_types: list[str]) -> list[str]:
        if self.down:
            raise scrub.Unavailable(self.down)
        self.seen += texts
        return [t.replace("Dana Whitfield", "[PERSON_NAME]") for t in texts]


def row(n: int, text: str = "", *, author: str = "", url: str = "", platform: str = "x", seen: str = "", **over: Any) -> dict[str, Any]:
    """One row as a source's read gives it."""
    return {"one": over.pop("one", url or f"https://x.com/acct{n}/status/{1000 + n}"), "platform": platform, "author": author or f"acct{n}",
            "text": text or f"Chrome keeps logging me out after today's update, attempt {n}", "url": url or f"https://x.com/acct{n}/status/{1000 + n}",
            "posted": "2026-11-21T10:00:00+00:00", "followers": 120, "eng": 14, "shares": 3, "replies": 4, "language": "en",
            "seen": seen or f"2026-11-21T11:{n % 60:02d}:00+00:00", **over}


def set_up(ctx, monkeypatch) -> tuple[BigQuery, Dlp]:
    """Agent alerts switched ON with two tables of posts (one in US, one in us-central1), a salt, a KOF list and DLP."""
    cfg = ctx.config.platform
    cfg.bigquery.dataset, cfg.bigquery.location = HOME, "US"
    cfg.temp_check.sources = [
        TempCheckSource(key="comments", label="Sprinklr comments", table=COMMENTS, location="US", has=["text", "author", "url", "platform", "followers"],
                        dedupe_by="id", read_sql=("SELECT platform, author, text, url, posted, followers, eng, sentiment, language, shares, replies, seen, one "
                                                  "FROM `{table}` WHERE seen >= @t_from AND seen < @t_to")),
        TempCheckSource(key="sonar", label="Sonar", table=SONAR, location="us-central1", text_columns=["title", "body"], url_column="url",
                        time_column="first_seen", author_column="author", platform_column="network", followers_column="followers",
                        engagement_expr="likes + shares", language_column="lang"),
    ]
    own = cfg.own_alerts
    own.sources, own.ai_connection, own.hash_salt_secret, own.kof_sheet = ["comments", "sonar"], CONNECTION, "slrr-author-hash-salt", "https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit"
    cfg.flags.own_alerts = True
    gw, dlp = BigQuery(), Dlp()
    monkeypatch.setattr(bq_admin, "get_gateway", lambda c: gw)
    monkeypatch.setattr(scrub, "get_dlp", lambda c: dlp)
    monkeypatch.setattr(kof, "read_sheet", lambda link: KOF_TABS)
    monkeypatch.setattr(secret_admin, "read", lambda c, name: {"slrr-author-hash-salt": "pepper", "bw-token": "token-value"}[name])
    return gw, dlp
