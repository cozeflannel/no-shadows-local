"""The review: each post or story BigQuery queued is looked at once more before it becomes an alert.

It runs every minute in the worker. The Agent Runtime is asked first (the operation `review_own_candidate`, the same
code deployed there); when it cannot be reached or does not answer, the worker runs the operation itself. The
reviewer sees the cleaned evidence, the rule, how fast a story is growing, and the earlier decisions most like this
one with what the analysts said about them. It never sees a link, a handle or a name.

The hard-rule lock: a post that met a mandatory rule is raised whatever the review answers, with the severity and
path the rule sets.

A run can be cut short at any point without losing an alert or raising one twice. The decision is written to
BigQuery first, once (the same queue item always gets the same decision id). Then its record is kept for the Console
and the alert is queued for Chat (raise_). The queue item is closed last. An item that is still open comes back the
next minute with the decision BigQuery holds: it is not reviewed again, and whatever was left undone is done.
"""

from __future__ import annotations

import hashlib
import json
from datetime import timedelta
from typing import TYPE_CHECKING, Any

from pydantic import BaseModel, Field

from ..events import PlatformEvent
from ..models import ChatOutputs, RequestContext
from ..operations import operation
from . import SNIPPET_BREAK, SWITCH, feedback, raise_, schema

if TYPE_CHECKING:
    from ..context import AgentContext

OP = "review_own_candidate"
PURPOSE = "own.review"
DECISIONS = "own_decisions"  # the Console's record of each decision
STATE = "own:review"         # {last, error, result}
LOCK = "own:review:run"
WRITE_SECONDS = 120          # the time BigQuery's writes are given after the last review, before another run may start
LISTED = 500                 # the most decisions the Console lists at once
CONTEXT = {"flow": "job", "invoked_by": "job:own_alerts", "deliver": "outbox"}
FIELDS = ("decision_id", "decided_at", "queue_id", "target_id", "item_type", "trigger_path", "escalate", "severity", "escalation_path",
          "decision_rationale", "sanitized_evidence", "velocity_summary", "agent_engine_session")
COUNTS = ("reviewed", "raised", "passed", "failed", "left", "posted")  # left: not started this run


class Verdict(BaseModel):
    escalate: bool = Field(..., description="True when the team should be alerted.")
    severity: str = Field("", description="One of the severities listed in the instructions.")
    escalation_path: str = Field("", description="One of the paths listed in the instructions.")
    decision_rationale: str = Field("", description="Two sentences at most. Names no person and quotes no link.")


# ---------------------------------------------------------------------------------------------------------------
# The reviewer (runs on the Agent Runtime, or in the worker)
# ---------------------------------------------------------------------------------------------------------------

def _system(ctx: "AgentContext") -> str:
    own = ctx.config.platform.own_alerts
    return (
        "You are the SLRR Triage Agent performing the second-stage brand safety review of one candidate alert.\n"
        f"Process document mandates: {own.doc_guidelines}\n"
        f"Discovery guidelines: {own.discovery_guidelines}\n"
        "Decide whether the team should be alerted (escalate).\n"
        f"severity: one of {', '.join(own.severities)}, the most severe first.\n"
        f"escalation_path: one of {', '.join(own.escalation_paths)}.\n"
        "decision_rationale: two sentences at most, in plain words, for a busy incident manager.\n"
        "The evidence has had personal details removed. Name no person and quote no link.\n"
        "A candidate that met a mandatory rule is raised whatever you answer; still give its severity, path and reason.\n"
        "Earlier decisions like this one are given with what an analyst said about each: weigh them."
    )


def _prompt(item: dict[str, Any], precedents: list[str]) -> str:
    lines = [f"<candidate type=\"{item.get('item_type')}\" trigger=\"{item.get('trigger_path')}\">"]
    if item.get("rule_name"):
        section = f" ({item['process_doc_section']})" if item.get("process_doc_section") else ""
        lines.append(f"Rule: {item['rule_name']}{section}")
    lines.append(f"Signal: {item.get('velocity_summary') or ''}")
    if item.get("stage1_rationale"):
        lines.append(f"First pass: {item['stage1_rationale']}")
    if item.get("item_type") != "STORY":
        lines.append(f"Author: KOF tier {item.get('kof_tier') or 'NON_KOF'}, {int(item.get('author_followers') or 0)} followers")
    if item.get("story_summary"):
        lines.append(f"Raised before: {item['story_summary']}")
    lines += ["Evidence (personal details removed):", str(item.get("evidence") or ""), "</candidate>"]
    if precedents:
        lines += ["<earlier_decisions>", *precedents, "</earlier_decisions>"]
    return "\n".join(lines)


