"""Own alerts: the review. What BigQuery queued is reviewed on the Agent Runtime (or by the worker when it cannot be
reached), a mandatory rule cannot be overruled, each decision is kept once, a raised alert is queued for Chat with its
link from the vault, and an analyst's verdict is kept.

Stand-ins: tests/own_helpers.py for BigQuery, FakeLLM for Gemini, a recorded HTTP session for the Agent Runtime.
"""

from __future__ import annotations

import json
from typing import Any

import pytest

from own_helpers import HOME, set_up
from triage_agent import agent_runtime
from triage_agent.ownalerts import feedback, raise_, review, schema

RESOURCE = "projects/1028310913761/locations/us-central1/reasoningEngines/4242"
QUEUE = f"FROM `{HOME}.review_queue` rq"
VAULT = f"`{HOME}.author_vault_30d` v"
ANALYST = "ana.ruiz@roster.test"


def item(n: int, kind: str = "SINGLE_POST", trigger: str = "SINGLE_POST_GEMINI", **over: Any) -> dict[str, Any]:
    story = kind == "STORY"
    return {"queue_id": f"q{n}", "queued_at": "2026-11-21T11:00:00+00:00", "item_type": kind, "target_id": f"st-{n}" if story else f"post{n}",
            "trigger_path": trigger, "matched_rule_id": None if story else "rule-1", "stage1_rank_score": 0.8,
            "stage1_rationale": "Several accounts report the same fault", "rule_name": None if story else "Recall or safety notice",
            "process_doc_section": None if story else "4.2 Product safety", "forced_severity": None, "forced_escalation_path": None,
            "evidence": "Pixel battery swelling again, [PERSON_NAME] says || second report" if story else "Pixel battery swelling again, [PERSON_NAME] says",
            "post_count_15m": 12 if story else None, "post_count_1h": 15 if story else None, "unique_authors_15m": 9 if story else None,
            "velocity_ratio_15m": 3.2 if story else None, "story_summary": None, "source_system": None if story else "sonar",
            "platform": None if story else "x", "kof_tier": None if story else "NON_KOF", "is_kof": None if story else False,
            "author_followers": None if story else 120, **over}


def kept(base: dict[str, Any], escalate: bool = True) -> dict[str, Any]:
    """The same queue item after a run that kept its decision in BigQuery and did not finish: the queue's read gives the decision with it."""
    return {**base, "kept_id": review.decision_id(base["queue_id"]), "kept_at": "2026-11-21T11:01:00+00:00", "kept_escalate": escalate,
            "kept_severity": "P0", "kept_path": "LEGAL", "kept_rationale": "Decided before the run was cut short.", "kept_evidence": base["evidence"],
            "kept_velocity": "It meets the mandatory rule Recall or safety notice", "kept_session": "worker"}


@pytest.fixture
def world(ctx, fake_llm, monkeypatch):
    gw, _ = set_up(ctx, monkeypatch)
    cfg = ctx.config.platform
    cfg.flags.bigquery_admin = True
    schema.provision(ctx)
    gw.ran.clear()
    fake_llm.on("own.review", {"escalate": True, "severity": "P1", "escalation_path": "PR_COMMS", "decision_rationale": "A safety fault reported by several owners."})
    cfg.own_alerts.review_engine = "worker"
    return gw


def queued(gw, *items: dict[str, Any]) -> None:
    gw.answers = [a for a in gw.answers if a[0] != QUEUE] + [(QUEUE, list(items))]


def inserted(gw) -> list[dict[str, Any]]:
    """The decisions handed to BigQuery, as the INSERT's rows parameter carries them."""
    return [row for r in gw.ran if r["sql"].startswith(f"INSERT INTO `{HOME}.decisions`") for row in json.loads(r["params"]["decided"])]


def docs(ctx) -> list[dict[str, Any]]:
    return sorted(ctx.store.list_docs(review.DECISIONS, limit=100), key=lambda d: d["queue_id"])


def closes(gw) -> list[list[str]]:
    """The queue ids each closing statement named."""
    return [r["params"]["done"] for r in gw.ran if r["sql"].startswith(f"UPDATE `{HOME}.review_queue`")]


