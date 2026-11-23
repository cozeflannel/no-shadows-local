"""Analytics event log.

Every agent action is an append-only AgentEvent. In GCP the log lives in
BigQuery (`agent_events`, see analytics/01_agent_events.sql); locally it is a
SQLite table so the Agent Console works offline with the same queries.
"""

import json
import os
import sqlite3
import threading
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable, Protocol

from .models import AgentEvent, utc_isoformat, utcnow


class EventType:
    """Canonical event types. Metrics in the Console are defined on these (docs/CONTRACTS.md#events)."""

    # Intake + triage (Path A Burson chat, Path B in-house, Watchdog emails)
    ALERT_RECEIVED = "alert.received"  # payload.source: burson_chat|inhouse|watchdog|manual
    TRIAGE_PASSED = "triage.passed"  # payload.first_pass = attempt == 1
    TRIAGE_CORRECTED = "triage.corrected"  # alertable after auto-corrections (payload.fields)
    TRIAGE_SUPPRESSED = "triage.suppressed"  # payload.reason, payload.reason_codes
    TRIAGE_FAILED = "triage.failed"  # unfixable data -> Burson on-call
    TRIAGE_NEEDS_REVIEW = "triage.needs_review"
    CORRECTION_APPLIED = "correction.applied"  # one per field
    CORRECTION_PROPOSED = "correction.proposed"  # below auto-apply threshold (IM confirms)
    CORRECTION_REVERTED = "correction.reverted"
    REVIEW_FORWARDED = "review.forwarded"
    REVIEW_BOUNCED = "review.bounced"
    REVIEW_SUPPRESSED = "review.suppressed"
    CLEAN_POSTED = "clean.posted"  # optional confirmation from a Studio "record post" step
    CASE_UPDATED = "case.updated"  # new attempt on a verified case (engagement update, Burson re-post)
    CASE_CLOSED = "case.closed"  # payload.reason: no_action|superseded|manual
    CASE_ABANDONED = "case.abandoned"
    ONCALL_NOTIFIED = "oncall.notified"  # payload.kind: bounce|reminder|backup|fallback|analyst|sla_risk
    VERDICT_OVERRIDDEN = "verdict.overridden"
    MESSAGE_IGNORED = "message.ignored"  # payload.reason: own_message|not_alert|duplicate|wrong_space
    # SLA + IM actions (emoji legend) + protocols
    ALERT_ACKNOWLEDGED = "alert.acknowledged"  # first IM reaction on the clean post
    ACTION_RECORDED = "action.recorded"  # payload.code, payload.emoji
    SLA_AT_RISK = "sla.at_risk"
    SLA_MET = "sla.met"  # alert email sent before sla_due_at
    SLA_MISSED = "sla.missed"
    PROTOCOL_PINGED = "protocol.pinged"  # payload.protocol: youtube|doodle|leadership|crisis|jon
    # Escalation: email drafts (payload.purpose: alert|tns_urgent|bug_followup|group)
    ESCALATION_STARTED = "escalation.started"  # payload.trigger: auto_urgent|reaction|chat|console|email
    EMAIL_DRAFTED = "email.drafted"
    EMAIL_GROUP_ADDED = "email.group_added"
    EMAIL_REVISION_REQUESTED = "email.revision_requested"
    EMAIL_REDRAFTED = "email.redrafted"
    EMAIL_SENT = "email.sent"
    EMAIL_DISCARDED = "email.discarded"
    EMAIL_FAILED = "email.failed"
    # Escalation: Trust & Safety (go/WD-Triage + Watchdog loop)
    TNS_ASSESSED = "tns.assessed"
    TNS_NOT_ELIGIBLE = "tns.not_eligible"
    TNS_PREPARED = "tns.prepared"
    TNS_SUBMITTED = "tns.submitted"  # payload.via: intake_email|chat|console
    TNS_WITHDRAWN = "tns.withdrawn"
    TNS_OUTCOME = "tns.outcome"  # payload.outcome: Fixed|Infeasible, payload.bug_id
    WATCHDOG_RECEIVED = "watchdog.received"
    WATCHDOG_SKIPPED = "watchdog.skipped"  # payload.reason: early_warning|jailbreak|nsfw|existing_case
    # Path B parity (in-house vs Burson)
    PARITY_MATCHED = "parity.matched"  # payload.diffs: {field: [burson, inhouse]}
    PARITY_UNMATCHED = "parity.unmatched"  # payload.side: burson_only|inhouse_only (after the match window)
    # Conversation & routing
    QA_ANSWERED = "qa.answered"
    QA_FEEDBACK = "qa.feedback"  # payload.rating: up|down
    ROUTE_FORWARDED = "route.forwarded"
    ROUTE_RELAYED = "route.relayed"
    # Rosters
    ONCALL_OVERRIDE_SET = "oncall.override_set"  # payload.roster: slrr_im|burson
    ROSTER_UPDATED = "roster.updated"
    # Jobs
    BURSON_DIGEST_POSTED = "burson.digest_posted"
    HANDOVER_POSTED = "handover.posted"
    OUTBOX_DELIVERED = "outbox.delivered"  # payload.count, payload.targets
    # Configuration & learning
    CONFIG_UPDATED = "config.updated"
    CONFIG_CHANGE_PROPOSED = "config.change_proposed"
    CONFIG_CHANGE_APPROVED = "config.change_approved"
    CONFIG_CHANGE_REJECTED = "config.change_rejected"
    FACT_PROPOSED = "knowledge.fact_proposed"
    FACT_APPROVED = "knowledge.fact_approved"
    FACT_REJECTED = "knowledge.fact_rejected"
    # Operations
    ERROR = "error"

    @classmethod
    def all(cls) -> list[str]:
        return sorted(v for k, v in vars(cls).items() if k.isupper() and isinstance(v, str))