def judge(ctx: "AgentContext", item: dict[str, Any], precedents: list[str]) -> Verdict:
    own = ctx.config.platform.own_alerts
    return ctx.llm.generate_json(model=own.deep_model, system=_system(ctx), prompt=_prompt(item, precedents), schema=Verdict, temperature=0.1,
                                 purpose=PURPOSE)


@operation(OP)
def review_own_candidate(ctx: "AgentContext", payload: dict[str, Any], rc: RequestContext):
    """One candidate's review. payload: {item, precedents}. Answers data.verdict."""
    verdict = judge(ctx, dict(payload.get("item") or {}), [str(p) for p in payload.get("precedents") or []])
    return ChatOutputs(summary=f"agent alerts review: {'raise' if verdict.escalate else 'pass over'}"), {"verdict": verdict.model_dump()}


def ask(ctx: "AgentContext", item: dict[str, Any], precedents: list[str]) -> tuple[Verdict, str, str]:
    """(the verdict, where it was decided: agent_runtime | worker, why the Agent Runtime was not used)."""
    from .. import agent_runtime
    from ..operations import handle

    cfg = ctx.config.platform
    payload = {"item": item, "precedents": precedents}
    why = ""
    if cfg.own_alerts.review_engine == "agent_runtime":
        try:
            out = agent_runtime.query(ctx, OP, payload, dict(CONTEXT), timeout=cfg.own_alerts.runtime_timeout_seconds)
            if out.get("ok") and isinstance((out.get("data") or {}).get("verdict"), dict):
                return Verdict.model_validate(out["data"]["verdict"]), "agent_runtime", ""
            why = f"The Agent Runtime did not review it ({out.get('error') or 'no verdict in its answer'}); the worker did."
        except agent_runtime.Unreachable as exc:
            why = f"{exc}; the worker reviewed it."
    resp = handle({"op": OP, "payload": payload, "context": dict(CONTEXT)}, ctx)
    if not resp.ok:
        raise RuntimeError(resp.error or "the review failed")
    return Verdict.model_validate(resp.data["verdict"]), "worker", why


# ---------------------------------------------------------------------------------------------------------------
# What is waiting, and what was decided before
# ---------------------------------------------------------------------------------------------------------------

def _pending(ctx: "AgentContext", gw: Any) -> list[dict[str, Any]]:
    """The open queue items, each with its rule, its evidence, its story's pace and, when a run already decided it
    and did not finish, the decision BigQuery holds (kept_*). Those come first."""
    own = ctx.config.platform.own_alerts
    q, r, s, p, d = (schema.table(ctx, n) for n in ("review_queue", "policy_rules_config", "stories", "posts", "decisions"))
    sql = (
        "SELECT rq.queue_id, rq.queued_at, rq.item_type, rq.target_id, rq.trigger_path, rq.matched_rule_id, rq.stage1_rank_score, rq.stage1_rationale,\n"
        "  r.rule_name, r.process_doc_section, r.forced_severity, r.forced_escalation_path,\n"
        "  IF(rq.item_type = 'STORY',\n"
        f"     (SELECT STRING_AGG(x.sanitized_snippet, '{SNIPPET_BREAK}' ORDER BY x.ingested_at DESC LIMIT {own.story_snippets}) FROM `{p}` x\n"
        "      WHERE x.story_id = rq.target_id AND x.ingested_at >= @since),\n"
        "     pp.sanitized_snippet) AS evidence,\n"
        "  s.post_count_15m, s.post_count_1h, s.unique_authors_15m, s.velocity_ratio_15m, s.story_summary,\n"
        "  pp.source_system, pp.platform, pp.kof_tier, pp.is_kof, pp.author_followers,\n"
        "  d.decision_id AS kept_id, d.decided_at AS kept_at, d.escalate AS kept_escalate, d.severity AS kept_severity, d.escalation_path AS kept_path,\n"
        "  d.decision_rationale AS kept_rationale, d.sanitized_evidence AS kept_evidence, d.velocity_summary AS kept_velocity,\n"
        "  d.agent_engine_session AS kept_session\n"
        f"FROM `{q}` rq\n"
        f"LEFT JOIN `{r}` r ON r.rule_id = rq.matched_rule_id\n"
        f"LEFT JOIN `{s}` s ON rq.item_type = 'STORY' AND s.story_id = rq.target_id\n"
        f"LEFT JOIN `{p}` pp ON rq.item_type != 'STORY' AND pp.post_id = rq.target_id AND pp.ingested_at >= @since\n"
        f"LEFT JOIN (SELECT * FROM `{d}` WHERE decided_at >= @queued_since\n"
        "           QUALIFY ROW_NUMBER() OVER (PARTITION BY queue_id ORDER BY decided_at) = 1) d ON d.queue_id = rq.queue_id\n"
        "WHERE rq.queued_at >= @queued_since AND IFNULL(rq.processed, FALSE) = FALSE\n"
        "ORDER BY IF(d.decision_id IS NULL, 1, 0), IF(rq.trigger_path = 'MET_IN_CODE', 0, 1), rq.queued_at\nLIMIT @n")
    now = ctx.now()
    return gw.query(sql, {"since": now - timedelta(days=own.keep_days), "queued_since": now - timedelta(hours=own.catch_up_hours),
                          "n": own.reviews_per_minute},
                    location=ctx.config.platform.bigquery.location or None, max_rows=own.reviews_per_minute, labels=schema.LABELS)