# -- when it runs --------------------------------------------------------------------------------------------------------
def test_nothing_is_reviewed_while_the_switch_is_off_or_the_tables_are_not_there(ctx, world):
    ctx.config.platform.flags.own_alerts = False
    assert review.run(ctx) == {"ok": True, "off": True} and world.ran == []
    ctx.config.platform.flags.own_alerts = True
    ctx.config.platform.own_alerts.fast_endpoint = "gemini-4-neon"  # the objects are now out of date: the next run of the job re-creates them
    assert review.run(ctx) == {"ok": True, "waiting": True} and world.ran == []


def test_the_queue_is_read_mandatory_first_up_to_the_number_a_minute(ctx, world):
    ctx.config.platform.own_alerts.reviews_per_minute = 7
    review.run(ctx)
    read = next(r for r in world.ran if QUEUE in r["sql"])
    assert read["location"] == "US" and read["params"]["n"] == 7
    assert "IFNULL(rq.processed, FALSE) = FALSE" in read["sql"]
    assert f"LEFT JOIN (SELECT * FROM `{HOME}.decisions` WHERE decided_at >= @queued_since" in read["sql"], "a decision already kept comes back with its item"
    assert "ORDER BY IF(d.decision_id IS NULL, 1, 0), IF(rq.trigger_path = 'MET_IN_CODE', 0, 1), rq.queued_at" in read["sql"], "what was started is finished first"
    assert read["sql"].rstrip().endswith("LIMIT @n")
    assert "author_vault_30d" not in read["sql"], "the vault is not read for the review"


# -- the decision --------------------------------------------------------------------------------------------------------
def test_a_candidate_the_review_turns_down_is_kept_and_not_raised(ctx, fake_llm, world):
    fake_llm.on("own.review", {"escalate": False, "severity": "P2", "escalation_path": "BRAND_SOCIAL", "decision_rationale": "One owner, no pattern."})
    queued(world, item(1))
    out = review.run(ctx)
    assert out == {"ok": True, "reviewed": 1, "raised": 0, "passed": 1, "failed": 0, "left": 0, "posted": 0, "error": ""}
    (row,) = inserted(world)
    assert row["queue_id"] == "q1" and row["escalate"] is False and row["decision_rationale"] == "One owner, no pattern."
    (doc,) = docs(ctx)
    assert doc["status"] == "passed" and doc["escalate"] is False and doc["outbox_id"] == "" and doc["id"] == row["decision_id"]
    assert ctx.store.list_outbox() == []


def test_a_mandatory_rule_cannot_be_overruled_and_its_severity_and_path_stand(ctx, fake_llm, world):
    fake_llm.on("own.review", {"escalate": False, "severity": "P2", "escalation_path": "BRAND_SOCIAL", "decision_rationale": "Looks routine to me."})
    queued(world, item(1, trigger="MET_IN_CODE", forced_severity="P0", forced_escalation_path="LEGAL"),
           item(2, trigger="MET_IN_CODE"), item(3, trigger="SINGLE_POST_GEMINI"))
    out = review.run(ctx)
    first, second, third = inserted(world)
    assert (first["escalate"], first["severity"], first["escalation_path"]) == (True, "P0", "LEGAL")
    assert (second["escalate"], second["severity"], second["escalation_path"]) == (True, "P2", "BRAND_SOCIAL"), "no forced values: the review's are used"
    assert third["escalate"] is False, "a candidate is the review's call"
    assert (out["raised"], out["passed"]) == (2, 1)


def test_a_severity_or_path_the_settings_do_not_list_falls_back(ctx, fake_llm, world):
    fake_llm.on("own.review", {"escalate": True, "severity": "CRITICAL", "escalation_path": "THE_CEO", "decision_rationale": "Bad."})
    queued(world, item(1))
    review.run(ctx)
    (row,) = inserted(world)
    assert (row["severity"], row["escalation_path"]) == ("P1", "BRAND_SOCIAL")


def test_the_reviewer_is_shown_the_rule_the_cleaned_evidence_and_the_guidelines(ctx, fake_llm, world):
    own = ctx.config.platform.own_alerts
    own.deep_model = "gemini-4-argon"
    queued(world, item(1), item(2, "STORY", "STORY_STAGE1_GEMINI"))
    review.run(ctx)
    single, story = [c for c in fake_llm.calls if c["purpose"] == "own.review"]
    assert single["model"] == "gemini-4-argon" and single["schema"] is review.Verdict
    assert own.doc_guidelines in single["system"] and own.discovery_guidelines in single["system"]
    assert "P0, P1, P2" in single["system"] and "EXEC_SECURITY, PR_COMMS, LEGAL, BRAND_SOCIAL" in single["system"]
    assert "Pixel battery swelling again, [PERSON_NAME] says" in single["prompt"] and "Recall or safety notice (4.2 Product safety)" in single["prompt"]
    assert "12 posts in 15 minutes, 3.2 times its hourly pace, 9 accounts, 15 in the last hour" in story["prompt"]
    assert "Several accounts report the same fault" in story["prompt"]
    for call in (single, story):
        assert "http" not in call["prompt"] and "@" not in call["prompt"]


