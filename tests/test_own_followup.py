"""Agent alerts after an alert is raised: a raised story that is growing again is reviewed once more, what is past its
days is deleted, and the worker's minute tick runs the review. Stand-ins: tests/own_helpers.py (no network)."""

from __future__ import annotations

from datetime import timedelta

import pytest

from own_helpers import HOME, set_up
from triage_agent import retention
from triage_agent.operations import handle
from triage_agent.ownalerts import purge, review, schema, surge
from triage_agent.platform_jobs import run_job

JOB = {"deliver": "outbox", "flow": "job", "invoked_by": "job:test"}
SURGE = f"INSERT INTO `{HOME}.review_queue` ("
QUEUE = f"FROM `{HOME}.review_queue` rq"


@pytest.fixture
def world(ctx, monkeypatch):
    gw, _ = set_up(ctx, monkeypatch)
    ctx.config.platform.flags.bigquery_admin = True
    schema.provision(ctx)
    gw.ran.clear()
    return gw


def deletes(gw) -> dict[str, dict]:
    """table -> the DELETE that ran on it."""
    return {r["sql"].split("`")[1].split(".")[-1]: r for r in gw.ran if r["sql"].startswith("DELETE FROM")}


# -- a raised story that is growing again ------------------------------------------------------------------------------
def test_a_raised_story_growing_again_is_queued_for_another_review(ctx, world):
    own = ctx.config.platform.own_alerts
    own.surge_min_minutes, own.surge_max_hours, own.surge_min_posts, own.surge_ratio = 20, 3, 30, 2.5
    world.answers.append((SURGE, [{"n": 2}]))
    assert surge.run(ctx) == 2
    (ran,) = world.ran
    sql, now = ran["sql"], ctx.now()
    assert sql.startswith(SURGE) and "'STORY', s.story_id, 'FOLLOWUP_SURGE'" in sql and f"FROM `{HOME}.stories` s" in sql
    assert "s.last_alerted_at BETWEEN @earliest AND @latest" in sql, "not straight after the alert, and not long after it"
    assert "s.post_count_15m >= @min_posts AND s.velocity_ratio_15m >= @ratio" in sql
    assert "s.updated_at >= @measured" in sql, "a story nobody has measured lately is not growing"
    assert ran["params"] == {"now": now, "earliest": now - timedelta(hours=3), "latest": now - timedelta(minutes=20), "measured": now - timedelta(minutes=15),
                             "min_posts": 30, "ratio": 2.5}
    assert ran["location"] == "US" and ran["labels"] == schema.LABELS
    assert sql.rstrip().endswith("SELECT @@row_count AS n;")


def test_a_story_is_queued_again_once_for_each_time_it_was_raised(ctx, world):
    surge.run(ctx)
    sql = world.ran[0]["sql"]
    assert (f"AND NOT EXISTS (SELECT 1 FROM `{HOME}.review_queue` q WHERE q.queued_at >= @earliest AND q.target_id = s.story_id "
            "AND q.trigger_path = 'FOLLOWUP_SURGE' AND q.queued_at >= s.last_alerted_at)") in sql


def test_no_story_is_queued_again_while_the_switch_is_off_or_the_tables_are_not_there(ctx, world):
    ctx.config.platform.flags.own_alerts = False
    assert surge.run(ctx) == 0 and world.ran == []
    ctx.config.platform.flags.own_alerts = True
    ctx.config.platform.own_alerts.fast_endpoint = "gemini-4-neon"  # the objects are out of date until the job's next run
    assert surge.run(ctx) == 0 and world.ran == []


def test_the_followups_job_checks_for_growing_stories_every_run(ctx, world):
    world.answers.append((SURGE, [{"n": 1}]))
    res = handle({"op": "run_followups", "payload": {}, "context": JOB}, ctx)
    assert res.ok and res.data["own_alerts"] == 1 and "failed_steps" not in res.data
    assert "own_alerts=1" in res.outputs["summary"]


def test_a_failed_check_fails_the_followups_job_and_the_other_steps_still_run(ctx, world):
    world.fail = "FOLLOWUP_SURGE"
    res = handle({"op": "run_followups", "payload": {}, "context": JOB}, ctx)
    assert res.data["failed_steps"] == ["own_alerts"] and "403 Access Denied" in res.data["own_alerts"]
    assert "rering" in res.data, "the step after it ran"


# -- what is past its days is deleted ----------------------------------------------------------------------------------
def test_each_table_loses_what_is_past_its_days(ctx, world):
    own = ctx.config.platform.own_alerts
    own.keep_days, own.decisions_keep_days = 21, 60
    out = purge.run(ctx)
    now = ctx.now()
    ran = deletes(world)
    assert {name: (r["sql"], r["params"]["before"]) for name, r in ran.items()} == {
        "posts_staging": (f"DELETE FROM `{HOME}.posts_staging` WHERE ingested_at < @before", now - timedelta(days=1)),
        "author_vault_30d": (f"DELETE FROM `{HOME}.author_vault_30d` WHERE ingested_at < @before", now - timedelta(days=21)),
        "posts": (f"DELETE FROM `{HOME}.posts` WHERE ingested_at < @before", now - timedelta(days=21)),
        "post_metrics": (f"DELETE FROM `{HOME}.post_metrics` WHERE recorded_at < @before", now - timedelta(days=21)),
        "stories": (f"DELETE FROM `{HOME}.stories` WHERE updated_at < @before", now - timedelta(days=21)),
        "review_queue": (f"DELETE FROM `{HOME}.review_queue` WHERE queued_at < @before", now - timedelta(days=21)),
        "decisions": (f"DELETE FROM `{HOME}.decisions` WHERE decided_at < @before", now - timedelta(days=60)),
        "feedback": (f"DELETE FROM `{HOME}.feedback` WHERE submitted_at < @before", now - timedelta(days=60)),
    }
    assert set(ran) == set(schema.TABLES), "every table that holds posts or decisions"
    assert all(r["location"] == "US" and r["labels"] == schema.LABELS for r in ran.values())
    assert out == {"ok": True, "ran": True, "tables": sorted(schema.TABLES), "failed": [], "error": ""}