def _precedents(ctx: "AgentContext", gw: Any, items: list[dict[str, Any]]) -> dict[str, list[str]]:
    """queue id -> the earlier decisions most like it that an analyst gave a verdict on, the closest first.

    BigQuery's VECTOR_SEARCH takes a table, or a query with no join and no filter on the numbers. So the decisions that
    have a verdict, and the numbers of what is being reviewed, are each put in a temporary table first."""
    own = ctx.config.platform.own_alerts
    if not own.precedents or not items or not feedback.given(ctx):
        return {}
    d, f, model = schema.table(ctx, "decisions"), schema.table(ctx, "feedback"), schema.table(ctx, schema.EMBEDDING_MODEL)
    sql = (
        "CREATE TEMP TABLE past_decisions AS\n"
        "SELECT d.decision_id, d.severity, d.escalation_path, d.escalate, d.decision_rationale, f.verdict, d.embedding\n"
        f"FROM `{d}` d\n"
        f"JOIN (SELECT decision_id, ARRAY_AGG(verdict ORDER BY submitted_at DESC LIMIT 1)[OFFSET(0)] AS verdict FROM `{f}`\n"
        "      WHERE submitted_at >= @since GROUP BY decision_id) f ON f.decision_id = d.decision_id\n"
        f"WHERE d.decided_at >= @since AND ARRAY_LENGTH(d.embedding) = {own.embedding_dimensions};\n"
        "CREATE TEMP TABLE asked AS\n"
        "SELECT queue_id, ml_generate_embedding_result AS embedding\n"
        "FROM ML.GENERATE_EMBEDDING(\n"
        f"  MODEL `{model}`,\n"
        "  (SELECT JSON_VALUE(r, '$.queue_id') AS queue_id, JSON_VALUE(r, '$.evidence') AS content FROM UNNEST(JSON_QUERY_ARRAY(@items)) r),\n"
        f"  STRUCT(TRUE AS flatten_json_output, 'SEMANTIC_SIMILARITY' AS task_type, {own.embedding_dimensions} AS output_dimensionality))\n"
        f"WHERE ARRAY_LENGTH(ml_generate_embedding_result) = {own.embedding_dimensions};\n"
        "SELECT query.queue_id AS queue_id, base.severity, base.escalation_path, base.escalate, base.decision_rationale, base.verdict, distance\n"
        f"FROM VECTOR_SEARCH(TABLE past_decisions, 'embedding', TABLE asked, 'embedding', top_k => {own.precedents}, distance_type => 'COSINE')\n"
        "ORDER BY queue_id, distance;")
    try:
        rows = gw.query(sql, {"since": ctx.now() - timedelta(days=own.precedent_days),
                              "items": json.dumps([{"queue_id": i["queue_id"], "evidence": i.get("evidence") or ""} for i in items])},
                        location=ctx.config.platform.bigquery.location or None, max_rows=2000, labels=schema.LABELS)
    except Exception:  # noqa: BLE001 - the review goes on without them
        return {}
    out: dict[str, list[str]] = {}
    for row in rows:
        said = "raised" if row.get("escalate") else "passed over"
        out.setdefault(str(row["queue_id"]), []).append(
            f"[{row.get('severity')} {row.get('escalation_path')}, {said}, analyst: {row.get('verdict')}] {row.get('decision_rationale') or ''}")
    return out