# -- where the review runs -----------------------------------------------------------------------------------------------
class Session:
    def __init__(self, answer: Any = None, status: int = 200, down: bool = False):
        self.answer, self.status, self.down, self.calls = answer, status, down, []

    def post(self, url: str, json: dict[str, Any], timeout: float):
        self.calls.append({"url": url, "body": json, "timeout": timeout})
        if self.down:
            raise ConnectionError("no route to host")
        return Reply(self.status, self.answer)


class Reply:
    def __init__(self, status: int, data: Any):
        self.status_code, self._data, self.text = status, data, "permission denied"

    def json(self) -> Any:
        return self._data


def runtime(ctx, monkeypatch, session: Session) -> Session:
    ctx.config.platform.gcp.agent_runtime_resource = RESOURCE
    ctx.config.platform.own_alerts.review_engine = "agent_runtime"
    monkeypatch.setattr(agent_runtime, "session", lambda: session)
    return session


def test_the_review_is_asked_of_the_agent_runtime_first(ctx, fake_llm, world, monkeypatch):
    verdict = {"escalate": True, "severity": "P0", "escalation_path": "LEGAL", "decision_rationale": "Decided on the Agent Runtime."}
    session = runtime(ctx, monkeypatch, Session({"output": {"ok": True, "op": "review_own_candidate", "data": {"verdict": verdict}, "error": None}}))
    ctx.config.platform.own_alerts.runtime_timeout_seconds = 40
    queued(world, item(1))
    review.run(ctx)
    (call,) = session.calls
    assert call["url"] == f"https://us-central1-aiplatform.googleapis.com/v1/{RESOURCE}:query" and call["timeout"] == 40
    sent = call["body"]
    assert sent["class_method"] == "query" and sent["input"]["op"] == "review_own_candidate"
    assert sent["input"]["payload"]["item"]["evidence"] == "Pixel battery swelling again, [PERSON_NAME] says"
    assert sent["input"]["context"] == {"flow": "job", "invoked_by": "job:own_alerts", "deliver": "outbox"}
    (row,) = inserted(world)
    assert row["decision_rationale"] == "Decided on the Agent Runtime." and row["agent_engine_session"] == RESOURCE
    assert not [c for c in fake_llm.calls if c["purpose"] == "own.review"], "the worker asked nobody"
    assert docs(ctx)[0]["engine"] == "agent_runtime"


@pytest.mark.parametrize("session,why", [
    (Session(down=True), "could not be reached"),
    (Session({"error": "denied"}, status=403), "answered 403"),
    (Session({"output": {"ok": False, "op": "review_own_candidate", "data": {}, "error": "unknown operation: review_own_candidate"}}), "unknown operation"),
])
def test_the_worker_reviews_when_the_agent_runtime_cannot(ctx, fake_llm, world, monkeypatch, session, why):
    runtime(ctx, monkeypatch, session)
    queued(world, item(1))
    out = review.run(ctx)
    assert out["reviewed"] == 1 and out["ok"] is True
    (row,) = inserted(world)
    assert row["agent_engine_session"] == "worker" and row["decision_rationale"] == "A safety fault reported by several owners."
    (doc,) = docs(ctx)
    assert doc["engine"] == "worker" and why in doc["note"]


def test_with_the_worker_chosen_the_agent_runtime_is_never_asked(ctx, world, monkeypatch):
    session = runtime(ctx, monkeypatch, Session(down=True))
    ctx.config.platform.own_alerts.review_engine = "worker"
    queued(world, item(1))
    review.run(ctx)
    assert session.calls == [] and docs(ctx)[0]["note"] == ""