def make_event(event_type: str, *, env: str = "dev", config_version: str | None = None, **fields: Any) -> AgentEvent:
    return AgentEvent(
        event_id=str(uuid.uuid4()),
        event_ts=fields.pop("event_ts", None) or utcnow(),
        event_type=event_type,
        env=env,
        config_version=config_version,
        **fields,
    )


class EventLogger(Protocol):
    def log(self, event: AgentEvent) -> None: ...

    def query(
        self,
        since: datetime | None = None,
        until: datetime | None = None,
        types: Iterable[str] | None = None,
        case_id: str | None = None,
        escalation_id: str | None = None,
        env: str | None = None,
        limit: int | None = None,
    ) -> list[AgentEvent]: ...


# ---------------------------------------------------------------------------
# Local (SQLite) implementation
# ---------------------------------------------------------------------------

_EVENT_COLUMNS = [
    "event_id", "event_ts", "event_type", "env", "case_id", "escalation_id", "actor", "space",
    "message_ref", "attempt", "verdict", "error_codes", "latency_ms", "model", "prompt_version",
    "config_version", "payload",
]


class SqliteEventLogger:
    def __init__(self, path: str | Path):
        self.path = str(path)
        Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        with self._conn() as con:
            con.execute(
                """CREATE TABLE IF NOT EXISTS agent_events (
                    event_id TEXT PRIMARY KEY, event_ts TEXT NOT NULL, event_type TEXT NOT NULL,
                    env TEXT, case_id TEXT, escalation_id TEXT, actor TEXT, space TEXT,
                    message_ref TEXT, attempt INTEGER, verdict TEXT, error_codes TEXT,
                    latency_ms INTEGER, model TEXT, prompt_version TEXT, config_version TEXT,
                    payload TEXT)"""
            )
            con.execute("CREATE INDEX IF NOT EXISTS ix_events_ts ON agent_events(event_ts)")
            con.execute("CREATE INDEX IF NOT EXISTS ix_events_case ON agent_events(case_id)")

    def _conn(self) -> sqlite3.Connection:
        con = sqlite3.connect(self.path, timeout=30)
        con.row_factory = sqlite3.Row
        return con

    def log(self, event: AgentEvent) -> None:
        row = event.model_dump(mode="json")
        row["error_codes"] = json.dumps(row["error_codes"])
        row["payload"] = json.dumps(row["payload"])
        with self._lock, self._conn() as con:
            con.execute(
                f"INSERT OR REPLACE INTO agent_events ({', '.join(_EVENT_COLUMNS)}) "
                f"VALUES ({', '.join('?' for _ in _EVENT_COLUMNS)})",
                [row[c] for c in _EVENT_COLUMNS],
            )

    def query(self, since=None, until=None, types=None, case_id=None, escalation_id=None, env=None, limit=None):
        sql, args = "SELECT * FROM agent_events WHERE 1=1", []
        # event_ts is UTC text (written from ctx.now()) and is compared as text: the bounds must be UTC too.
        if since is not None:
            sql += " AND event_ts >= ?"
            args.append(utc_isoformat(since))
        if until is not None:
            sql += " AND event_ts < ?"
            args.append(utc_isoformat(until))
        if types:
            types = list(types)
            sql += f" AND event_type IN ({', '.join('?' for _ in types)})"
            args.extend(types)
        if case_id:
            sql += " AND case_id = ?"
            args.append(case_id)
        if escalation_id:
            sql += " AND escalation_id = ?"
            args.append(escalation_id)
        if env:
            sql += " AND env = ?"
            args.append(env)
        sql += " ORDER BY event_ts DESC"
        if limit:
            sql += " LIMIT ?"
            args.append(int(limit))
        with self._conn() as con:
            rows = con.execute(sql, args).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            d["error_codes"] = json.loads(d["error_codes"] or "[]")
            d["payload"] = json.loads(d["payload"] or "{}")
            out.append(AgentEvent.model_validate(d))
        return out