def velocity_of(item: dict[str, Any]) -> str:
    """Why this item is in front of the reviewer, in a line."""
    if item.get("item_type") == "STORY":
        pace = f"{round(float(item.get('velocity_ratio_15m') or 0), 2):g}"
        line = (f"{int(item.get('post_count_15m') or 0)} posts in 15 minutes, {pace} times its hourly pace, "
                f"{int(item.get('unique_authors_15m') or 0)} accounts, {int(item.get('post_count_1h') or 0)} in the last hour")
        return line + " (a raised story that is growing again)" if item.get("trigger_path") == "FOLLOWUP_SURGE" else line
    rule = item.get("rule_name")
    if item.get("trigger_path") == "MET_IN_CODE":
        return f"It meets the mandatory rule {rule}" if rule else "Another tool raised it in the Other alerts space"
    return f"Gemini read it against the rule {rule}" if rule else "Gemini read it"


def decision_id(queue_id: str) -> str:
    """The same queue item always gets the same id, so a run repeated after a failure cannot raise it twice."""
    return "own-" + hashlib.sha1(queue_id.encode()).hexdigest()[:20]  # an id, not a secret


def decide(own: Any, item: dict[str, Any], verdict: Verdict) -> tuple[bool, str, str]:
    """The hard-rule lock: (escalate, severity, path)."""
    escalate = True if item.get("trigger_path") == "MET_IN_CODE" else bool(verdict.escalate)
    severity = item.get("forced_severity") or (verdict.severity if verdict.severity in own.severities else "") or own.default_severity
    path = (item.get("forced_escalation_path") or (verdict.escalation_path if verdict.escalation_path in own.escalation_paths else "")
            or own.default_path)
    return escalate, severity, path


# ---------------------------------------------------------------------------------------------------------------
# Writing the decisions
# ---------------------------------------------------------------------------------------------------------------

def _insert_sql(ctx: "AgentContext", with_numbers: bool) -> str:
    own = ctx.config.platform.own_alerts
    d, model = schema.table(ctx, "decisions"), schema.table(ctx, schema.EMBEDDING_MODEL)
    text = ("decision_id", "queue_id", "target_id", "item_type", "trigger_path", "severity", "escalation_path", "decision_rationale",
            "sanitized_evidence", "velocity_summary", "agent_engine_session")
    parsed = ",\n         ".join([*(f"JSON_VALUE(r, '$.{c}') AS {c}" for c in text), "TIMESTAMP(JSON_VALUE(r, '$.decided_at')) AS decided_at",
                                  "JSON_VALUE(r, '$.escalate') = 'true' AS escalate"])
    numbers = (
        "LEFT JOIN (\n  SELECT decision_id, ml_generate_embedding_result\n  FROM ML.GENERATE_EMBEDDING(\n"
        f"    MODEL `{model}`,\n    (SELECT decision_id, sanitized_evidence AS content FROM fresh),\n"
        f"    STRUCT(TRUE AS flatten_json_output, 'SEMANTIC_SIMILARITY' AS task_type, {own.embedding_dimensions} AS output_dimensionality))\n"
        "  WHERE ARRAY_LENGTH(ml_generate_embedding_result) > 0\n) e ON e.decision_id = fresh.decision_id\n") if with_numbers else ""
    embedding = "e.ml_generate_embedding_result" if with_numbers else "CAST(NULL AS ARRAY<FLOAT64>)"
    return (
        f"INSERT INTO `{d}` (decision_id, decided_at, queue_id, target_id, item_type, trigger_path, escalate, severity, escalation_path,\n"
        "  decision_rationale, sanitized_evidence, velocity_summary, chat_message_id, agent_engine_session, embedding)\n"
        f"WITH fresh AS (\n  SELECT {parsed}\n  FROM UNNEST(JSON_QUERY_ARRAY(@decided)) r\n)\n"
        "SELECT fresh.decision_id, fresh.decided_at, fresh.queue_id, fresh.target_id, fresh.item_type, fresh.trigger_path, fresh.escalate, fresh.severity,\n"
        "  fresh.escalation_path, fresh.decision_rationale, fresh.sanitized_evidence, fresh.velocity_summary, CAST(NULL AS STRING),\n"
        f"  fresh.agent_engine_session, {embedding}\nFROM fresh\n{numbers}"
        f"WHERE NOT EXISTS (SELECT 1 FROM `{d}` x WHERE x.queue_id = fresh.queue_id AND x.decided_at >= @since)")


