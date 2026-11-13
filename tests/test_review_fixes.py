"""Regression tests for the Python review findings (each test reproduces the original defect).

  V7  "today" windows off by the UTC offset where timestamps are compared as text
  V8  the Burson digest recorded as posted when nothing was queued
  V9  run_followups step failures hidden behind a green job
  V1c Sonar lookup failures logged at DEBUG and read as "no record"

Run: TRIAGE_LLM=fake .venv/bin/python -m pytest -q tests/test_review_fixes.py
"""

from __future__ import annotations

import json
import logging
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from zoneinfo import ZoneInfo

import pytest

from jobs import run_job
from test_triage import ok_llm
from triage_agent import followups
from triage_agent.converse.answer import metrics_window
from triage_agent.events import EventType, SqliteEventLogger, make_event
from triage_agent.operations import handle
from triage_agent.qa.sonar import SonarLookup
from triage_agent.store import FirestoreStore

JOB = {"deliver": "outbox", "flow": "job", "invoked_by": "job:test"}
NEW_YORK = ZoneInfo("America/New_York")
DIGEST_KEY = "digest:2026-10-12"  # conftest clock: Mon 2026-10-12 18:00 UTC = 14:00 in New York
POST_URL = "https://x.com/someone/status/1845123456789012345"
SONAR_LOG = "triage_agent.qa.sonar"


@pytest.fixture(autouse=True)
def _llm(fake_llm):
    ok_llm(fake_llm)


def run(ctx, *steps):
    return handle({"op": "run_followups", "payload": {"steps": list(steps)}, "context": JOB}, ctx)


def boom(_ctx):
    raise RuntimeError("gmail down")


# ---------------------------------------------------------------------------
# V7. Time bounds in another zone are converted to UTC before the text comparison
# ---------------------------------------------------------------------------


def test_today_window_stops_at_local_midnight(ctx):
    # New York is UTC-4 on this date, so "today" starts at 04:00 UTC.
    late_yesterday = datetime(2026, 10, 12, 3, 30, tzinfo=UTC)  # 23:30 on Oct 11, local
    early_today = datetime(2026, 10, 12, 4, 30, tzinfo=UTC)  # 00:30 on Oct 12, local
    ctx.events.log(make_event(EventType.ALERT_RECEIVED, case_id="TRG-yesterday", event_ts=late_yesterday))
    ctx.events.log(make_event(EventType.ALERT_RECEIVED, case_id="TRG-today", event_ts=early_today))

    since, until, label = metrics_window(ctx, "how many alerts today?")
    assert label == "Today" and since.utcoffset() == timedelta(hours=-4), "the bound is local midnight"
    assert [e.case_id for e in ctx.events.query(since=since, until=until)] == ["TRG-today"]

    since, until, label = metrics_window(ctx, "and yesterday?")
    assert label == "Yesterday"
    assert [e.case_id for e in ctx.events.query(since=since, until=until)] == ["TRG-yesterday"]


def test_naive_bounds_are_still_read_as_utc(tmp_path):
    events = SqliteEventLogger(tmp_path / "events.db")
    stamp = datetime(2026, 10, 12, 4, 30, tzinfo=UTC)
    events.log(make_event(EventType.ALERT_RECEIVED, case_id="TRG-1", event_ts=stamp))
    assert [e.case_id for e in events.query(since=datetime(2026, 10, 12, 4, 0))] == ["TRG-1"]
    assert events.query(since=datetime(2026, 10, 12, 5, 0)) == []


class _RecordingQuery:
    def __init__(self) -> None:
        self.filters: list[tuple] = []

    def where(self, field, op, value):
        self.filters.append((field, op, value))
        return self

    def order_by(self, *_args, **_kwargs):
        return self

    def limit(self, _n):
        return self

    def stream(self):
        return []


def test_firestore_case_bound_is_utc_text():
    query = _RecordingQuery()
    store = FirestoreStore.__new__(FirestoreStore)  # no client: only the query list_cases builds is tested
    store.db = SimpleNamespace(collection=lambda _name: query)
    store._fs = SimpleNamespace(Query=SimpleNamespace(DESCENDING="DESCENDING"))
    shift_start = datetime(2026, 10, 12, 0, 0, tzinfo=NEW_YORK)  # build_handover passes shift-zone times
    assert store.list_cases(since=shift_start) == []
    assert query.filters == [("updated_at", ">=", "2026-10-12T04:00:00+00:00")]


# ---------------------------------------------------------------------------
# V8. No day key and no burson.digest_posted unless a digest was queued
# ---------------------------------------------------------------------------


