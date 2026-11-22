"""Audit log: one entry for every action taken through the agent or the Console.

Entries are written to the store's `audit` collection (read by the Console's audit viewer) and mirrored into the
event stream as `audit.recorded`, so BigQuery holds the long history. Writing never raises: an audit failure must
not fail the action it records, but it is logged loudly.
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime
from typing import TYPE_CHECKING, Any, Literal

from pydantic import BaseModel, Field

from .events import PlatformEvent
from .models import utcnow

if TYPE_CHECKING:  # pragma: no cover
    from .context import AgentContext

log = logging.getLogger(__name__)

COLLECTION = "audit"
Surface = Literal["console", "chat", "agent", "job", "pubsub", "chat_agent", "system"]
_MAX_DETAIL_CHARS = 4000


class AuditEntry(BaseModel):
    audit_id: str
    ts: datetime
    actor: str = "agent"
    surface: Surface = "agent"
    action: str  # e.g. "settings.update", "op.review_decision", "tool.run_temp_check"
    target_type: str = ""  # case | escalation | setting | roster | secret | bigquery | knowledge | ...
    target_id: str = ""
    summary: str = ""
    status: Literal["ok", "error", "denied", "blocked"] = "ok"
    case_id: str | None = None
    escalation_id: str | None = None
    detail: dict[str, Any] = Field(default_factory=dict)
    env: str = "dev"


_SECRET_KEYS = ("secret", "token", "password", "credential", "authorization", "api_key", "apikey", "private_key")


def redact(value: Any, depth: int = 0) -> Any:
    """A copy safe to keep: values under secret-looking keys are dropped, long strings cut."""
    if depth > 6:
        return "…"
    if isinstance(value, dict):
        out = {}
        for k, v in value.items():
            if any(s in str(k).lower() for s in _SECRET_KEYS):
                out[str(k)] = "[redacted]"
            else:
                out[str(k)] = redact(v, depth + 1)
        return out
    if isinstance(value, (list, tuple)):
        return [redact(v, depth + 1) for v in list(value)[:50]]
    if isinstance(value, str):
        return value if len(value) <= 600 else value[:600] + "…"
    if isinstance(value, (int, float, bool)) or value is None:
        return value
    return str(value)[:300]


def record(ctx: "AgentContext", *, actor: str, action: str, surface: Surface = "agent", target_type: str = "",
           target_id: str = "", summary: str = "", status: str = "ok", case_id: str | None = None,
           escalation_id: str | None = None, detail: dict[str, Any] | None = None) -> AuditEntry | None:
    try:
        clean = redact(detail or {})
        if len(str(clean)) > _MAX_DETAIL_CHARS:
            clean = {"truncated": str(clean)[:_MAX_DETAIL_CHARS]}
        entry = AuditEntry(
            audit_id=f"AUD-{uuid.uuid4().hex[:16]}", ts=ctx.now(), actor=(actor or "agent"), surface=surface, action=action,
            target_type=target_type, target_id=str(target_id or ""), summary=(summary or "")[:500],
            status=status,  # type: ignore[arg-type]
            case_id=case_id, escalation_id=escalation_id, detail=clean, env=ctx.config.env,
        )
        ctx.store.put_doc(COLLECTION, entry.audit_id, entry.model_dump(mode="json"))
        ctx.emit(PlatformEvent.AUDIT_RECORDED, actor=entry.actor, case_id=case_id, escalation_id=escalation_id,
                 space="console" if surface in ("console", "chat_agent") else "system",
                 payload={"audit_id": entry.audit_id, "action": action, "surface": surface, "target_type": target_type,
                          "target_id": entry.target_id, "status": status, "summary": entry.summary})
        return entry
    except Exception:  # noqa: BLE001 - never fail the audited action
        log.exception("audit write failed for action=%s actor=%s", action, actor)
        return None


def search(ctx: "AgentContext", *, actor: str | None = None, surface: str | None = None, action_prefix: str | None = None,
           case_id: str | None = None, status: str | None = None, q: str | None = None, since: datetime | None = None,
           limit: int = 200) -> list[AuditEntry]:
    where: dict[str, Any] = {}
    if actor:
        where["actor"] = actor.strip().lower()
    if surface:
        where["surface"] = surface
    if case_id:
        where["case_id"] = case_id
    if status:
        where["status"] = status
    scan = limit if not (action_prefix or q) else max(limit * 10, 2000)
    rows = ctx.store.list_docs(COLLECTION, where=where or None, since=since, limit=scan)
    out: list[AuditEntry] = []
    needle = (q or "").strip().lower()
    for row in rows:
        if action_prefix and not str(row.get("action", "")).startswith(action_prefix):
            continue
        if needle and needle not in (f"{row.get('summary', '')} {row.get('action', '')} {row.get('target_id', '')} "
                                     f"{row.get('actor', '')}").lower():
            continue
        out.append(AuditEntry.model_validate(row))
        if len(out) >= limit:
            break
    return out


def now_or(value: datetime | None) -> datetime:
    return value or utcnow()