def test_an_item_whose_review_fails_stays_queued_and_the_rest_are_decided(ctx, fake_llm, world):
    def answer(call):
        if "second" in call["prompt"]:
            raise RuntimeError("the model timed out")
        return {"escalate": False, "severity": "P2", "escalation_path": "BRAND_SOCIAL", "decision_rationale": "Routine."}

    fake_llm.on("own.review", answer)
    queued(world, item(1), item(2, evidence="second post"), item(3))
    out = review.run(ctx)
    assert [r["queue_id"] for r in inserted(world)] == ["q1", "q3"]
    assert out["ok"] is False and out["failed"] == 1 and "the model timed out" in out["error"]


# -- what is written -----------------------------------------------------------------------------------------------------
def test_a_decision_is_written_once_with_its_numbers_and_the_queue_is_closed(ctx, world):
    queued(world, item(1), item(2, "STORY", "STORY_STAGE1_GEMINI"))
    review.run(ctx)
    insert = next(r for r in world.ran if r["sql"].startswith(f"INSERT INTO `{HOME}.decisions`"))
    assert f"WHERE NOT EXISTS (SELECT 1 FROM `{HOME}.decisions` x WHERE x.queue_id = fresh.queue_id" in insert["sql"]
    assert f"ML.GENERATE_EMBEDDING(\n    MODEL `{HOME}.embedding_model`" in insert["sql"] and "768 AS output_dimensionality" in insert["sql"]
    single, story = json.loads(insert["params"]["decided"])
    assert single == {
        "decision_id": single["decision_id"], "decided_at": ctx.now().isoformat(), "queue_id": "q1", "target_id": "post1", "item_type": "SINGLE_POST",
        "trigger_path": "SINGLE_POST_GEMINI", "escalate": True, "severity": "P1", "escalation_path": "PR_COMMS",
        "decision_rationale": "A safety fault reported by several owners.", "sanitized_evidence": "Pixel battery swelling again, [PERSON_NAME] says",
        "velocity_summary": "Gemini read it against the rule Recall or safety notice", "agent_engine_session": "worker"}
    assert story["velocity_summary"] == "12 posts in 15 minutes, 3.2 times its hourly pace, 9 accounts, 15 in the last hour"
    assert single["decision_id"] != story["decision_id"] and single["decision_id"].startswith("own-")
    memory = next(r for r in world.ran if r["sql"].startswith(f"UPDATE `{HOME}.stories`"))
    assert json.loads(memory["params"]["raised"]) == [{"story_id": "st-2", "at": ctx.now().isoformat(), "summary": "A safety fault reported by several owners."}]
    assert "last_alerted_at = TIMESTAMP(JSON_VALUE(r, '$.at'))" in memory["sql"]
    closed = world.ran[-1]
    assert closed["sql"].startswith(f"UPDATE `{HOME}.review_queue`") and "queue_id IN UNNEST(@done)" in closed["sql"], "the queue is closed last"
    assert closed["params"]["done"] == ["q1", "q2"] and len(docs(ctx)) == 2, "only what this run finished, once its record is kept"


def test_the_same_item_always_gets_the_same_decision_id(ctx, world):
    queued(world, item(1))
    review.run(ctx)
    first = inserted(world)[0]["decision_id"]
    world.ran.clear()
    review.run(ctx)
    assert inserted(world)[0]["decision_id"] == first, "a run repeated after a failure cannot raise the same item twice"


def test_a_decision_is_still_written_when_its_numbers_cannot_be_made(ctx, world):
    world.fail = "ML.GENERATE_EMBEDDING"
    queued(world, item(1))
    out = review.run(ctx)
    (plain,) = [r for r in world.ran if r["sql"].startswith(f"INSERT INTO `{HOME}.decisions`")]
    assert "ML.GENERATE_EMBEDDING" not in plain["sql"] and out["reviewed"] == 1 and out["ok"] is True
    assert len(docs(ctx)) == 1


def test_nothing_is_kept_for_the_console_when_bigquery_refuses_the_decision(ctx, world):
    world.fail = f"INSERT INTO `{HOME}.decisions`"
    queued(world, item(1))
    out = review.run(ctx)
    assert out["ok"] is False and "403 Access Denied" in out["error"] and docs(ctx) == [] and ctx.store.list_outbox() == []


