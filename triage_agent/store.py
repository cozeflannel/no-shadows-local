"""State store: cases, escalations, rosters, config overrides, learning items, outbox.

GCP: Firestore (native mode). Local dev/tests: a single SQLite file shared with
the event log. Both implement the same `Store` protocol.
"""

import json
import os
import sqlite3
import threading
from datetime import datetime
from pathlib import Path
from typing import Any, Protocol

from .ids import message_key
from .models import (
    Case,
    CaseStatus,
    ConfigChangeProposal,
    EmailStatus,
    Escalation,
    KnowledgeFact,
    OutboxItem,
    ProposalStatus,
    Roster,
    TnsStatus,
    utc_isoformat,
    utcnow,
)

ID_START = 1000  # first generated id is <PREFIX>-1001

_OPEN_EMAIL = {EmailStatus.DRAFTED, EmailStatus.REVISION_REQUESTED, EmailStatus.REDRAFTED}
_OPEN_TNS = {TnsStatus.ASSESSED, TnsStatus.PREPARED}


def escalation_is_open(esc: Escalation) -> bool:
    """Open while any email draft is unsent or the T&S form is prepared but not submitted,
    or a submitted T&S report still awaits its outcome / bug-id follow-up."""
    if any(e.status in _OPEN_EMAIL for e in esc.emails):
        return True
    if esc.tns and esc.tns.status in _OPEN_TNS:
        return True
    return bool(esc.tns and esc.tns.status == TnsStatus.SUBMITTED and esc.tns.outcome is None)


class Store(Protocol):
    # idempotency (one response per Chat message / reaction / email)
    def get_idempotent(self, key: str) -> dict | None: ...
    def put_idempotent(self, key: str, response: dict) -> None: ...
    # Atomic "I'm processing this delivery" marker (Studio retries can overlap a slow first attempt).
    def claim_idempotent(self, key: str, ttl_s: int = 120) -> bool: ...  # False = another live claim exists
    def release_idempotent(self, key: str) -> None: ...

    # sequential human-friendly ids, e.g. next_id("TRG") -> "TRG-1001"
    def next_id(self, prefix: str) -> str: ...

    # small key-value documents for job bookkeeping (last handover, digest date…)
    def get_kv(self, key: str) -> dict | None: ...
    def put_kv(self, key: str, value: dict) -> None: ...

    # cases
    def get_case(self, case_id: str) -> Case | None: ...
    def find_case_by_record_key(self, record_key: str, source: str | None = None) -> Case | None: ...  # most recent
    def find_case_by_source_ref(self, source: str, source_ref: str) -> Case | None: ...
    def find_case_by_message_ref(self, ref: str) -> Case | None: ...  # clean post id/link (Case.clean_message_key)
    def save_case(self, case: Case) -> None: ...
    def list_cases(
        self,
        statuses: list[CaseStatus] | None = None,
        since: datetime | None = None,
        limit: int = 200,
        exposure_tag: str | None = None,
        source: str | None = None,
    ) -> list[Case]: ...  # newest first (updated_at)

    # escalations
    def get_escalation(self, escalation_id: str) -> Escalation | None: ...
    def list_escalations(
        self,
        case_id: str | None = None,
        analyst_email: str | None = None,
        open_only: bool = False,
        limit: int = 200,
    ) -> list[Escalation]: ...
    def save_escalation(self, esc: Escalation) -> None: ...

    # config overrides saved by the Agent Console (merged over YAML defaults)
    def get_config_overrides(self) -> dict: ...
    def save_config_overrides(self, overrides: dict, actor: str, note: str = "") -> None: ...
    def config_history(self, limit: int = 20) -> list[dict]: ...

    # rosters: "slrr_im" (Incident Manager shifts) and "burson" (Burson on-call, NEEDS_BURSON only)
    def get_roster(self, name: str = "burson") -> Roster | None: ...
    def save_roster(self, roster: Roster, actor: str, name: str = "burson") -> None: ...

    # learning (teach-by-chat)
    def save_proposal(self, proposal: ConfigChangeProposal) -> None: ...
    def get_proposal(self, proposal_id: str) -> ConfigChangeProposal | None: ...
    def list_proposals(self, status: ProposalStatus | None = None, limit: int = 200) -> list[ConfigChangeProposal]: ...
    def save_fact(self, fact: KnowledgeFact) -> None: ...
    def get_fact(self, fact_id: str) -> KnowledgeFact | None: ...
    def list_facts(self, status: ProposalStatus | None = None, limit: int = 500) -> list[KnowledgeFact]: ...

    # outbox (posts delivered by the Studio Outbox flow)
    def add_outbox(self, item: OutboxItem) -> None: ...
    def list_outbox(self, undelivered_only: bool = True, limit: int = 200) -> list[OutboxItem]: ...
    def mark_outbox_delivered(self, outbox_ids: list[str], delivered_by: str = "") -> None: ...
    # Atomically take undelivered items (oldest first) and mark them delivered.
    # per_target: max items per target, e.g. {"clean": 1, "team": 10}; targets not listed use `default_limit`.
    # DMs: only items sharing the oldest DM's recipient set. Texts per target stay within max_chars.
    def claim_outbox(
        self, per_target: dict[str, int], default_limit: int, claimed_by: str, max_chars: int = 3500
    ) -> list[OutboxItem]: ...

    # generic documents (audit log, chat activity, knowledge, sessions, workforce, ...). `where` is an equality
    # filter on top-level keys; results are newest first by the time the document was last written.
    def put_doc(self, collection: str, doc_id: str, data: dict) -> None: ...
    def get_doc(self, collection: str, doc_id: str) -> dict | None: ...
    def delete_doc(self, collection: str, doc_id: str) -> None: ...
    def list_docs(self, collection: str, *, where: dict[str, Any] | None = None, since: datetime | None = None,
                  limit: int = 200) -> list[dict]: ...
    def create_doc(self, collection: str, doc_id: str, data: dict) -> bool: ...  # False = it already exists