def _since(ctx: "AgentContext") -> Any:
    """Queue items and decisions older than this are out of a run's reach (a day past the catch-up hours)."""
    return ctx.now() - timedelta(hours=ctx.config.platform.own_alerts.catch_up_hours + 24)


def _insert(ctx: "AgentContext", gw: Any, rows: list[dict[str, Any]]) -> None:
    """The decisions into BigQuery, once each: a queue item that already has one is skipped."""
    home = ctx.config.platform.bigquery.location or None
    params = {"decided": json.dumps([{k: r[k] for k in FIELDS} for r in rows]), "since": _since(ctx)}
    try:
        gw.query(_insert_sql(ctx, True), params, location=home, labels=schema.LABELS)
    except Exception:  # noqa: BLE001 - the numbers only serve later look-ups: the decision is written without them
        gw.query(_insert_sql(ctx, False), params, location=home, labels=schema.LABELS)


def _remember(ctx: "AgentContext", gw: Any, rows: list[dict[str, Any]]) -> None:
    """Each raised story keeps when it was raised and what was said: the next look at it starts from there."""
    raised = {r["target_id"]: {"story_id": r["target_id"], "at": r["decided_at"], "summary": r["decision_rationale"][:600]}
              for r in rows if r["item_type"] == "STORY" and r["escalate"]}
    if raised:
        gw.query(f"UPDATE `{schema.table(ctx, 'stories')}` s\n"
                 "SET last_alerted_at = TIMESTAMP(JSON_VALUE(r, '$.at')), story_summary = JSON_VALUE(r, '$.summary')\n"
                 "FROM UNNEST(JSON_QUERY_ARRAY(@raised)) r\nWHERE s.story_id = JSON_VALUE(r, '$.story_id')",
                 {"raised": json.dumps(list(raised.values()))}, location=ctx.config.platform.bigquery.location or None, labels=schema.LABELS)


def _close(ctx: "AgentContext", gw: Any, queue_ids: list[str]) -> None:
    gw.query(f"UPDATE `{schema.table(ctx, 'review_queue')}` SET processed = TRUE\nWHERE queued_at >= @since AND queue_id IN UNNEST(@done)",
             {"since": _since(ctx), "done": queue_ids}, location=ctx.config.platform.bigquery.location or None, labels=schema.LABELS)


def _kept(item: dict[str, Any]) -> dict[str, Any]:
    """The decision BigQuery already holds for a queue item, as a row."""
    return {"decision_id": str(item["kept_id"]), "decided_at": str(item.get("kept_at") or ""), "queue_id": item["queue_id"], "target_id": item["target_id"],
            "item_type": item["item_type"], "trigger_path": item["trigger_path"], "escalate": bool(item.get("kept_escalate")),
            "severity": str(item.get("kept_severity") or ""), "escalation_path": str(item.get("kept_path") or ""),
            "decision_rationale": str(item.get("kept_rationale") or ""), "sanitized_evidence": str(item.get("kept_evidence") or ""),
            "velocity_summary": str(item.get("kept_velocity") or ""), "agent_engine_session": str(item.get("kept_session") or "worker")}