def test_a_decision_kept_by_a_run_that_did_not_finish_is_raised_without_another_review(ctx, fake_llm, world):
    queued(world, kept(item(1, trigger="MET_IN_CODE")), kept(item(2), escalate=False))
    out = review.run(ctx)
    assert not [c for c in fake_llm.calls if c["purpose"] == "own.review"], "both were decided already"
    assert inserted(world) == [], "and BigQuery already holds the decisions"
    first, second = docs(ctx)
    assert (first["status"], first["severity"], first["path"], first["rationale"]) == ("raised", "P0", "LEGAL", "Decided before the run was cut short.")
    assert first["at"] == "2026-11-21T11:01:00+00:00" and first["id"] == review.decision_id("q1") and first["engine"] == "worker"
    assert second["status"] == "passed"
    assert (out["reviewed"], out["raised"], out["passed"]) == (2, 1, 1) and closes(world) == [["q1", "q2"]]


def test_an_alert_already_recorded_is_not_recorded_or_raised_twice(ctx, world):
    queued(world, item(1))
    review.run(ctx)
    before = docs(ctx)
    world.ran.clear()
    queued(world, kept(item(1)))  # the queue could not be closed: the item comes back with its decision
    out = review.run(ctx)
    assert docs(ctx) == before and len(ctx.events.query(types=["own.reviewed"])) == 1
    assert (out["reviewed"], out["raised"], out["posted"], out["ok"]) == (0, 0, 0, True) and closes(world) == [["q1"]], "it is closed this time"


def test_a_queue_that_cannot_be_closed_is_reported_and_the_decision_stands(ctx, world):
    world.fail = f"UPDATE `{HOME}.review_queue`"
    queued(world, item(1))
    out = review.run(ctx)
    assert out["ok"] is False and "403 Access Denied" in out["error"] and out["reviewed"] == 1
    assert len(docs(ctx)) == 1 and len(inserted(world)) == 1


def test_a_raised_story_stays_open_until_it_is_remembered_as_raised(ctx, world):
    world.fail = f"UPDATE `{HOME}.stories`"
    queued(world, item(2, "STORY", "STORY_STAGE1_GEMINI"))
    out = review.run(ctx)
    assert out["ok"] is False and "403 Access Denied" in out["error"]
    assert docs(ctx)[0]["status"] == "raised", "the alert stands"
    assert closes(world) == [], "the item comes back next minute, and the story is remembered then"


def test_a_run_stops_starting_reviews_when_its_time_is_up(ctx, clock, fake_llm, world):
    ctx.config.platform.own_alerts.review_seconds = 45

    def slow(call):
        clock.advance(seconds=20)
        return {"escalate": False, "severity": "P2", "escalation_path": "BRAND_SOCIAL", "decision_rationale": "Routine."}

    fake_llm.on("own.review", slow)
    queued(world, item(1), item(2), item(3), item(4))
    out = review.run(ctx)
    assert [r["queue_id"] for r in inserted(world)] == ["q1", "q2", "q3"], "the fourth would have started after 60 seconds"
    assert out["left"] == 1 and out["ok"] is True and closes(world) == [["q1", "q2", "q3"]]


def test_two_runs_never_review_at_once(ctx, world, monkeypatch):
    own = ctx.config.platform.own_alerts
    own.review_seconds, own.runtime_timeout_seconds = 30, 20
    asked = []
    real = ctx.store.claim_idempotent
    monkeypatch.setattr(ctx.store, "claim_idempotent", lambda key, ttl_s=120: asked.append((key, ttl_s)) or real(key, ttl_s=ttl_s))
    review.run(ctx)
    assert asked == [(review.LOCK, 30 + 2 * 20 + review.WRITE_SECONDS)], "the lock outlasts the run's time, one review in flight and the writes"
    assert real(review.LOCK, ttl_s=600), "it is let go when the run ends"
    world.ran.clear()
    assert review.run(ctx) == {"ok": True, "busy": True} and world.ran == []


def test_two_queue_items_for_one_story_are_reviewed_once(ctx, fake_llm, world):
    queued(world, item(1, "STORY", "STORY_STAGE1_GEMINI", target_id="st-9"), item(2, "STORY", "FOLLOWUP_SURGE", target_id="st-9"))
    out = review.run(ctx)
    assert len([c for c in fake_llm.calls if c["purpose"] == "own.review"]) == 1
    first, second = inserted(world)
    assert first["escalate"] is True and second["escalate"] is False and "same story" in second["decision_rationale"]
    assert out["raised"] == 1 and len(json.loads(next(r for r in world.ran if r["sql"].startswith(f"UPDATE `{HOME}.stories`"))["params"]["raised"])) == 1