def test_digest_with_posting_off_records_nothing(ctx):
    ctx.config.burson_feedback.post_digest_to_burson_space = False  # the shipped setting
    resp = run(ctx, "digest")
    assert resp.ok and resp.data["digest"] == 0
    assert ctx.store.list_outbox(undelivered_only=False) == []
    assert ctx.events.query(types=[EventType.BURSON_DIGEST_POSTED]) == []
    assert ctx.store.get_kv(DIGEST_KEY) is None

    # Switched on later the same day: today's digest still goes out, and only once.
    ctx.config.burson_feedback.post_digest_to_burson_space = True
    run(ctx, "digest")
    run(ctx, "digest")
    assert [i.target for i in ctx.store.list_outbox(undelivered_only=False)] == ["burson"]
    assert len(ctx.events.query(types=[EventType.BURSON_DIGEST_POSTED])) == 1
    assert ctx.store.get_kv(DIGEST_KEY) is not None


def test_digest_job_says_what_it_queued(ctx, monkeypatch, capsys):
    monkeypatch.setattr(run_job, "build_context", lambda: ctx)
    ctx.config.burson_feedback.post_digest_to_burson_space = False
    assert run_job.main(["digest"]) == 0
    assert json.loads(capsys.readouterr().out) == {"ok": True, "job": "digest", "queued": 0}
    assert ctx.events.query(types=[EventType.BURSON_DIGEST_POSTED]) == []

    ctx.config.burson_feedback.post_digest_to_burson_space = True
    assert run_job.main(["digest"]) == 0
    assert json.loads(capsys.readouterr().out) == {"ok": True, "job": "digest", "queued": 1}
    assert len(ctx.events.query(types=[EventType.BURSON_DIGEST_POSTED])) == 1


# ---------------------------------------------------------------------------
# V9. A failed step is reported, the other steps still run, and the job exits non-zero
# ---------------------------------------------------------------------------


def test_failed_step_is_listed_and_the_other_steps_still_run(ctx, monkeypatch):
    monkeypatch.setattr(followups, "sent_detection", boom)
    resp = run(ctx, "sla", "sent", "rering")
    assert resp.ok, "the operation still answers: every step ran"
    assert resp.data["failed_steps"] == ["sent"] and resp.data["sent"] == "error: gmail down"
    assert resp.data["sla"] == 0 and resp.data["rering"] == 0
    errors = ctx.events.query(types=[EventType.ERROR])
    assert [e.payload["op"] for e in errors] == ["run_followups.sent"]

    assert "failed_steps" not in run(ctx, "sla", "rering").data


def test_handover_failure_does_not_stop_the_steps_after_it(ctx, monkeypatch):
    monkeypatch.setattr(followups, "handover_due", boom)
    resp = run(ctx, "handover", "parity", "rering")
    assert resp.ok and resp.data["failed_steps"] == ["handover"]
    assert resp.data["parity"] == 0 and resp.data["rering"] == 0


def test_followups_job_exits_nonzero_when_a_step_failed(ctx, monkeypatch, capsys):
    monkeypatch.setattr(run_job, "build_context", lambda: ctx)
    assert run_job.main(["followups"]) == 0
    assert json.loads(capsys.readouterr().out)["ok"] is True

    monkeypatch.setattr(followups, "sla_misses", boom)
    assert run_job.main(["followups"]) == 1
    printed = json.loads(capsys.readouterr().out)
    assert printed["ok"] is False and printed["data"]["failed_steps"] == ["sla_misses"]
    assert "rering" in printed["data"], "the steps after the failed one still ran"


def test_job_names_are_unchanged():
    assert run_job.JOBS == ["digest", "followups", "handover", "inhouse"]


# ---------------------------------------------------------------------------
# V1c. Sonar lookup failures are warnings; the fall-through is unchanged
# ---------------------------------------------------------------------------


class _Client:
    """BigQuery client stand-in: `rows` to return, or an exception to raise from query()."""

    def __init__(self, rows=None, error: Exception | None = None) -> None:
        self.rows, self.error, self.queries = rows or [], error, 0

    def query(self, _sql, **_kwargs):
        self.queries += 1
        if self.error:
            raise self.error
        rows = [SimpleNamespace(items=row.items) for row in self.rows]
        return SimpleNamespace(result=lambda: rows)


def _lookup(client, client_us) -> SonarLookup:
    lookup = SonarLookup.__new__(SonarLookup)  # no BigQuery client is created
    lookup.cfg = SimpleNamespace(
        table="proj.ds.sonar_raw",
        alert_log_table="proj.ds.slrr_source_mirror",
        slrr_table="proj.ds.slrr_alerts",
        lookback_days=14,
    )
    lookup.bq = SimpleNamespace(
        ArrayQueryParameter=lambda *a: a,
        ScalarQueryParameter=lambda *a: a,
        QueryJobConfig=lambda **kw: kw,
    )
    lookup.client, lookup.client_us = client, client_us
    return lookup


def _sonar_warnings(caplog) -> list[logging.LogRecord]:
    return [r for r in caplog.records if r.name == SONAR_LOG and r.levelno == logging.WARNING]