# ---------------------------------------------------------------------------
# BigQuery implementation (GCP)
# ---------------------------------------------------------------------------


class BigQueryEventLogger:
    """Streams events into `<project>.<dataset>.agent_events` (DDL in analytics/)."""

    def __init__(self, table_id: str, project: str | None = None):
        from google.cloud import bigquery  # imported lazily so local dev needs no GCP creds

        self.table_id = table_id
        self.client = bigquery.Client(project=project)

    def log(self, event: AgentEvent) -> None:
        row = event.model_dump(mode="json")
        row["payload"] = json.dumps(row["payload"])  # JSON column accepts a JSON string
        errors = self.client.insert_rows_json(self.table_id, [row], row_ids=[event.event_id])
        if errors:
            raise RuntimeError(f"BigQuery insert failed: {errors}")

    def query(self, since=None, until=None, types=None, case_id=None, escalation_id=None, env=None, limit=None):
        from google.cloud import bigquery

        sql = f"SELECT * FROM `{self.table_id}` WHERE TRUE"
        params: list[Any] = []
        if since is not None:
            sql += " AND event_ts >= @since"
            params.append(bigquery.ScalarQueryParameter("since", "TIMESTAMP", since))
        if until is not None:
            sql += " AND event_ts < @until"
            params.append(bigquery.ScalarQueryParameter("until", "TIMESTAMP", until))
        if types:
            sql += " AND event_type IN UNNEST(@types)"
            params.append(bigquery.ArrayQueryParameter("types", "STRING", list(types)))
        if case_id:
            sql += " AND case_id = @case_id"
            params.append(bigquery.ScalarQueryParameter("case_id", "STRING", case_id))
        if escalation_id:
            sql += " AND escalation_id = @escalation_id"
            params.append(bigquery.ScalarQueryParameter("escalation_id", "STRING", escalation_id))
        if env:
            sql += " AND env = @env"
            params.append(bigquery.ScalarQueryParameter("env", "STRING", env))
        sql += " ORDER BY event_ts DESC"
        if limit:
            sql += f" LIMIT {int(limit)}"
        job = self.client.query(sql, job_config=bigquery.QueryJobConfig(query_parameters=params))
        out = []
        for row in job.result():
            d = dict(row.items())
            payload = d.get("payload")
            d["payload"] = json.loads(payload) if isinstance(payload, str) else (payload or {})
            d["error_codes"] = list(d.get("error_codes") or [])
            out.append(AgentEvent.model_validate(d))
        return out