# -- earlier verdicts ----------------------------------------------------------------------------------------------------
def test_earlier_verdicts_are_looked_up_only_once_one_has_been_given(ctx, fake_llm, world):
    queued(world, item(1))
    review.run(ctx)
    assert not [r for r in world.ran if "VECTOR_SEARCH" in r["sql"]]
    feedback.record(ctx, docs(ctx)[0]["id"], "TRUE_POSITIVE", ANALYST)
    world.ran.clear()
    world.answers.append(("VECTOR_SEARCH", [{"queue_id": "q2", "severity": "P0", "escalation_path": "LEGAL", "escalate": True,
                                             "decision_rationale": "Battery fire reports", "verdict": "TRUE_POSITIVE", "distance": 0.08}]))
    queued(world, item(2))
    review.run(ctx)
    lookup = next(r for r in world.ran if "VECTOR_SEARCH" in r["sql"])
    assert f"`{HOME}.feedback`" in lookup["sql"]
    assert "VECTOR_SEARCH(TABLE past_decisions, 'embedding', TABLE asked, 'embedding', top_k => 10, distance_type => 'COSINE')" in lookup["sql"]
    assert lookup["sql"].count("CREATE TEMP TABLE ") == 2, "BigQuery's search takes no join and no filter on the numbers: both tables are made just before it"
    assert lookup["sql"].count("ARRAY_LENGTH(") == 2 and lookup["sql"].count(") = 768") == 2, "only numbers of the length in use are compared"
    assert json.loads(lookup["params"]["items"]) == [{"queue_id": "q2", "evidence": "Pixel battery swelling again, [PERSON_NAME] says"}]
    prompt = [c for c in fake_llm.calls if c["purpose"] == "own.review"][-1]["prompt"]
    assert "[P0 LEGAL, raised, analyst: TRUE_POSITIVE] Battery fire reports" in prompt


def test_the_review_goes_on_without_earlier_verdicts_when_they_cannot_be_read(ctx, world):
    queued(world, item(1))
    review.run(ctx)
    feedback.record(ctx, docs(ctx)[0]["id"], "FALSE_POSITIVE", ANALYST)
    world.fail = "VECTOR_SEARCH"
    queued(world, item(2))
    assert review.run(ctx)["reviewed"] == 1


# -- the alert in Chat ---------------------------------------------------------------------------------------------------
@pytest.fixture
def posting(ctx, world):
    cfg = ctx.config.platform
    cfg.flags.own_alerts_post = True
    cfg.own_alerts.post_target = "team"
    cfg.gcp.console_url = "https://console.example.test"
    world.answers.append((VAULT, [
        {"kind": "SINGLE_POST", "target": "post1", "is_kof": True, "kof_display_label": "Jane Doe (@jdoe)", "post_url": "https://x.com/jdoe/status/9", "seen_at": "2026-11-21T11:00:00+00:00"},
        {"kind": "STORY", "target": "st-2", "is_kof": False, "kof_display_label": "Somebody Else (@else)", "post_url": "https://x.com/a/status/1", "seen_at": "2026-11-21T11:03:00+00:00"},
        {"kind": "STORY", "target": "st-2", "is_kof": False, "kof_display_label": None, "post_url": "https://www.reddit.com/r/pixel/comments/zz/", "seen_at": "2026-11-21T11:02:00+00:00"},
        {"kind": "STORY", "target": "st-2", "is_kof": False, "kof_display_label": None, "post_url": "", "seen_at": "2026-11-21T11:01:00+00:00"},
        {"kind": "STORY", "target": "st-2", "is_kof": False, "kof_display_label": None, "post_url": "https://x.com/b/status/2", "seen_at": "2026-11-21T11:00:30+00:00"},
        {"kind": "STORY", "target": "st-3", "is_kof": True, "kof_display_label": "Jane Doe (@jdoe)", "post_url": "https://x.com/jdoe/status/9", "seen_at": "2026-11-21T11:03:00+00:00"},
        {"kind": "STORY", "target": "st-3", "is_kof": False, "kof_display_label": None, "post_url": "https://x.com/c/status/3", "seen_at": "2026-11-21T11:02:00+00:00"},
        {"kind": "STORY", "target": "st-3", "is_kof": True, "kof_display_label": "Sam Poe (@spoe)", "post_url": "https://x.com/spoe/status/4", "seen_at": "2026-11-21T11:01:00+00:00"},
        {"kind": "STORY", "target": "st-3", "is_kof": True, "kof_display_label": "Jane Doe (@jdoe)", "post_url": "https://x.com/jdoe/status/5", "seen_at": "2026-11-21T11:00:00+00:00"},
    ]))
    return world