def _doc(item: dict[str, Any], row: dict[str, Any], engine: str, note: str) -> dict[str, Any]:
    return {"id": row["decision_id"], "at": row["decided_at"], "queue_id": row["queue_id"], "target_id": row["target_id"],
            "item_type": row["item_type"], "trigger": row["trigger_path"], "rule": item.get("rule_name") or "", "rule_id": item.get("matched_rule_id") or "",
            "section": item.get("process_doc_section") or "", "escalate": row["escalate"], "severity": row["severity"], "path": row["escalation_path"],
            "rationale": row["decision_rationale"], "evidence": row["sanitized_evidence"], "velocity": row["velocity_summary"],
            "first_pass": item.get("stage1_rationale") or "", "source": item.get("source_system") or "", "platform": item.get("platform") or "",
            "engine": engine, "note": note, "status": "raised" if row["escalate"] else "passed", "links": [], "kof": "", "outbox_id": "",
            "posted_to": "", "verdict": "", "verdict_by": "", "verdict_at": ""}


# ---------------------------------------------------------------------------------------------------------------
# The minute run
# ---------------------------------------------------------------------------------------------------------------

def lock_seconds(own: Any) -> int:
    """How long one run may hold the lock: its own time, one review still in flight (the Agent Runtime, then the
    worker), and BigQuery's writes."""
    return own.review_seconds + 2 * own.runtime_timeout_seconds + WRITE_SECONDS


def _decide(ctx: "AgentContext", gw: Any, items: list[dict[str, Any]], out: dict[str, Any], errors: list[str]) -> list[tuple[dict[str, Any], dict[str, Any], str, str]]:
    """Reviews the items no decision is kept for and writes their decisions. Returns every item this run can finish:
    (item, its decision, where it was decided, why the Agent Runtime was not used)."""
    own = ctx.config.platform.own_alerts
    started = ctx.now()
    lead: dict[tuple[str, str], dict[str, Any]] = {}
    for item in items:
        item["velocity_summary"] = velocity_of(item)
        if not item.get("kept_id"):
            lead.setdefault((str(item["item_type"]), str(item["target_id"])), item)
    precedents = _precedents(ctx, gw, list(lead.values()))
    kept: list[tuple[dict[str, Any], dict[str, Any], str, str]] = []
    fresh: list[tuple[dict[str, Any], dict[str, Any], str, str]] = []
    reviewed: set[tuple[str, str]] = set()
    for item in items:
        if item.get("kept_id"):  # a run that did not finish already decided it: it is not reviewed again
            row = _kept(item)
            kept.append((item, row, "worker" if row["agent_engine_session"] == "worker" else "agent_runtime", ""))
            continue
        key = (str(item["item_type"]), str(item["target_id"]))
        first = lead[key]
        base = {"decision_id": decision_id(str(item["queue_id"])), "queue_id": item["queue_id"], "target_id": item["target_id"],
                "item_type": item["item_type"], "trigger_path": item["trigger_path"], "sanitized_evidence": str(item.get("evidence") or ""),
                "velocity_summary": item["velocity_summary"]}
        if first is not item:  # the same post or story is waiting twice: it is reviewed once
            if key in reviewed:
                what = "story" if item["item_type"] == "STORY" else "post"
                row = {**base, "decided_at": ctx.now().isoformat(), "escalate": False, "severity": own.default_severity,
                       "escalation_path": own.default_path, "agent_engine_session": "worker",
                       "decision_rationale": f"The same {what} as queue item {first['queue_id']}, reviewed in the same run."}
                fresh.append((item, row, "worker", ""))
            else:  # its first item was not reviewed this run: both wait
                out["left"] += 1
            continue
        if (ctx.now() - started).total_seconds() >= own.review_seconds:  # the run's time is up: the rest wait for the next minute
            out["left"] += 1
            continue
        try:
            asked = {k: v for k, v in item.items() if k != "queued_at" and not k.startswith("kept_")}
            verdict, engine, note = ask(ctx, asked, precedents.get(str(item["queue_id"]), []))
        except Exception as exc:  # noqa: BLE001 - this one stays queued and is reviewed next minute
            out["failed"] += 1
            errors.append(f"A review failed and will be tried again: {str(exc)[:200]}")
            continue
        reviewed.add(key)
        escalate, severity, path = decide(own, item, verdict)
        session = ctx.config.platform.gcp.agent_runtime_resource if engine == "agent_runtime" else "worker"
        row = {**base, "decided_at": ctx.now().isoformat(), "escalate": escalate, "severity": severity, "escalation_path": path,
               "decision_rationale": verdict.decision_rationale.strip()[:1500], "agent_engine_session": session}
        fresh.append((item, row, engine, note))
    if fresh:
        try:
            _insert(ctx, gw, [row for _, row, _, _ in fresh])
        except Exception as exc:  # noqa: BLE001 - nothing is kept for these: they are reviewed again next minute
            errors.append(f"BigQuery did not take the decisions: {str(exc)[:300]}")
            fresh = []
    return kept + fresh