def test_the_deletes_run_once_a_day(ctx, clock, world):
    purge.run(ctx)
    world.ran.clear()
    clock.advance(hours=23)
    assert purge.run(ctx) == {"ok": True, "ran": False} and world.ran == []
    clock.advance(hours=1)
    assert purge.run(ctx)["ran"] is True and len(deletes(world)) == len(schema.TABLES)


def test_the_deletes_run_with_the_switch_off_once_the_tables_exist(ctx, world):
    ctx.config.platform.flags.own_alerts = False
    assert purge.run(ctx)["ran"] is True and len(deletes(world)) == len(schema.TABLES), "what was kept still leaves after its days"


def test_nothing_is_deleted_before_the_tables_were_ever_created(ctx, monkeypatch):
    gw, _ = set_up(ctx, monkeypatch)
    assert purge.run(ctx) == {"ok": True, "ran": False} and gw.ran == []


def test_a_table_that_cannot_be_cleared_is_named_and_tried_again_within_the_hour(ctx, clock, world):
    world.fail = f"`{HOME}.posts`"
    out = purge.run(ctx)
    assert out["ok"] is False and out["failed"] == ["posts"] and "posts: 403 Access Denied" in out["error"]
    assert len(deletes(world)) == len(schema.TABLES) - 1, "the other tables were cleared"
    world.fail = ""
    world.ran.clear()
    clock.advance(minutes=59)
    assert purge.run(ctx) == {"ok": False, "ran": False, "failed": ["posts"], "error": out["error"]}, "the failure stays on show until it is tried again"
    clock.advance(minutes=1)
    assert purge.run(ctx) == {"ok": True, "ran": True, "tables": sorted(schema.TABLES), "failed": [], "error": ""}


def test_the_consoles_record_of_a_decision_leaves_after_its_days(ctx, clock, world):
    ctx.config.platform.own_alerts.console_keep_days = 10
    ctx.store.put_doc(review.DECISIONS, "own-old", {"id": "own-old", "at": ctx.now().isoformat(), "links": ["https://x.com/a/status/1"], "kof": "Jane Doe (@jdoe)"})
    clock.advance(days=9)
    ctx.store.put_doc(review.DECISIONS, "own-new", {"id": "own-new", "at": ctx.now().isoformat(), "links": [], "kof": ""})
    clock.advance(days=2)
    assert retention.run(ctx, force=True)["removed"][review.DECISIONS] == 1
    assert [d["id"] for d in ctx.store.list_docs(review.DECISIONS, limit=10)] == ["own-new"]


# -- the worker's minute tick -------------------------------------------------------------------------------------------
def test_the_minute_tick_reviews_what_is_queued_before_it_posts_what_is_queued_for_chat(ctx, fake_llm, world):
    fake_llm.on("own.review", {"escalate": True, "severity": "P1", "escalation_path": "PR_COMMS", "decision_rationale": "Several owners report it."})
    ctx.config.platform.own_alerts.review_engine = "worker"
    world.answers.append((QUEUE, [{"queue_id": "q1", "queued_at": "2026-11-21T11:00:00+00:00", "item_type": "SINGLE_POST", "target_id": "post1",
                                   "trigger_path": "SINGLE_POST_GEMINI", "matched_rule_id": "rule-1", "rule_name": "Recall or safety notice",
                                   "evidence": "Pixel battery swelling again"}]))
    jobs = run_job(ctx, "maintenance")["jobs"]
    own = jobs["own_alerts"]
    assert own["ok"] is True and own["reviewed"] == 1 and own["raised"] == 1 and own["purge"]["ran"] is True
    order = list(jobs)
    assert order.index("own_alerts") < order.index("chat_delivery"), "an alert raised this minute can be posted this minute"


def test_a_review_that_cannot_run_shows_in_the_ticks_failed_parts(ctx, world):
    world.fail = QUEUE
    out = run_job(ctx, "maintenance")
    assert out["jobs"]["own_alerts"]["ok"] is False and "403 Access Denied" in out["jobs"]["own_alerts"]["error"]
    assert "own_alerts" in ctx.store.get_kv("tick:last")["failed"] and out["ok"] is False


def test_a_table_that_cannot_be_cleared_shows_in_the_ticks_failed_parts(ctx, world):
    world.fail = f"DELETE FROM `{HOME}.author_vault_30d`"
    out = run_job(ctx, "maintenance")
    own = out["jobs"]["own_alerts"]
    assert own["ok"] is False and own["purge"]["failed"] == ["author_vault_30d"], "links and names that outstay their days are not a quiet failure"
    assert "own_alerts" in ctx.store.get_kv("tick:last")["failed"]


def test_the_tick_leaves_own_alerts_alone_while_the_switch_is_off_and_nothing_was_ever_created(ctx, monkeypatch):
    gw, _ = set_up(ctx, monkeypatch)
    ctx.config.platform.flags.own_alerts = False
    own = run_job(ctx, "maintenance")["jobs"]["own_alerts"]
    assert own == {"ok": True, "off": True, "purge": {"ok": True, "ran": False}} and gw.ran == []