def get_event_logger() -> EventLogger:
    """TRIAGE_BACKEND=gcp -> BigQuery (TRIAGE_BQ_TABLE), otherwise local SQLite."""
    if os.environ.get("TRIAGE_BACKEND", "local") == "gcp":
        return BigQueryEventLogger(os.environ["TRIAGE_BQ_TABLE"], project=(os.environ.get("TRIAGE_PROJECT_ID") or os.environ.get("GOOGLE_CLOUD_PROJECT")))
    return SqliteEventLogger(os.environ.get("TRIAGE_LOCAL_DB", ".local/triage.db"))


_writes = 0


def note_write() -> None:
    """Called for every event this process writes, so its own caches know to read again."""
    global _writes
    _writes += 1


def writes() -> int:
    return _writes


class PlatformEvent:
    """Event types of the Console-era platform (audit, Chat tracking, delivery, AI usage, workforce).

    Kept apart from EventType so the KPI definitions and the SQL views built on EventType stay as they are."""

    AUDIT_RECORDED = "audit.recorded"  # payload: action, surface, target, status
    CHAT_INBOUND = "chat.inbound"  # a message, reaction or email the agent was handed
    CHAT_OUTBOUND = "chat.outbound"  # a post the agent returned or delivered
    CLASSIFIED = "triage.classified"  # payload: label, confidence, docs
    ASSESSMENT_RECORDED = "assessment.recorded"  # an IM's own assessment of an alert
    GOLDEN_RECORDED = "golden.recorded"
    SAFETY_BLOCKED = "safety.blocked"  # payload: check, target, hits
    SAFETY_CHECKED = "safety.checked"
    OUTBOUND_PUBLISHED = "outbound.published"
    OUTBOUND_DELIVERED = "outbound.delivered"
    OUTBOUND_FAILED = "outbound.failed"
    OUTBOUND_DEAD_LETTERED = "outbound.dead_lettered"
    OUTBOUND_REPLAYED = "outbound.replayed"
    LLM_USAGE = "llm.usage"  # payload: purpose, input_tokens, output_tokens, prompt_version
    PROMPT_PUBLISHED = "prompt.published"
    AGENT_CHAT_TURN = "agent_chat.turn"
    AGENT_CHAT_TOOL = "agent_chat.tool"
    TEMP_CHECK_STARTED = "temp_check.started"
    TEMP_CHECK_COMPLETED = "temp_check.completed"
    TEMP_CHECK_FAILED = "temp_check.failed"
    TEMP_CHECK_ACTIONED = "temp_check.actioned"
    FORECAST_RUN = "forecast.run"
    FORECAST_FAILED = "forecast.failed"
    RECOMMENDATION_CREATED = "workforce.recommendation_created"
    RECOMMENDATION_DECIDED = "workforce.recommendation_decided"
    GAP_ALERT = "workforce.gap_alert"
    SHIFT_UPDATED = "workforce.shift_updated"
    KNOWLEDGE_DOC_SAVED = "knowledge.doc_saved"
    KNOWLEDGE_DOC_REMOVED = "knowledge.doc_removed"
    KNOWLEDGE_INDEXED = "knowledge.indexed"
    WATCH_SAVED = "watch.saved"
    WATCH_DETECTED = "watch.detected"
    CAMPAIGN_SAVED = "campaign.saved"
    BIGQUERY_CHANGED = "bigquery.changed"
    SECRET_CHANGED = "secret.changed"
    OWN_CYCLE = "own.cycle"  # one run of own alerts: payload read, staged, new_posts, hard, single_queued, stories_queued, failing
    OWN_REVIEWED = "own.reviewed"  # payload: decision_id, item_type, trigger, escalate, severity, path, engine
    OWN_RAISED = "own.raised"  # an own alert queued for Chat: payload decision_id, outbox_id, target
    OWN_FEEDBACK = "own.feedback"  # an analyst's verdict: payload decision_id, verdict
    OWN_RULE_SAVED = "own.rule_saved"

    @classmethod
    def all(cls) -> list[str]:
        return sorted(v for k, v in vars(cls).items() if k.isupper() and isinstance(v, str))