def test_a_raised_alert_is_queued_for_chat_with_the_name_and_link_from_the_vault(ctx, posting):
    queued(posting, item(1, trigger="MET_IN_CODE", forced_severity="P0", forced_escalation_path="LEGAL"))
    out = review.run(ctx)
    (post,) = ctx.store.list_outbox()
    (doc,) = docs(ctx)
    assert post.target == "team" and post.source == "own_alerts" and doc["outbox_id"] == post.outbox_id and out["posted"] == 1
    assert post.text == "\n".join([
        f"{ctx.config.agent.message_prefix} *Own alert* · P0 · LEGAL",
        "*Mandatory rule*: Recall or safety notice (4.2 Product safety)",
        "Pixel battery swelling again, [PERSON_NAME] says",
        "*Why*: A safety fault reported by several owners.",
        "*Author*: KOF, Jane Doe (@jdoe)",
        "<https://x.com/jdoe/status/9|Open the post>",
        f"<https://console.example.test/own-alerts?decision={doc['id']}&verdict=TRUE_POSITIVE|Confirm> · "
        f"<https://console.example.test/own-alerts?decision={doc['id']}&verdict=FALSE_POSITIVE|False positive>",
    ])
    assert doc["kof"] == "Jane Doe (@jdoe)" and doc["links"] == ["https://x.com/jdoe/status/9"]
    look = next(r for r in posting.ran if VAULT in r["sql"])
    assert look["params"]["posts"] == ["post1"] and look["params"]["stories"] == [""]
    assert look["sql"].rstrip().endswith("ORDER BY seen_at DESC"), "the newest link first"
    assert [e.payload["decision_id"] for e in ctx.events.query(types=["own.raised"])] == [doc["id"]]


def test_a_storys_alert_lists_its_posts_and_says_how_fast_it_grew(ctx, posting):
    ctx.config.platform.own_alerts.links_shown = 2
    queued(posting, item(2, "STORY", "STORY_STAGE1_GEMINI"))
    review.run(ctx)
    (post,) = ctx.store.list_outbox()
    lines = post.text.split("\n")
    assert lines[1] == "*Found by review*: no rule covers it"
    assert lines[2] == "12 posts in 15 minutes, 3.2 times its hourly pace, 9 accounts, 15 in the last hour"
    assert "*Authors*: none on the KOF list (details removed)" in lines, "a name kept beside a post that is not a KOF's is never shown"
    assert "• <https://x.com/a/status/1|post 1>" in lines and "• <https://www.reddit.com/r/pixel/comments/zz/|post 2>" in lines
    assert docs(ctx)[0]["links"] == ["https://x.com/a/status/1", "https://www.reddit.com/r/pixel/comments/zz/"], "the newest, up to the number shown"
    assert "post 3" not in post.text and docs(ctx)[0]["kof"] == ""


def test_a_storys_alert_names_each_kof_who_posted_in_it_once(ctx, posting):
    queued(posting, item(3, "STORY", "STORY_STAGE1_GEMINI"))
    review.run(ctx)
    (post,) = ctx.store.list_outbox()
    assert "*KOF in the story*: Jane Doe (@jdoe), Sam Poe (@spoe)" in post.text.split("\n")
    assert docs(ctx)[0]["kof"] == "Jane Doe (@jdoe), Sam Poe (@spoe)"


@pytest.mark.parametrize("change,why", [
    ({"switch": False}, ""),
    ({"target": ""}, ""),
    ({"target": "burson"}, "never posted in the source space"),
    ({"target": "team", "source": "team"}, "never posted in the source space"),
    ({"target": "nowhere"}, "is not one of the agent's spaces"),
])
def test_an_alert_is_not_posted_without_the_switch_a_space_or_into_the_source_space(ctx, posting, change, why):
    cfg = ctx.config.platform
    cfg.flags.own_alerts_post = change.get("switch", True)
    cfg.own_alerts.post_target = change.get("target", "team")
    source = ctx.config.space(change.get("source", "burson"))  # the space the Routing page names as the source, whatever the agent calls it
    cfg.routing.source = source.url or source.space_id
    queued(posting, item(1))
    out = review.run(ctx)
    (doc,) = docs(ctx)
    assert ctx.store.list_outbox() == [] and out["posted"] == 0 and out["raised"] == 1
    assert doc["status"] == "raised" and doc["outbox_id"] == "" and (why in doc["note"] if why else doc["note"] == "")
    assert doc["links"] == ["https://x.com/jdoe/status/9"], "the Console still shows the link"