def test_sonar_lookup_failures_are_logged_as_warnings(caplog):
    client = _Client(error=RuntimeError("403 denied"))
    client_us = _Client(error=RuntimeError("no such column"))
    with caplog.at_level(logging.WARNING, logger=SONAR_LOG):
        assert _lookup(client, client_us).by_post_url(POST_URL) is None
    assert client.queries == 2 and client_us.queries == 1, "all three lookups are still tried"
    warnings = _sonar_warnings(caplog)
    assert [r.getMessage() for r in warnings] == [
        "Primary sonar lookup failed on proj.ds.sonar_raw",
        "Secondary alert-log lookup failed on proj.ds.slrr_source_mirror",
        "Tertiary slrr_alerts lookup failed on proj.ds.slrr_alerts",
    ]
    assert all(r.exc_info for r in warnings)


def test_sonar_lookup_still_falls_through_to_the_next_table(caplog):
    client = _Client(error=RuntimeError("403 denied"))
    client_us = _Client(rows=[{"url": POST_URL, "likes": "12"}])
    with caplog.at_level(logging.WARNING, logger=SONAR_LOG):
        row = _lookup(client, client_us).by_post_url(POST_URL)
    assert row is not None and row["likes"] == 12
    assert len(_sonar_warnings(caplog)) == 2


def test_sonar_raw_query_and_deduped_slrr_table():
    seen_sql: list[str] = []

    class _SqlClient:
        def query(self, sql, **_kwargs):
            seen_sql.append(sql)
            return SimpleNamespace(result=lambda: [])

    lookup = _lookup(_SqlClient(), _SqlClient())
    lookup.cfg.alert_log_table = lookup.cfg.slrr_table  # duplicate secondary is skipped
    assert lookup.by_post_url(POST_URL) is None
    assert len(seen_sql) == 2
    assert "FROM `proj.ds.sonar_raw`" in seen_sql[0]
    assert "INTERVAL 48 HOUR" in seen_sql[0]
    assert "FROM `proj.ds.slrr_alerts`" in seen_sql[1]


def test_inhouse_dsd_story_selection_row_mapping(ctx):
    from triage_agent.inhouse import _row_alert_id, _row_timestamp, row_to_parsed

    dsd_row = {
        "ingestion_time": datetime(2026, 11, 12, 15, 0, tzinfo=UTC),
        "platform": "X",
        "alert_type": "KOF",
        "author": "@techjournalist",
        "follower_count": 85000,
        "url": POST_URL,
        "snippet": "Gemini App deleted my Workspace draft without warning.",
        "post_time": datetime(2026, 11, 12, 14, 30, tzinfo=UTC),
        "query_id": 2004167929,
        "query_name": "All SLRR KOFs/INF",
        "total_engagements": 340,
    }
    assert _row_alert_id(dsd_row) == "x.com/status/1845123456789012345"
    assert _row_timestamp(dsd_row) == dsd_row["ingestion_time"]
    parsed = row_to_parsed(ctx, dsd_row)
    assert parsed.fields["kof"] is True
    assert parsed.fields["engagement_level"] == "VIRAL KOF"
    assert parsed.fields["followers"] == 85000
    assert parsed.fields["total_engagement"] == 340
    assert parsed.fields["product"] == "Brand"


def test_campaigns_bigquery_mentions_uses_approved_tables():
    from slrr_campaigns.bigquery_mentions import BigQueryMentionsClient
    from slrr_campaigns.config import load_config as load_campaigns_config

    cfg = load_campaigns_config()
    assert cfg.bigquery_dsd_table == "brand-social-central-data.DSD.DSD-story-selection"
    assert cfg.bigquery_brandwatch_table == "brand-social-central-data.raw_data.brandwatch_raw_mentions_base"

    queries: list[str] = []
    client = BigQueryMentionsClient.__new__(BigQueryMentionsClient)
    client._cfg = cfg
    client._client = SimpleNamespace(
        query=lambda sql, **_kw: (queries.append(sql), SimpleNamespace(result=lambda: []))[1]
    )
    assert client.preflight_check() == {"dsd_7d": 0, "brandwatch_7d": 0}
    assert client.query_deep_dive_mentions(
        alert_name="Gemini",
        start_iso="2026-11-10T00:00:00Z",
        end_iso="2026-11-12T00:00:00Z",
        query_ids=[2004167929],
    ) == []
    assert client.hydrate_urls([POST_URL]) == {}
    assert len(queries) == 3
    for sql in queries:
        assert "all_sundar_mentions" not in sql
        assert "social_alerts_dataset" not in sql
        assert "DSD.DSD-story-selection" in sql
        assert "raw_data.brandwatch_raw_mentions_base" in sql
        assert "report_date" in sql