# ---------------------------------------------------------------------------
# Fast recent reads (GCP): events are also written to the document store
# ---------------------------------------------------------------------------

HOT_COLLECTION = "events_hot"


class StoreEventLogger:
    """Events in the state store's `events_hot` collection: cheap to read by time for live views."""

    def __init__(self, store: Any):
        self.store = store

    def log(self, event: AgentEvent) -> None:
        self.store.put_doc(HOT_COLLECTION, event.event_id, event.model_dump(mode="json"))

    def query(self, since=None, until=None, types=None, case_id=None, escalation_id=None, env=None, limit=None):
        where: dict[str, Any] = {}
        if case_id:
            where["case_id"] = case_id
        elif escalation_id:
            where["escalation_id"] = escalation_id
        rows = self.store.list_docs(HOT_COLLECTION, where=where or None, since=since, limit=int(limit or 20000) * (1 if not types else 4))
        wanted = set(types) if types else None
        out = []
        for row in rows:
            e = AgentEvent.model_validate(row)
            if wanted is not None and e.event_type not in wanted:
                continue
            if escalation_id and e.escalation_id != escalation_id:
                continue
            if env and e.env != env:
                continue
            if since is not None and e.event_ts < since:
                continue
            if until is not None and e.event_ts >= until:
                continue
            out.append(e)
        out.sort(key=lambda e: e.event_ts, reverse=True)
        return out[: int(limit)] if limit else out


class TeeEventLogger:
    """Writes each event to the fast store and to BigQuery; reads recent windows from the fast store.

    `cold` is None until BigQuery is connected in the Console: the agent runs on the fast store alone."""

    def __init__(self, hot: StoreEventLogger, cold: Any | None, hot_window_hours: int = 48):
        self.hot, self.cold, self.hot_window_hours = hot, cold, hot_window_hours

    def log(self, event: AgentEvent) -> None:
        self.hot.log(event)
        if self.cold is not None:
            try:
                self.cold.log(event)
            except Exception:  # noqa: BLE001 - the fast store has it; analytics catches up on the next write
                import logging

                logging.getLogger(__name__).exception("BigQuery event write failed for %s", event.event_type)

    def query(self, since=None, until=None, types=None, case_id=None, escalation_id=None, env=None, limit=None):
        recent = since is not None and (utcnow() - since).total_seconds() <= self.hot_window_hours * 3600
        if self.cold is None or recent or case_id or escalation_id:
            rows = self.hot.query(since, until, types, case_id, escalation_id, env, limit)
            if rows or self.cold is None or recent:
                return rows
        return self.cold.query(since, until, types, case_id, escalation_id, env, limit)


def events_table(config: Any | None) -> str:
    """Where events go in BigQuery: Settings → BigQuery → tables.events (TRIAGE_BQ_TABLE for older deployments)."""
    table = ""
    if config is not None:
        table = str(config.platform.bigquery.tables.get("events") or "")
    return table or os.environ.get("TRIAGE_BQ_TABLE", "")


def build_event_logger(store: Any, config: Any | None) -> EventLogger:
    """Event logger for a context: SQLite locally; on GCP the fast store plus BigQuery once it is connected."""
    if os.environ.get("TRIAGE_BACKEND", "local") != "gcp":
        return SqliteEventLogger(os.environ.get("TRIAGE_LOCAL_DB", ".local/triage.db"))
    table = events_table(config)
    project = None
    if config is not None:
        project = config.platform.bigquery.project or config.platform.gcp.project or None
    project = project or os.environ.get("TRIAGE_PROJECT_ID") or os.environ.get("GOOGLE_CLOUD_PROJECT")
    cold = BigQueryEventLogger(table, project=project) if table else None
    hours = config.platform.bigquery.hot_window_hours if config is not None else 48
    return TeeEventLogger(StoreEventLogger(store), cold, hours)