def test_the_alert_carries_no_verdict_links_while_the_consoles_address_is_not_set(ctx, posting):
    ctx.config.platform.gcp.console_url = ""
    queued(posting, item(1))
    review.run(ctx)
    assert "verdict=" not in ctx.store.list_outbox()[0].text


def test_the_alerts_words_are_built_from_the_decision_alone():
    doc = {"id": "own-1", "severity": "P2", "path": "BRAND_SOCIAL", "trigger": "SINGLE_POST_GEMINI", "rule": "Outage words", "section": "",
           "item_type": "SINGLE_POST", "velocity": "Gemini read it against the rule Outage words", "evidence": "Search is down", "rationale": "Many reports.",
           "kof": "", "links": []}
    assert raise_.text_of(doc, prefix="", console_url="").split("\n") == [
        "*Own alert* · P2 · BRAND_SOCIAL", "*Rule*: Outage words", "Search is down", "*Why*: Many reports.",
        "*Author*: not on the KOF list (details removed)"]
    story = {**doc, "item_type": "STORY", "trigger": "FOLLOWUP_SURGE", "rule": "", "velocity": "40 posts in 15 minutes", "kof": "Jane Doe (@jdoe)",
             "links": ["https://x.com/a/status/1"]}
    assert raise_.text_of(story, prefix="[QA]", console_url="").split("\n") == [
        "[QA] *Own alert* · P2 · BRAND_SOCIAL", "*Follow-up*: a story already raised is growing again", "40 posts in 15 minutes", "Search is down",
        "*Why*: Many reports.", "*KOF in the story*: Jane Doe (@jdoe)", "• <https://x.com/a/status/1|post 1>"]
    other = {**doc, "trigger": "MET_IN_CODE", "rule": "", "section": ""}
    assert raise_.text_of(other, prefix="", console_url="").split("\n")[1] == "*Raised by another tool*: posted in the Other alerts space"


# -- an analyst's verdict ------------------------------------------------------------------------------------------------
def test_a_verdict_is_kept_in_bigquery_and_on_the_alert(ctx, world):
    queued(world, item(1))
    review.run(ctx)
    decision = docs(ctx)[0]["id"]
    doc = feedback.record(ctx, decision, "TRUE_POSITIVE", ANALYST)
    (row,) = world.rows_in("feedback")
    assert row == {"feedback_id": row["feedback_id"], "submitted_at": ctx.now().isoformat(), "decision_id": decision, "reviewer_email": ANALYST,
                   "verdict": "TRUE_POSITIVE"}
    assert (doc["verdict"], doc["verdict_by"], doc["verdict_at"]) == ("TRUE_POSITIVE", ANALYST, ctx.now().isoformat())
    (event,) = ctx.events.query(types=["own.feedback"])
    assert event.actor == ANALYST and event.payload == {"decision_id": decision, "verdict": "TRUE_POSITIVE", "severity": "P1", "path": "PR_COMMS"}
    feedback.record(ctx, decision, "FALSE_POSITIVE", "lead@ops.test")
    assert docs(ctx)[0]["verdict"] == "FALSE_POSITIVE" and len(world.rows_in("feedback")) == 2, "a changed verdict is a new row; the latest counts"


def test_a_verdict_that_is_not_one_of_the_two_or_names_no_alert_is_refused(ctx, world):
    queued(world, item(1))
    review.run(ctx)
    with pytest.raises(ValueError, match="TRUE_POSITIVE or FALSE_POSITIVE"):
        feedback.record(ctx, docs(ctx)[0]["id"], "MAYBE", ANALYST)
    with pytest.raises(LookupError):
        feedback.record(ctx, "own-nope", "TRUE_POSITIVE", ANALYST)
    assert world.rows_in("feedback") == []


def test_a_verdict_bigquery_refuses_is_not_shown_as_saved(ctx, world):
    queued(world, item(1))
    review.run(ctx)
    world.fail_insert = "feedback"
    with pytest.raises(RuntimeError):
        feedback.record(ctx, docs(ctx)[0]["id"], "TRUE_POSITIVE", ANALYST)
    assert docs(ctx)[0]["verdict"] == ""
