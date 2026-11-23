"""Own alerts: one run. The objects are brought up to date, every source is read and staged, and BigQuery's procedure
checks, groups and queues what was staged. Stand-ins: tests/own_helpers.py (no network)."""

from __future__ import annotations

from typing import Any

import pytest

from own_helpers import HOME, SONAR, row, set_up
from triage_agent.ownalerts import cycle, schema
from triage_agent.platform_jobs import run_job


@pytest.fixture
def world(ctx, monkeypatch):
    gw, dlp = set_up(ctx, monkeypatch)
    ctx.config.platform.flags.bigquery_admin = True
    return gw, dlp


def kinds(gw) -> list[str]:
    """What ran, in order: create (the objects), read (a source), held (already kept?), call (the procedure)."""
    out = []
    for r in gw.ran:
        sql = r["sql"]
        kind = ("call" if sql.startswith("CALL ") else "held" if sql.startswith("SELECT post_id FROM") else
                "read" if sql.startswith("SELECT CAST(one AS STRING)") else "create")
        if not out or out[-1] != kind:
            out.append(kind)
    return out


def events(ctx, kind: str) -> list[Any]:
    return ctx.events.query(types=[kind])


def test_nothing_runs_while_the_switch_is_off(ctx, world):
    gw, _ = world
    ctx.config.platform.flags.own_alerts = False
    assert cycle.run(ctx) == {"ok": True, "off": True} and gw.ran == []


def test_a_run_creates_the_objects_reads_the_sources_then_calls_the_procedure(ctx, world):
    gw, _ = world
    gw.source_rows[SONAR] = [row(1), row(2)]
    gw.summary = [{"staged": 2, "new_posts": 2, "hard": 0, "single_asked": 1, "single_queued": 1, "embedded": 1, "stories_asked": 0, "stories_queued": 0}]
    out = cycle.run(ctx)
    assert kinds(gw) == ["create", "read", "held", "call"], "both tables are read, then what is new is checked against what is kept"
    assert out == {"ok": True, "due": True, "error": "", "read": 2, "staged": 2, "new_posts": 2, "hard": 0, "single_asked": 1, "single_queued": 1,
                   "embedded": 1, "stories_asked": 0, "stories_queued": 0, "failing": []}
    call = gw.ran[-1]
    wanted_sql, wanted_params = schema.call(ctx, "other_alerts")
    assert call["sql"] == wanted_sql == f"CALL `{HOME}.run_9source_triage_cycle`(" + ", ".join(f"@{n}" for n, _ in schema.PARAMS) + ")"
    assert call["params"] == wanted_params and call["location"] == "US" and call["labels"] == schema.LABELS
    assert schema.current(ctx)


def test_the_objects_are_created_once_and_again_when_a_setting_changes_what_they_say(ctx, clock, world):
    gw, _ = world
    cycle.run(ctx)
    created = sum(1 for r in gw.ran if r["sql"].startswith("CREATE"))
    clock.advance(minutes=3)
    cycle.run(ctx)
    assert sum(1 for r in gw.ran if r["sql"].startswith("CREATE")) == created
    ctx.config.platform.own_alerts.fast_endpoint = "gemini-4-neon"
    clock.advance(minutes=3)
    cycle.run(ctx)
    assert sum(1 for r in gw.ran if r["sql"].startswith("CREATE")) == created * 2


def test_with_the_bigquery_switch_off_and_no_objects_yet_nothing_is_read(ctx, world):
    gw, _ = world
    ctx.config.platform.flags.bigquery_admin = False
    out = cycle.run(ctx)
    assert out["ok"] is False and gw.ran == []
    assert out["error"] == ('Own alerts\' tables in BigQuery are not created yet, or a setting changed what they hold. An admin can turn on '
                            '"Change BigQuery from here" under Settings, Switches; the next run creates them.')


def test_a_run_is_due_every_two_minutes_and_can_be_asked_for(ctx, clock, world):
    assert cycle.run(ctx)["due"] is True
    clock.advance(minutes=1)
    assert cycle.run(ctx) == {"ok": True, "due": False}
    assert cycle.run(ctx, force=True)["due"] is True
    clock.advance(minutes=2)
    assert cycle.run(ctx)["due"] is True


