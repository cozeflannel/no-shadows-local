"""Agent alerts: no statement sent to BigQuery uses one of GoogleSQL's reserved words as a name, and none reads another
table once for each row in a way BigQuery refuses.

BigQuery refuses a statement whose alias, common table expression or parameter is a reserved word (ROWS, AT, FROM, TO).
It also refuses a subquery that reads another table for each row of the query around it ("Correlated subqueries that
reference other tables are not supported unless they can be de-correlated") when it cannot turn it into a join, and
one that keeps only the latest few rows (ORDER BY ... LIMIT) it never can: that stopped every run and every review on
the live project in November 2026. EXISTS and NOT EXISTS are turned into joins and are allowed.
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


_KEYWORDS = {"WHERE", "ON", "JOIN", "LEFT", "INNER", "CROSS", "GROUP", "ORDER", "QUALIFY", "SET", "WHEN", "USING", "AS", "SELECT", "LIMIT",
             "UNION", "AND", "OR", "THEN", "WITH"}


def _aliases(sql: str) -> set[str]:
    """The names a statement gives the tables and subqueries it reads (sql with quoted names already made TBL)."""
    found = set(re.findall(r"\b(?:FROM|JOIN|UPDATE|MERGE|INTO|USING)\s+(?:TBL|[A-Za-z_]\w*)\s+(?:AS\s+)?([A-Za-z_]\w*)", sql))
    found |= set(re.findall(r"\)\s+(?:AS\s+)?([A-Za-z_]\w*)(?=\s*(?:ON|USING|WHERE|JOIN|LEFT|INNER|CROSS|GROUP|ORDER|QUALIFY|WHEN|,|\)|$))", sql))
    return {a for a in found if a.upper() not in _KEYWORDS}


def per_row_reads(sql: str) -> list[str]:
    """Each subquery that reads a table and names a table of the query around it, other than under EXISTS."""
    bare = re.sub(r"'(?:[^'\\]|\\.)*'", "''", sql)
    bare = re.sub(r"--[^\n]*", "", re.sub(r"`[^`]*`", "TBL", bare))
    found = []
    for opened in re.finditer(r"\(\s*SELECT\b", bare):
        depth, end = 0, len(bare)
        for i in range(opened.start(), len(bare)):
            depth += {"(": 1, ")": -1}.get(bare[i], 0)
            if depth == 0:
                end = i
                break
        inner = bare[opened.start() + 1:end]
        if re.search(r"\bEXISTS\s*$", bare[:opened.start()]) or not re.search(r"\bFROM\s+(?!UNNEST\b)", inner):
            continue  # BigQuery turns EXISTS into a join; a subquery over an array of the row reads no other table
        around = _aliases(bare[:opened.start()] + bare[end + 1:]) - _aliases(inner)
        named = set(re.findall(r"(?<![\w.])([A-Za-z_]\w*)\.[A-Za-z_]", inner))
        if named & around:
            found.append(" ".join(inner.split())[:160])
    return found


def test_the_per_row_check_sees_the_subqueries_bigquery_refused():
    refused = ("SELECT s.story_id, CONCAT('x', (SELECT STRING_AGG(p.snippet, '|' ORDER BY p.at DESC LIMIT 8) FROM `p.d.posts` p "
               "WHERE p.story_id = s.story_id)) AS prompt FROM `p.d.stories` s")
    assert per_row_reads(refused) == ["SELECT STRING_AGG(p.snippet, '' ORDER BY p.at DESC LIMIT 8) FROM TBL p WHERE p.story_id = s.story_id"]
    joined = ("WITH latest AS (SELECT p.story_id, STRING_AGG(p.snippet, '|' ORDER BY p.at DESC LIMIT 8) AS snippets FROM `p.d.posts` p "
              "JOIN (SELECT DISTINCT target_id FROM `p.d.q` WHERE x = 1) w ON w.target_id = p.story_id GROUP BY p.story_id) "
              "SELECT s.story_id, l.snippets FROM `p.d.stories` s LEFT JOIN latest l ON l.story_id = s.story_id")
    allowed = ("INSERT INTO `p.d.q` (a) SELECT p.post_id FROM `p.d.posts` p WHERE NOT EXISTS (SELECT 1 FROM `p.d.q` q WHERE q.target_id = p.post_id) "
               "AND EXISTS (SELECT 1 FROM UNNEST(r.words) kw WHERE STRPOS(p.text, kw) > 0)")
    assert per_row_reads(joined) == [] and per_row_reads(allowed) == []


def test_the_check_itself_sees_each_kind_of_name():
    sql = "WITH rows AS (SELECT a AS at FROM `p.d.t` x) SELECT rows.a, x.b FROM rows WHERE c > @from AND d = 'AS to' AND e = CAST(NULL AS ARRAY<FLOAT64>)"
    assert names_in(sql) == {("table expression", "rows"), ("alias", "at"), ("start of a path", "rows"), ("start of a path", "x"), ("parameter", "from")}
    assert names_in("CREATE TEMP TABLE kept AS\n  SELECT 1 AS n; SELECT @@row_count AS n;") == {("alias", "n")}


def every_statement(ctx, fake_llm, monkeypatch) -> set[str]:
    """Every statement the code sends BigQuery in a set-up, a run, two reviews, the follow-up check, the deletes and the rules."""
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
    return {r["sql"] for r in gw.ran} | set(gw.refused)


def test_no_statement_names_anything_with_a_reserved_word(ctx, fake_llm, monkeypatch):
    statements = every_statement(ctx, fake_llm, monkeypatch)
    for start in ("CALL ", "CREATE OR REPLACE PROCEDURE", "CREATE TABLE IF NOT EXISTS", "INSERT INTO", "DELETE FROM", "MERGE ", "CREATE TEMP TABLE past_decisions",
                  f"UPDATE `{schema.table(ctx, 'stories')}`", f"UPDATE `{schema.table(ctx, 'review_queue')}`", "SELECT 'SINGLE_POST' AS kind"):
        assert any(sql.startswith(start) for sql in statements), f"no statement starting {start} was read"
    assert len(statements) >= 40
    bad = sorted((sql.split("\n")[0][:60], what, name) for sql in statements for what, name in names_in(sql) if name.upper() in RESERVED)
    assert bad == []


def test_no_statement_reads_another_table_once_for_each_row(ctx, fake_llm, monkeypatch):
    statements = every_statement(ctx, fake_llm, monkeypatch)
    assert any(sql.startswith("CREATE OR REPLACE PROCEDURE") for sql in statements) and any(QUEUE in sql for sql in statements)
    bad = sorted((sql.split("\n")[0][:60], found) for sql in statements for found in per_row_reads(sql))
    assert bad == [], "gather the rows first (a GROUP BY, or ROW_NUMBER() and QUALIFY) and join them on"
