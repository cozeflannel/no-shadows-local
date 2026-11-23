"""Own alerts: no statement sent to BigQuery uses one of GoogleSQL's reserved words as a name.

BigQuery refuses a statement whose alias, common table expression or parameter is a reserved word (ROWS, AT, FROM, TO).
Nothing here can be run against BigQuery from a test, so every statement the code builds is read instead: the objects'
set-up, a run of the job, a review, the follow-up check, the daily deletes and the rules.
"""

from __future__ import annotations

import re

from own_helpers import HOME, SONAR, row, set_up
from triage_agent.ownalerts import cycle, feedback, purge, review, rules, schema, surge

# The reserved keywords of GoogleSQL, from BigQuery's "Lexical structure and syntax" page.
RESERVED = set("""ALL AND ANY ARRAY AS ASC ASSERT_ROWS_MODIFIED AT BETWEEN BY CASE CAST COLLATE CONTAINS CREATE CROSS CUBE CURRENT DEFAULT DEFINE
DESC DISTINCT ELSE END ENUM ESCAPE EXCEPT EXCLUDE EXISTS EXTRACT FALSE FETCH FOLLOWING FOR FROM FULL GRAPH_TABLE GROUP GROUPING GROUPS HASH HAVING
IF IGNORE IN INNER INTERSECT INTERVAL INTO IS JOIN LATERAL LEFT LIKE LIMIT LOOKUP MERGE NATURAL NEW NO NOT NULL NULLS OF ON OR ORDER OUTER OVER
PARTITION PRECEDING PROTO QUALIFY RANGE RECURSIVE RESPECT RIGHT ROLLUP ROWS SELECT SET SOME STRUCT TABLESAMPLE THEN TO TREAT TRUE UNBOUNDED UNION
UNNEST USING WHEN WHERE WINDOW WITH WITHIN""".split())
QUEUE = f"FROM `{HOME}.review_queue` rq"


def names_in(sql: str) -> set[tuple[str, str]]:
    """Every name a statement gives something: (what it names, the name)."""
    bare = re.sub(r"'(?:[^'\\]|\\.)*'", "''", sql)  # what is inside a string is not a name
    bare = re.sub(r"`[^`]*`", "QUOTED", bare)       # a quoted name may be any word
    bare = re.sub(r"--[^\n]*", "", bare)
    bare = re.sub(r"\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:TEMP\s+)?TABLE\s+\S+\s+AS\b", "CREATE_TABLE_FROM", bare)  # ...AS SELECT names nothing
    found = {("alias", m.group(1)) for m in re.finditer(r"\bAS\s+([A-Za-z_]\w*)\b(?!\s*[(<])", bare)}
    found |= {("table expression", m.group(1)) for m in re.finditer(r"(?:\bWITH|,)\s+([A-Za-z_]\w*)\s+AS\s*\(", bare)}
    found |= {("start of a path", m.group(1)) for m in re.finditer(r"(?<![\w.@])([A-Za-z_]\w*)\.[A-Za-z_]", bare)}
    found |= {("parameter", m.group(1)) for m in re.finditer(r"(?<!@)@([A-Za-z_]\w*)", bare)}
    return found


def test_the_check_itself_sees_each_kind_of_name():
    sql = "WITH rows AS (SELECT a AS at FROM `p.d.t` x) SELECT rows.a, x.b FROM rows WHERE c > @from AND d = 'AS to' AND e = CAST(NULL AS ARRAY<FLOAT64>)"
    assert names_in(sql) == {("table expression", "rows"), ("alias", "at"), ("start of a path", "rows"), ("start of a path", "x"), ("parameter", "from")}
    assert names_in("CREATE TEMP TABLE kept AS\n  SELECT 1 AS n; SELECT @@row_count AS n;") == {("alias", "n")}


def test_no_statement_names_anything_with_a_reserved_word(ctx, fake_llm, monkeypatch):
    gw, _ = set_up(ctx, monkeypatch)
    cfg = ctx.config.platform
    cfg.flags.bigquery_admin = True
    gw.source_rows[SONAR] = [row(1), row(2)]
    cycle.run(ctx)  # creates the objects, reads the sources, stages what is new, calls the procedure
    fake_llm.on("own.review", {"escalate": True, "severity": "P1", "escalation_path": "PR_COMMS", "decision_rationale": "Several owners report it."})
    cfg.own_alerts.review_engine = "worker"
    cfg.flags.own_alerts_post, cfg.own_alerts.post_target = True, "team"
    ctx.store.put_kv(feedback.COUNT, {"n": 1})  # so the earlier verdicts are looked up
    gw.answers.append((QUEUE, [{"queue_id": "q1", "item_type": "SINGLE_POST", "target_id": "post1", "trigger_path": "SINGLE_POST_GEMINI", "evidence": "one"},
                               {"queue_id": "q2", "item_type": "STORY", "target_id": "st-1", "trigger_path": "STORY_STAGE1_GEMINI", "evidence": "two"}]))
    review.run(ctx)
    gw.fail = "ML.GENERATE_EMBEDDING(\n    MODEL"  # the decision is then written without its numbers: that statement is read too
    gw.answers = [(QUEUE, [{"queue_id": "q3", "item_type": "SINGLE_POST", "target_id": "post3", "trigger_path": "MET_IN_CODE", "evidence": "three"}])]
    review.run(ctx)
    gw.fail = ""
    surge.run(ctx)
    purge.run(ctx)
    rules.save(ctx, "ana.ruiz@roster.test", {"rule_name": "Recall", "process_doc_section": "4.2", "execution_mode": "HARD_MANDATE",
                                             "required_keywords_any": ["recall"], "forced_severity": "P0", "forced_escalation_path": "LEGAL"})
    rules.sync(ctx)
    statements = {r["sql"] for r in gw.ran} | set(gw.refused)
    for start in ("CALL ", "CREATE OR REPLACE PROCEDURE", "CREATE TABLE IF NOT EXISTS", "INSERT INTO", "DELETE FROM", "MERGE ", "CREATE TEMP TABLE past_decisions",
                  f"UPDATE `{schema.table(ctx, 'stories')}`", f"UPDATE `{schema.table(ctx, 'review_queue')}`", "SELECT 'SINGLE_POST' AS kind"):
        assert any(sql.startswith(start) for sql in statements), f"no statement starting {start} was read"
    assert len(statements) >= 40
    bad = sorted((sql.split("\n")[0][:60], what, name) for sql in statements for what, name in names_in(sql) if name.upper() in RESERVED)
    assert bad == []