def _claim_plan(
    items: list[OutboxItem], per_target: dict[str, int], default_limit: int, max_chars: int = 3500
) -> list[OutboxItem]:
    """Oldest-first selection respecting per-target limits (shared by both stores)."""
    taken: dict[str, int] = {}
    chars: dict[str, int] = {}
    dm_group: tuple[str, ...] | None = None
    out = []
    for item in sorted(items, key=lambda i: i.created_at):
        if item.target == "dm":
            group = tuple(sorted(r.lower() for r in item.recipients))
            if dm_group is None:
                dm_group = group
            elif group != dm_group:
                continue
        limit = per_target.get(item.target, default_limit)
        n = taken.get(item.target, 0)
        size = chars.get(item.target, 0) + len(item.text) + (2 if n else 0)
        if n < limit and (n == 0 or size <= max_chars):
            taken[item.target] = n + 1
            chars[item.target] = size
            out.append(item)
    return out


# ---------------------------------------------------------------------------
# SQLite implementation (local dev + tests)
# ---------------------------------------------------------------------------


class SqliteStore:
    """Document-style store on SQLite. Collections mirror the Firestore layout."""

    def __init__(self, path: str | Path):
        self.path = str(path)
        if self.path != ":memory:":
            Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._mem = sqlite3.connect(":memory:", check_same_thread=False) if self.path == ":memory:" else None
        with self._lock:
            con = self._conn()
            con.execute(
                "CREATE TABLE IF NOT EXISTS docs (collection TEXT, id TEXT, data TEXT, "
                "updated_at TEXT, PRIMARY KEY (collection, id))"
            )
            con.execute("CREATE INDEX IF NOT EXISTS ix_docs_updated ON docs(collection, updated_at)")
            con.execute("CREATE INDEX IF NOT EXISTS ix_cases_msgkey ON docs(json_extract(data, '$.clean_message_key')) "
                        "WHERE collection = 'cases'")
            con.execute("CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER)")
            con.commit()

    def _conn(self) -> sqlite3.Connection:
        if self._mem is not None:
            return self._mem
        return sqlite3.connect(self.path, timeout=30)

    # -- generic helpers -------------------------------------------------------
    def _put(self, collection: str, doc_id: str, data: dict, updated_at: str | None = None) -> None:
        with self._lock:
            con = self._conn()
            con.execute(
                "INSERT OR REPLACE INTO docs (collection, id, data, updated_at) VALUES (?, ?, ?, ?)",
                (collection, doc_id, json.dumps(data, default=str), updated_at or utcnow().isoformat()),
            )
            con.commit()

    def _get(self, collection: str, doc_id: str) -> dict | None:
        with self._lock:
            row = self._conn().execute(
                "SELECT data FROM docs WHERE collection = ? AND id = ?", (collection, doc_id)
            ).fetchone()
        return json.loads(row[0]) if row else None

    def _list(self, collection: str, limit: int = 1000) -> list[dict]:
        with self._lock:
            rows = self._conn().execute(
                "SELECT data FROM docs WHERE collection = ? ORDER BY updated_at DESC LIMIT ?",
                (collection, limit),
            ).fetchall()
        return [json.loads(r[0]) for r in rows]

    # -- idempotency -------------------------------------------------------------
    def get_idempotent(self, key):
        return self._get("idempotency", key)

    def put_idempotent(self, key, response):
        self._put("idempotency", key, response)

    def claim_idempotent(self, key, ttl_s=120):
        now = utcnow()
        with self._lock:
            con = self._conn()
            try:
                con.execute("BEGIN IMMEDIATE")  # also serializes other processes on the same file
                row = con.execute("SELECT data FROM docs WHERE collection = 'claims' AND id = ?", (key,)).fetchone()
                if row:
                    claimed_at = datetime.fromisoformat(json.loads(row[0])["claimed_at"])
                    if (now - claimed_at).total_seconds() < ttl_s:
                        con.rollback()
                        return False
                con.execute("INSERT OR REPLACE INTO docs (collection, id, data, updated_at) VALUES ('claims', ?, ?, ?)",
                            (key, json.dumps({"claimed_at": now.isoformat()}), now.isoformat()))
                con.commit()
                return True
            except Exception:
                con.rollback()
                raise

    def release_idempotent(self, key):
        with self._lock:
            con = self._conn()
            con.execute("DELETE FROM docs WHERE collection = 'claims' AND id = ?", (key,))
            con.commit()

    # -- ids ---------------------------------------------------------------------
    def next_id(self, prefix):
        with self._lock:
            con = self._conn()
            row = con.execute("SELECT value FROM counters WHERE name = ?", (prefix,)).fetchone()
            value = (row[0] if row else ID_START) + 1
            con.execute("INSERT OR REPLACE INTO counters (name, value) VALUES (?, ?)", (prefix, value))
            con.commit()
        return f"{prefix}-{value}"

    # -- kv ----------------------------------------------------------------------
    def get_kv(self, key):
        return self._get("kv", key)

    def put_kv(self, key, value):
        self._put("kv", key, value)

    # -- cases -------------------------------------------------------------------
    def get_case(self, case_id):
        d = self._get("cases", case_id)
        return Case.model_validate(d) if d else None

    def find_case_by_record_key(self, record_key, source=None):
        sql = "SELECT data FROM docs WHERE collection = 'cases' AND json_extract(data, '$.record_key') = ?"
        args: list[Any] = [record_key]
        if source:
            sql += " AND json_extract(data, '$.source') = ?"
            args.append(source)
        sql += " ORDER BY updated_at DESC LIMIT 1"
        with self._lock:
            row = self._conn().execute(sql, args).fetchone()
        return Case.model_validate(json.loads(row[0])) if row else None

    def find_case_by_source_ref(self, source, source_ref):
        with self._lock:
            row = self._conn().execute(
                "SELECT data FROM docs WHERE collection = 'cases' AND json_extract(data, '$.source') = ? "
                "AND json_extract(data, '$.source_ref') = ? ORDER BY updated_at DESC LIMIT 1",
                (source, source_ref),
            ).fetchone()
        return Case.model_validate(json.loads(row[0])) if row else None

    def find_case_by_message_ref(self, ref):
        key = message_key(ref)
        if not key:
            return None
        with self._lock:
            row = self._conn().execute(
                "SELECT data FROM docs WHERE collection = 'cases' AND json_extract(data, '$.clean_message_key') = ? "
                "ORDER BY updated_at DESC LIMIT 1",
                (key,),
            ).fetchone()
        return Case.model_validate(json.loads(row[0])) if row else None

    def save_case(self, case):
        case.updated_at = utcnow()
        self._put("cases", case.case_id, case.model_dump(mode="json"), updated_at=case.updated_at.isoformat())

    def list_cases(self, statuses=None, since=None, limit=200, exposure_tag=None, source=None):
        out = []
        for d in self._list("cases", limit=100000):
            c = Case.model_validate(d)
            if statuses and c.status not in statuses:
                continue
            if since and c.updated_at < since:
                continue
            if exposure_tag and (c.exposure_tag or "").lower() != exposure_tag.lower():
                continue
            if source and c.source != source:
                continue
            out.append(c)
            if len(out) >= limit:
                break
        return out

    # -- escalations -------------------------------------------------------------
    def get_escalation(self, escalation_id):
        d = self._get("escalations", escalation_id)
        return Escalation.model_validate(d) if d else None

    def list_escalations(self, case_id=None, analyst_email=None, open_only=False, limit=200):
        out = []
        for d in self._list("escalations", limit=100000):
            e = Escalation.model_validate(d)
            if case_id and e.case_id != case_id:
                continue
            if analyst_email and e.analyst_email.lower() != analyst_email.lower():
                continue
            if open_only and not escalation_is_open(e):
                continue
            out.append(e)
            if len(out) >= limit:
                break
        return out

    def save_escalation(self, esc):
        esc.updated_at = utcnow()
        self._put("escalations", esc.escalation_id, esc.model_dump(mode="json"), updated_at=esc.updated_at.isoformat())

    # -- config ------------------------------------------------------------------
    def get_config_overrides(self):
        d = self._get("config", "current")
        return (d or {}).get("overrides", {})

    def save_config_overrides(self, overrides, actor, note=""):
        now = utcnow().isoformat()
        self._put("config", "current", {"overrides": overrides, "updated_by": actor, "updated_at": now, "note": note})
        self._put("config_history", f"{now}", {"overrides": overrides, "updated_by": actor, "updated_at": now, "note": note})

    def config_history(self, limit=20):
        return self._list("config_history", limit=limit)

    # -- roster ------------------------------------------------------------------
    def get_roster(self, name="burson"):
        d = self._get("roster", name)
        return Roster.model_validate(d) if d else None

    def save_roster(self, roster, actor, name="burson"):
        roster.updated_at = utcnow()
        roster.updated_by = actor
        self._put("roster", name, roster.model_dump(mode="json"))

    # -- learning ----------------------------------------------------------------
    def save_proposal(self, proposal):
        self._put("proposals", proposal.proposal_id, proposal.model_dump(mode="json"))

    def get_proposal(self, proposal_id):
        d = self._get("proposals", proposal_id)
        return ConfigChangeProposal.model_validate(d) if d else None

    def list_proposals(self, status=None, limit=200):
        items = [ConfigChangeProposal.model_validate(d) for d in self._list("proposals", limit=100000)]
        return [p for p in items if status is None or p.status == status][:limit]

    def save_fact(self, fact):
        self._put("facts", fact.fact_id, fact.model_dump(mode="json"))

    def get_fact(self, fact_id):
        d = self._get("facts", fact_id)
        return KnowledgeFact.model_validate(d) if d else None

    def list_facts(self, status=None, limit=500):
        items = [KnowledgeFact.model_validate(d) for d in self._list("facts", limit=100000)]
        return [f for f in items if status is None or f.status == status][:limit]

    # -- outbox ------------------------------------------------------------------
    def add_outbox(self, item):
        self._put("outbox", item.outbox_id, item.model_dump(mode="json"))

    def list_outbox(self, undelivered_only=True, limit=200):
        items = [OutboxItem.model_validate(d) for d in self._list("outbox", limit=100000)]
        if undelivered_only:
            items = [i for i in items if i.delivered_at is None]
        return sorted(items, key=lambda i: i.created_at)[:limit]

    def mark_outbox_delivered(self, outbox_ids, delivered_by=""):
        now = utcnow()
        with self._lock:
            for oid in outbox_ids:
                d = self._get("outbox", oid)
                if d:
                    item = OutboxItem.model_validate(d)
                    item.delivered_at = now
                    item.delivered_by = delivered_by or None
                    self._put("outbox", oid, item.model_dump(mode="json"))

    def claim_outbox(self, per_target, default_limit, claimed_by, max_chars=3500):
        with self._lock:  # RLock: the whole read-select-mark sequence is atomic in-process
            pending = self.list_outbox(undelivered_only=True, limit=100000)
            chosen = _claim_plan(pending, per_target, default_limit, max_chars)
            self.mark_outbox_delivered([i.outbox_id for i in chosen], delivered_by=claimed_by)
        now = utcnow()
        for i in chosen:
            i.delivered_at, i.delivered_by = now, claimed_by
        return chosen


    # -- generic documents ---------------------------------------------------------
    def put_doc(self, collection, doc_id, data):
        self._put(f"x:{collection}", doc_id, data)

    def get_doc(self, collection, doc_id):
        return self._get(f"x:{collection}", doc_id)

    def delete_doc(self, collection, doc_id):
        with self._lock:
            con = self._conn()
            con.execute("DELETE FROM docs WHERE collection = ? AND id = ?", (f"x:{collection}", doc_id))
            con.commit()

    def create_doc(self, collection, doc_id, data):
        with self._lock:
            con = self._conn()
            cur = con.execute(
                "INSERT OR IGNORE INTO docs (collection, id, data, updated_at) VALUES (?, ?, ?, ?)",
                (f"x:{collection}", doc_id, json.dumps(data, default=str), utcnow().isoformat()),
            )
            con.commit()
            return cur.rowcount == 1

    def list_docs(self, collection, *, where=None, since=None, limit=200):
        sql, args = "SELECT data FROM docs WHERE collection = ?", [f"x:{collection}"]
        for key, value in (where or {}).items():
            if not key.replace("_", "").isalnum():
                raise ValueError(f"invalid filter key: {key}")
            if isinstance(value, bool):
                sql += f" AND json_extract(data, '$.{key}') = ?"
                args.append(1 if value else 0)
            elif value is None:
                sql += f" AND json_extract(data, '$.{key}') IS NULL"
            else:
                sql += f" AND json_extract(data, '$.{key}') = ?"
                args.append(value)
        if since is not None:
            sql += " AND updated_at >= ?"
            args.append(utc_isoformat(since))
        sql += " ORDER BY updated_at DESC LIMIT ?"
        args.append(int(limit))
        with self._lock:
            rows = self._conn().execute(sql, args).fetchall()
        return [json.loads(r[0]) for r in rows]


