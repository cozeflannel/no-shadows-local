"""Own alerts' BigQuery objects: tables that expire, the pattern function, two remote models and the triage procedure.

BigQuery is replaced by a stand-in that records every statement (no network). The statements are the real ones;
these checks read them, because nothing here can be run against BigQuery from a test.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import pytest

from triage_agent import bq_admin
from triage_agent.ownalerts import schema, scrub

ROOT = Path(__file__).resolve().parents[1]
HOME = "proj.slrr_triage_agent"
CONNECTION = "proj.US.slrr_vertex_conn"
KEPT_AS_POSTS = ("author_vault_30d", "posts", "post_metrics", "stories", "review_queue")


class BigQuery:
    project = "proj"

    def __init__(self, fail: str = ""):
        self.ran: list[dict[str, Any]] = []
        self.fail = fail

    def query(self, sql: str, params: dict[str, Any] | None = None, *, location: str | None = None, max_rows: int = 10000, labels=None):
        if self.fail and self.fail in sql:
            raise RuntimeError("400 Syntax error: Unexpected keyword at [3:1]")
        self.ran.append({"sql": sql, "params": dict(params or {}), "location": location, "labels": labels})
        return []


@pytest.fixture
def own(ctx):
    cfg = ctx.config.platform
    cfg.bigquery.dataset, cfg.bigquery.location = HOME, "US"
    cfg.own_alerts.ai_connection = CONNECTION
    return cfg.own_alerts


@pytest.fixture
def bq(ctx, own, monkeypatch) -> BigQuery:
    gw = BigQuery()
    monkeypatch.setattr(bq_admin, "get_gateway", lambda c: gw)
    return gw


def sql_of(ctx, what: str) -> str:
    return next(s["sql"] for s in schema.statements(ctx) if s["what"] == what)


def everything(ctx) -> str:
    return "\n;\n".join(s["sql"] for s in schema.statements(ctx))


def test_nothing_is_built_without_a_dataset_or_a_connection(ctx):
    with pytest.raises(ValueError, match="dataset"):
        schema.statements(ctx)
    ctx.config.platform.bigquery.dataset = HOME
    with pytest.raises(ValueError, match="connection"):
        schema.statements(ctx)
    ctx.config.platform.own_alerts.ai_connection = "just-a-name"
    with pytest.raises(ValueError, match="project.location.name"):
        schema.statements(ctx)


def test_every_table_that_holds_posts_expires_and_never_after_thirty_days(ctx, own):
    for name in schema.TABLES:
        sql = sql_of(ctx, f"table {name}")
        assert sql.startswith(f"CREATE TABLE IF NOT EXISTS `{HOME}.{name}`") and "PARTITION BY DATE(" in sql
        days = int(re.search(r"partition_expiration_days = (\d+)", sql).group(1))
        assert days == (1 if name == "posts_staging" else 90 if name in ("decisions", "feedback") else 30), name
    own.keep_days, own.decisions_keep_days = 7, 45
    for name in KEPT_AS_POSTS:
        assert "partition_expiration_days = 7," in sql_of(ctx, f"table {name}")
    assert "partition_expiration_days = 1," in sql_of(ctx, "table posts_staging")
    assert "partition_expiration_days = 45," in sql_of(ctx, "table decisions")


def test_a_changed_number_of_days_reaches_a_table_that_already_exists(ctx, own):
    own.keep_days = 10
    for name in KEPT_AS_POSTS:
        assert sql_of(ctx, f"days {name} is kept") == f"ALTER TABLE `{HOME}.{name}` SET OPTIONS (partition_expiration_days = 10)"


def test_the_vault_holds_the_link_and_the_kof_name_and_posts_hold_neither(ctx, own):
    vault = sql_of(ctx, "table author_vault_30d")
    assert "kof_display_label STRING" in vault and "post_url STRING" in vault
    for name in ("posts", "posts_staging", "stories", "review_queue", "decisions"):
        sql = sql_of(ctx, f"table {name}")
        assert "url" not in sql.lower() and "kof_display_label" not in sql and "author STRING" not in sql and "handle" not in sql.lower(), name
    assert "author_hash STRING" in sql_of(ctx, "table posts")


def test_no_statement_drops_or_replaces_a_table_or_touches_the_events_table(ctx, own):
    sql = everything(ctx)
    for banned in ("DROP ", "TRUNCATE", "CREATE OR REPLACE TABLE", "DELETE FROM", "agent_events", " VIEW "):
        assert banned not in sql, banned
    views = re.findall(r"VIEW `[^`]*\.(\w+)`", (ROOT / "analytics" / "02_metric_views.sql").read_text())
    assert len(views) >= 5 and not [v for v in views if re.search(rf"\b{v}\b", sql)], "no metric view is named"


def test_every_object_named_is_in_the_agents_dataset(ctx, own):
    names = set(re.findall(r"`([^`]+)`", everything(ctx)))
    assert CONNECTION in names
    outside = sorted(n for n in names if n != CONNECTION and not n.startswith(HOME + "."))
    assert outside == [], "no source table, and nothing in another dataset, is named"


def test_the_pattern_function_is_built_from_the_patterns_the_job_uses(ctx, own):
    sql = sql_of(ctx, f"function {schema.FUNCTION}")
    at = -1
    for _, pattern, put in scrub.PATTERNS:
        here = sql.index(f"r'{pattern}', r'{put}'")
        assert here > at, "in the same order"
        at = here
    assert sql.rstrip().endswith("), 500)\n)")
    own.snippet_chars = 300
    assert "), 300)" in sql_of(ctx, f"function {schema.FUNCTION}")


def test_the_two_models_use_the_connection_and_the_names_from_settings(ctx, own):
    own.embedding_endpoint, own.fast_endpoint = "gemini-embedding-001", "gemini-4-hydrogen"
    assert sql_of(ctx, "model embedding_model") == (
        f"CREATE OR REPLACE MODEL `{HOME}.embedding_model`\nREMOTE WITH CONNECTION `{CONNECTION}`\nOPTIONS (endpoint = 'gemini-embedding-001')")
    assert "OPTIONS (endpoint = 'gemini-4-hydrogen')" in sql_of(ctx, "model gemini4_fast_decisions")
    assert [s["what"] for s in schema.statements(ctx) if s["what"].startswith("model ")] == ["model embedding_model", "model gemini4_fast_decisions"]
    own.fast_endpoint = "gemini'); DROP"
    with pytest.raises(ValueError, match="not allowed"):
        schema.statements(ctx)


def procedure(ctx) -> str:
    return sql_of(ctx, f"procedure {schema.PROCEDURE}")


def test_the_procedure_reads_only_what_the_job_staged(ctx, own):
    sql = procedure(ctx)
    assert f"FROM `{HOME}.posts_staging`" in sql
    for source in ("sonar_raw", "tubular", "brandwatch_raw", "sprinklr", "DSD", "all_sundar_mentions", "TO_JSON_STRING", "JSON_VALUE"):
        assert source not in sql, source
    assert f"`{HOME}.fast_regex_sanitize`(S.sanitized_snippet)" in sql, "the pattern runs again as a post is kept"


def test_the_procedure_checks_every_condition_a_rule_can_set(ctx, own):
    sql = procedure(ctx)
    for part in ("r.target_sources", "r.platforms", "r.require_kof", "r.min_followers", "r.min_engagements", "r.required_keywords_any",
                 "r.required_keywords_all", "r.excluded_keywords", "r.active = TRUE"):
        assert part in sql, part
    assert "WHEN m.execution_mode = 'HARD_MANDATE' THEN 'MET_IN_CODE'" in sql
    assert "WHEN other_alerts_mandatory AND p.source_system = other_alerts_source THEN 'MET_IN_CODE'" in sql


def test_a_post_sent_straight_to_review_is_queued_once(ctx, own):
    sql = procedure(ctx)
    assert "AND NOT EXISTS (SELECT 1 FROM `proj.slrr_triage_agent.review_queue` q WHERE q.queued_at >= pending_ts AND q.target_id = p.post_id AND q.trigger_path = 'MET_IN_CODE')" in sql


def test_every_post_no_rule_covers_gets_its_numbers(ctx, own):
    sql = procedure(ctx)
    assert "ARRAY_LENGTH(embedding) IS NULL" not in sql, "never true for a stored column: no post would be embedded"
    assert "IFNULL(ARRAY_LENGTH(embedding), 0) = 0" in sql
    own.embedding_dimensions = 1536
    assert "1536 AS output_dimensionality" in procedure(ctx)


def test_new_posts_on_one_theme_start_one_story_together(ctx, own):
    own.neighbours = 35
    sql = procedure(ctx)
    assert "SET story_id = CONCAT('st-', started.leader)" in sql and "top_k => 35, distance_type => 'COSINE'" in sql
    assert sql.index("SET story_id = matched.story_id") < sql.index("SET story_id = CONCAT('st-', started.leader)"), "a running story is joined first"


def test_each_search_for_the_nearest_reads_tables_made_just_before_it(ctx, own):
    """BigQuery's VECTOR_SEARCH takes a base table, or a query with SELECT, FROM and WHERE only and no filter on the numbers.
    Each search here reads temporary tables the procedure makes first, where posts and stories without usable numbers are left out."""
    own.embedding_dimensions = 512
    sql = procedure(ctx)
    searches = re.findall(r"VECTOR_SEARCH\((.*?)top_k", sql, re.S)
    assert [" ".join(found.split()) for found in searches] == [
        "TABLE running_stories, 'centroid_embedding', TABLE unplaced, 'embedding',",
        "TABLE still_unplaced, 'embedding', TABLE still_unplaced, 'embedding',",
    ]
    for name, column in (("unplaced", "embedding"), ("running_stories", "centroid_embedding")):
        made = sql[sql.index(f"CREATE TEMP TABLE {name} AS"):]
        made = made[:made.index(";")]
        assert f"ARRAY_LENGTH({column}) = 512" in made, "numbers of another length (an older model or setting) are never compared"
        assert sql.index(f"CREATE TEMP TABLE {name} AS") < sql.index("VECTOR_SEARCH(")
    again = sql[sql.index("CREATE TEMP TABLE still_unplaced AS"):]
    assert "story_id IS NULL" in again[:again.index(";")], "only posts the first search left without a story look for each other"
    assert sql.index("SET story_id = matched.story_id") < sql.index("CREATE TEMP TABLE still_unplaced AS") < sql.index("started.leader")


def test_a_story_is_asked_about_once_per_cool_down_unless_it_grew(ctx, own):
    own.story_snippets = 5
    sql = procedure(ctx)
    assert "s.last_alerted_at IS NULL OR s.last_alerted_at < TIMESTAMP_SUB(run_ts, INTERVAL cooldown_mins MINUTE)" in sql
    assert "OR s.post_count_15m >= IFNULL(s.last_triaged_posts, 0) * regrowth" in sql
    assert "SET last_triaged_at = run_ts, last_triaged_posts = c.post_count_15m" in sql
    assert "LIMIT 5)" in sql


def test_the_call_passes_every_parameter_the_procedure_declares_in_order(ctx, own):
    sql = procedure(ctx)
    header = sql[sql.index("(") + 1: sql.index("BEGIN")]
    declared = re.findall(r"(\w+) (?:STRING|FLOAT64|INT64|BOOL)", header)
    assert declared == [name for name, _ in schema.PARAMS]
    call, params = schema.call(ctx, "other_alerts")
    assert call == f"CALL `{HOME}.run_9source_triage_cycle`(" + ", ".join(f"@{n}" for n in declared) + ")"
    assert list(params) == declared
    assert params["cos_threshold"] == 0.22 and params["min_story_posts"] == 3 and params["cooldown_mins"] == 120
    assert params["single_min_score"] == 0.65 and params["other_alerts_source"] == "other_alerts" and params["other_alerts_mandatory"] is True
    assert params["doc_guidelines"] == own.doc_guidelines and isinstance(params["regrowth"], float)


def test_the_procedure_is_one_balanced_block(ctx, own):
    sql = procedure(ctx)
    assert sql.count("(") == sql.count(")") and sql.count("BEGIN") == 1 and sql.rstrip().endswith("END")
    opened = re.findall(r"^\s+IF [^;]*? THEN$", sql, re.M | re.S)
    assert len(opened) == 2 == len(re.findall(r"\bEND IF;", sql)), "every IF block is closed"


def test_the_version_follows_what_the_statements_say(ctx, own):
    first = schema.version(ctx)
    own.interval_minutes = 9
    assert schema.version(ctx) == first, "a setting no statement uses changes nothing"
    own.fast_endpoint = "gemini-4-neon"
    assert schema.version(ctx) != first


def test_nothing_is_created_while_the_bigquery_switch_is_off(ctx, own, bq):
    with pytest.raises(bq_admin.NotAllowed):
        schema.provision(ctx)
    assert bq.ran == [] and not schema.current(ctx)


def test_set_up_runs_every_statement_in_the_datasets_location_and_remembers_it(ctx, own, bq):
    ctx.config.platform.flags.bigquery_admin = True
    steps = schema.provision(ctx)
    wanted = schema.statements(ctx)
    assert [r["sql"] for r in bq.ran] == [s["sql"] for s in wanted]
    assert {r["location"] for r in bq.ran} == {"US"} and all(r["labels"] == schema.LABELS for r in bq.ran)
    assert [s["step"] for s in steps] == [s["what"] for s in wanted] and all(s["ok"] for s in steps)
    assert schema.current(ctx)
    own.keep_days = 9
    assert not schema.current(ctx), "a changed setting means the objects are out of date"


def test_a_statement_bigquery_refuses_stops_set_up_and_is_named(ctx, own, monkeypatch):
    gw = BigQuery(fail="CREATE OR REPLACE PROCEDURE")
    monkeypatch.setattr(bq_admin, "get_gateway", lambda c: gw)
    ctx.config.platform.flags.bigquery_admin = True
    with pytest.raises(RuntimeError, match="procedure run_9source_triage_cycle: 400 Syntax error"):
        schema.provision(ctx)
    assert not schema.current(ctx)