def test_a_second_run_does_not_start_while_one_is_going(ctx, world):
    assert ctx.store.claim_idempotent(cycle.LOCK, ttl_s=600)
    assert cycle.run(ctx) == {"ok": True, "busy": True}
    ctx.store.release_idempotent(cycle.LOCK)
    assert cycle.run(ctx)["due"] is True
    assert ctx.store.claim_idempotent(cycle.LOCK, ttl_s=600), "the run let go of its claim"


def test_what_a_run_found_is_kept_for_the_console_and_recorded_as_an_event(ctx, world):
    gw, _ = world
    gw.source_rows[SONAR] = [row(1)]
    gw.summary = [{"staged": 1, "new_posts": 1, "hard": 1, "single_asked": 0, "single_queued": 0, "embedded": 0, "stories_asked": 0, "stories_queued": 0}]
    cycle.run(ctx)
    st = cycle.status(ctx)
    assert st["on"] is True and st["last"] == ctx.now().isoformat() and st["error"] == "" and st["objects"] == "ready"
    assert st["result"] == {"read": 1, "staged": 1, "new_posts": 1, "hard": 1, "single_asked": 0, "single_queued": 0, "embedded": 0,
                            "stories_asked": 0, "stories_queued": 0}
    assert [(s["key"], s["status"], s["kept"]) for s in st["sources"]] == [("comments", "live", 0), ("sonar", "live", 1)]
    (event,) = events(ctx, "own.cycle")
    assert event.actor == "agent" and event.space == "system" and event.payload["staged"] == 1 and event.payload["hard"] == 1
    assert event.payload["failing"] == [] and isinstance(event.latency_ms, int)


def test_a_source_that_fails_does_not_stop_the_procedure_but_the_run_is_not_ok(ctx, world):
    gw, _ = world
    gw.fail = f"`{SONAR}`"
    out = cycle.run(ctx)
    assert out["ok"] is False and out["failing"] == ["sonar"] and out["error"] == "Could not read: Sonar"
    assert gw.ran[-1]["sql"].startswith("CALL "), "what the other sources staged is still checked"


def test_the_procedure_failing_is_said_in_bigquerys_words(ctx, clock, world):
    gw, _ = world
    cycle.run(ctx)
    gw.fail = "CALL "
    clock.advance(minutes=2)
    out = cycle.run(ctx)
    assert out["ok"] is False and out["error"] == "BigQuery could not finish the run: 403 Access Denied: the table can't be read"
    assert cycle.status(ctx)["error"] == out["error"] and cycle.status(ctx)["last"] == ctx.now().isoformat()


def test_a_missing_salt_stops_the_run_before_anything_is_read(ctx, world):
    gw, _ = world
    ctx.config.platform.own_alerts.hash_salt_secret = ""
    out = cycle.run(ctx)
    assert out["ok"] is False and "salt" in out["error"]
    assert not [r for r in gw.ran if not r["sql"].startswith(("CREATE", "ALTER"))], "no source is read and the procedure is not called"


def test_the_in_house_job_runs_own_alerts_and_fails_when_it_fails(ctx, world):
    gw, _ = world
    gw.source_rows[SONAR] = [row(1)]
    out = run_job(ctx, "inhouse")
    assert out["ok"] is True and out["data"]["own_alerts"]["staged"] == 1 and "own alerts: 1 read, 1 kept" in out["summary"]
    gw.fail = "CALL "
    ctx.store.put_kv(cycle.STATE, {})
    out = run_job(ctx, "inhouse")
    assert out["ok"] is False and out["data"]["failed_steps"] == ["own_alerts"]


def test_the_in_house_job_is_as_it_was_while_own_alerts_is_off(ctx, world):
    gw, _ = world
    ctx.config.platform.flags.own_alerts = False
    out = run_job(ctx, "inhouse")
    assert out["ok"] is True and out["data"]["processed"] == 0 and "own_alerts" not in out["data"] and "failed_steps" not in out["data"]
    assert out["summary"] == "in-house ingestion disabled" and gw.ran == []