# ---------------------------------------------------------------------------
# Firestore implementation (GCP)
# ---------------------------------------------------------------------------


class FirestoreStore:
    """Firestore (native mode) layout:

    cases/{case_id} · escalations/{escalation_id} · idempotency/{key} · kv/{key}
    counters/{prefix} · config/current · config_history/{ts} · claims/{key}
    roster/{burson|slrr_im} · proposals/{id} · facts/{id} · outbox/{id}
    """

    def __init__(self, project: str | None = None, database: str = "(default)"):
        from google.cloud import firestore  # lazy import

        self._fs = firestore
        self.db = firestore.Client(project=project, database=database)

    def _doc(self, collection: str, doc_id: str):
        return self.db.collection(collection).document(doc_id.replace("/", "_"))

    @staticmethod
    def _dump(model) -> dict:
        return json.loads(model.model_dump_json())

    # idempotency
    def get_idempotent(self, key):
        snap = self._doc("idempotency", key).get()
        return snap.to_dict() if snap.exists else None

    def put_idempotent(self, key, response):
        self._doc("idempotency", key).set({**response, "_stored_at": utcnow()})

    def claim_idempotent(self, key, ttl_s=120):
        ref = self._doc("claims", key)
        transaction = self.db.transaction()
        now = utcnow()

        @self._fs.transactional
        def _claim(tx):
            snap = ref.get(transaction=tx)
            if snap.exists:
                claimed_at = snap.get("claimed_at")
                if claimed_at is not None and (now - claimed_at).total_seconds() < ttl_s:
                    return False
            tx.set(ref, {"claimed_at": now})
            return True

        return _claim(transaction)

    def release_idempotent(self, key):
        self._doc("claims", key).delete()

    # ids
    def next_id(self, prefix):
        ref = self._doc("counters", prefix)
        transaction = self.db.transaction()

        @self._fs.transactional
        def _increment(tx):
            snap = ref.get(transaction=tx)
            value = (snap.get("value") if snap.exists else ID_START) + 1
            tx.set(ref, {"value": value})
            return value

        return f"{prefix}-{_increment(transaction)}"

    # kv
    def get_kv(self, key):
        snap = self._doc("kv", key).get()
        return snap.to_dict() if snap.exists else None

    def put_kv(self, key, value):
        self._doc("kv", key).set(value)

    # cases
    def get_case(self, case_id):
        snap = self._doc("cases", case_id).get()
        return Case.model_validate(snap.to_dict()) if snap.exists else None

    def find_case_by_record_key(self, record_key, source=None):
        q = self.db.collection("cases").where("record_key", "==", record_key)
        if source:
            q = q.where("source", "==", source)
        q = q.order_by("updated_at", direction=self._fs.Query.DESCENDING).limit(1)
        docs = list(q.stream())
        return Case.model_validate(docs[0].to_dict()) if docs else None

    def find_case_by_source_ref(self, source, source_ref):
        q = (
            self.db.collection("cases")
            .where("source", "==", source)
            .where("source_ref", "==", source_ref)
            .limit(1)
        )
        docs = list(q.stream())
        return Case.model_validate(docs[0].to_dict()) if docs else None

    def find_case_by_message_ref(self, ref):
        key = message_key(ref)
        if not key:
            return None
        docs = list(self.db.collection("cases").where("clean_message_key", "==", key).limit(1).stream())
        return Case.model_validate(docs[0].to_dict()) if docs else None

    def save_case(self, case):
        case.updated_at = utcnow()
        self._doc("cases", case.case_id).set(self._dump(case))

    def list_cases(self, statuses=None, since=None, limit=200, exposure_tag=None, source=None):
        q = self.db.collection("cases")
        if statuses:
            q = q.where("status", "in", [s.value for s in statuses])
        if exposure_tag:
            q = q.where("exposure_tag", "==", exposure_tag)
        if source:
            q = q.where("source", "==", source)
        if since:  # updated_at is stored as UTC text, so the bound must be UTC text too
            q = q.where("updated_at", ">=", utc_isoformat(since))
        q = q.order_by("updated_at", direction=self._fs.Query.DESCENDING).limit(limit)
        return [Case.model_validate(d.to_dict()) for d in q.stream()]

    # escalations
    def get_escalation(self, escalation_id):
        snap = self._doc("escalations", escalation_id).get()
        return Escalation.model_validate(snap.to_dict()) if snap.exists else None

    def list_escalations(self, case_id=None, analyst_email=None, open_only=False, limit=200):
        q = self.db.collection("escalations")
        if case_id:
            q = q.where("case_id", "==", case_id)
        if analyst_email:
            q = q.where("analyst_email", "==", analyst_email)
        q = q.order_by("updated_at", direction=self._fs.Query.DESCENDING).limit(limit if not open_only else 1000)
        items = [Escalation.model_validate(d.to_dict()) for d in q.stream()]
        if open_only:
            items = [e for e in items if escalation_is_open(e)]
        return items[:limit]

    def save_escalation(self, esc):
        esc.updated_at = utcnow()
        self._doc("escalations", esc.escalation_id).set(self._dump(esc))

    # config
    def get_config_overrides(self):
        snap = self._doc("config", "current").get()
        return (snap.to_dict() or {}).get("overrides", {}) if snap.exists else {}

    def save_config_overrides(self, overrides, actor, note=""):
        now = utcnow().isoformat()
        payload = {"overrides": overrides, "updated_by": actor, "updated_at": now, "note": note}
        self._doc("config", "current").set(payload)
        self._doc("config_history", now).set(payload)

    def config_history(self, limit=20):
        q = self.db.collection("config_history").order_by("updated_at", direction=self._fs.Query.DESCENDING)
        return [d.to_dict() for d in q.limit(limit).stream()]

    # roster
    def get_roster(self, name="burson"):
        snap = self._doc("roster", name).get()
        return Roster.model_validate(snap.to_dict()) if snap.exists else None

    def save_roster(self, roster, actor, name="burson"):
        roster.updated_at = utcnow()
        roster.updated_by = actor
        self._doc("roster", name).set(self._dump(roster))

    # learning
    def save_proposal(self, proposal):
        self._doc("proposals", proposal.proposal_id).set(self._dump(proposal))

    def get_proposal(self, proposal_id):
        snap = self._doc("proposals", proposal_id).get()
        return ConfigChangeProposal.model_validate(snap.to_dict()) if snap.exists else None

    def list_proposals(self, status=None, limit=200):
        q = self.db.collection("proposals")
        if status:
            q = q.where("status", "==", status.value)
        return [ConfigChangeProposal.model_validate(d.to_dict()) for d in q.limit(limit).stream()]

    def save_fact(self, fact):
        self._doc("facts", fact.fact_id).set(self._dump(fact))

    def get_fact(self, fact_id):
        snap = self._doc("facts", fact_id).get()
        return KnowledgeFact.model_validate(snap.to_dict()) if snap.exists else None

    def list_facts(self, status=None, limit=500):
        q = self.db.collection("facts")
        if status:
            q = q.where("status", "==", status.value)
        return [KnowledgeFact.model_validate(d.to_dict()) for d in q.limit(limit).stream()]

    # outbox
    def add_outbox(self, item):
        self._doc("outbox", item.outbox_id).set(self._dump(item))

    def list_outbox(self, undelivered_only=True, limit=200):
        q = self.db.collection("outbox")
        if undelivered_only:
            q = q.where("delivered_at", "==", None)
        q = q.order_by("created_at").limit(limit)
        return [OutboxItem.model_validate(d.to_dict()) for d in q.stream()]

    def mark_outbox_delivered(self, outbox_ids, delivered_by=""):
        now = utcnow().isoformat()
        batch = self.db.batch()
        for oid in outbox_ids:
            batch.update(self._doc("outbox", oid), {"delivered_at": now, "delivered_by": delivered_by or None})
        batch.commit()

    def claim_outbox(self, per_target, default_limit, claimed_by, max_chars=3500):
        transaction = self.db.transaction()
        col = self.db.collection("outbox")

        @self._fs.transactional
        def _claim(tx):
            q = col.where("delivered_at", "==", None).order_by("created_at").limit(500)
            pending = [OutboxItem.model_validate(s.to_dict()) for s in q.stream(transaction=tx)]
            chosen = _claim_plan(pending, per_target, default_limit, max_chars)
            now = utcnow()
            for item in chosen:
                item.delivered_at, item.delivered_by = now, claimed_by
                tx.update(self._doc("outbox", item.outbox_id), {"delivered_at": now.isoformat(), "delivered_by": claimed_by})
            return chosen

        return _claim(transaction)

    # generic documents: one Firestore collection each, with the write time in `_updated_at`
    def put_doc(self, collection, doc_id, data):
        self._doc(collection, doc_id).set({**json.loads(json.dumps(data, default=str)), "_updated_at": utcnow().isoformat()})

    def get_doc(self, collection, doc_id):
        snap = self._doc(collection, doc_id).get()
        if not snap.exists:
            return None
        data = snap.to_dict() or {}
        data.pop("_updated_at", None)
        return data

    def delete_doc(self, collection, doc_id):
        self._doc(collection, doc_id).delete()

    def create_doc(self, collection, doc_id, data):
        try:
            self._doc(collection, doc_id).create({**json.loads(json.dumps(data, default=str)), "_updated_at": utcnow().isoformat()})
            return True
        except Exception as exc:  # noqa: BLE001 - AlreadyExists (409) means another writer got there first
            if type(exc).__name__ in ("AlreadyExists", "Conflict"):
                return False
            raise

    def list_docs(self, collection, *, where=None, since=None, limit=200):
        col = self.db.collection(collection)
        if where:
            # Equality filters only, sorted here: no composite index is needed for any collection.
            q = col
            for key, value in where.items():
                q = q.where(key, "==", value)
            rows = [d.to_dict() or {} for d in q.limit(max(int(limit) * 5, 500)).stream()]
            if since is not None:
                floor = utc_isoformat(since)
                rows = [r for r in rows if str(r.get("_updated_at", "")) >= floor]
            rows.sort(key=lambda r: str(r.get("_updated_at", "")), reverse=True)
            rows = rows[: int(limit)]
        else:
            q = col
            if since is not None:
                q = q.where("_updated_at", ">=", utc_isoformat(since))
            q = q.order_by("_updated_at", direction=self._fs.Query.DESCENDING).limit(int(limit))
            rows = [d.to_dict() or {} for d in q.stream()]
        for r in rows:
            r.pop("_updated_at", None)
        return rows


def get_store() -> Store:
    """TRIAGE_BACKEND=gcp -> Firestore, otherwise local SQLite (TRIAGE_LOCAL_DB)."""
    if os.environ.get("TRIAGE_BACKEND", "local") == "gcp":
        return FirestoreStore(
            project=os.environ.get("TRIAGE_PROJECT_ID") or os.environ.get("GOOGLE_CLOUD_PROJECT"),
            database=os.environ.get("TRIAGE_FIRESTORE_DB", "(default)"),
        )
    return SqliteStore(os.environ.get("TRIAGE_LOCAL_DB", ".local/triage.db"))