def _finish(ctx: "AgentContext", gw: Any, done: list[tuple[dict[str, Any], dict[str, Any], str, str]], out: dict[str, Any], errors: list[str]) -> None:
    """For each decision BigQuery holds: its record for the Console and its alert (once), then the story's memory, then
    the queue is closed. Whatever fails here is done by the next run, because the item stays open."""
    new = [_doc(item, row, engine, note) for item, row, engine, note in done if ctx.store.get_doc(DECISIONS, row["decision_id"]) is None]
    raised = [d for d in new if d["escalate"]]
    try:
        raise_.vault(ctx, gw, raised)
    except Exception as exc:  # noqa: BLE001 - the alert still goes out, without its links
        for d in raised:
            d["note"] = (d["note"] + " " if d["note"] else "") + f"The vault could not be read: {str(exc)[:160]}"
    for d in new:
        if d["escalate"] and raise_.post(ctx, d):
            out["posted"] += 1
        ctx.store.put_doc(DECISIONS, d["id"], d)
        ctx.emit(PlatformEvent.OWN_REVIEWED, actor="agent", space="system",
                 payload={"decision_id": d["id"], "item_type": d["item_type"], "trigger": d["trigger"], "escalate": d["escalate"],
                          "severity": d["severity"], "path": d["path"], "engine": d["engine"]})
    out.update(reviewed=len(new), raised=len(raised), passed=len(new) - len(raised))
    try:
        _remember(ctx, gw, [row for _, row, _, _ in done])
        _close(ctx, gw, [str(row["queue_id"]) for _, row, _, _ in done])
    except Exception as exc:  # noqa: BLE001 - the items stay open and come back next minute with their decisions
        errors.append(f"The queue could not be closed and will be closed next minute: {str(exc)[:300]}")


def run(ctx: "AgentContext") -> dict[str, Any]:
    """Reviews what is waiting, up to the number a minute and the seconds a run is given."""
    from .. import bq_admin

    if not ctx.config.platform.flag(SWITCH):
        return {"ok": True, "off": True}
    try:
        ready = schema.current(ctx)
    except ValueError:
        ready = False
    if not ready:  # the in-house job creates the objects on its next run
        return {"ok": True, "waiting": True}
    if not ctx.store.claim_idempotent(LOCK, ttl_s=lock_seconds(ctx.config.platform.own_alerts)):
        return {"ok": True, "busy": True}
    out: dict[str, Any] = {"ok": True, **dict.fromkeys(COUNTS, 0), "error": ""}
    errors: list[str] = []
    try:
        gw = bq_admin.get_gateway(ctx)
        done = _decide(ctx, gw, _pending(ctx, gw), out, errors)
        if done:
            _finish(ctx, gw, done, out, errors)
    except Exception as exc:  # noqa: BLE001 - shown on the Agent alerts page; the next minute tries again
        errors.append(str(exc)[:400])
    finally:
        ctx.store.release_idempotent(LOCK)
    if errors:
        out.update(ok=False, error="; ".join(errors[:3]))
    ctx.store.put_kv(STATE, {"last": ctx.now().isoformat(), "error": out["error"], "result": {k: out[k] for k in COUNTS}})
    return out


def list_decisions(ctx: "AgentContext", days: int = 7, status: str = "") -> list[dict[str, Any]]:
    """The decisions of the last days, the newest first, by when each was decided (a later verdict does not move one)."""
    floor = (ctx.now() - timedelta(days=days)).isoformat()
    rows = [d for d in ctx.store.list_docs(DECISIONS, where={"status": status} if status else None, limit=LISTED) if str(d.get("at") or "") >= floor]
    rows.sort(key=lambda d: d.get("at") or "", reverse=True)
    return rows


def status(ctx: "AgentContext") -> dict[str, Any]:
    state = ctx.store.get_kv(STATE) or {}
    return {"last": state.get("last") or "", "error": state.get("error") or "", "result": state.get("result") or {}}
