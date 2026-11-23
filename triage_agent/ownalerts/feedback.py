"""An analyst's verdict on a decision: the alert was right (TRUE_POSITIVE) or not (FALSE_POSITIVE).

The verdict is written to BigQuery, where later reviews are shown the decisions most like the one in front of them
with what the analysts said, and onto the alert's record in the Console. A changed verdict is a new row; the latest
one counts.
"""

from __future__ import annotations

import uuid
from typing import TYPE_CHECKING, Any

from ..events import PlatformEvent
from . import schema

if TYPE_CHECKING:
    from ..context import AgentContext

VERDICTS = ("TRUE_POSITIVE", "FALSE_POSITIVE")
COUNT = "own:feedback"  # {n}: how many verdicts were ever given (none yet: earlier verdicts are not looked up)


def given(ctx: "AgentContext") -> int:
    return int((ctx.store.get_kv(COUNT) or {}).get("n") or 0)


def record(ctx: "AgentContext", decision_id: str, verdict: str, actor: str) -> dict[str, Any]:
    from .. import bq_admin
    from .review import DECISIONS

    if verdict not in VERDICTS:
        raise ValueError("A verdict is TRUE_POSITIVE or FALSE_POSITIVE.")
    doc = ctx.store.get_doc(DECISIONS, decision_id)
    if doc is None:
        raise LookupError("That alert is no longer kept.")
    now = ctx.now().isoformat()
    bq_admin.get_gateway(ctx).insert_rows(schema.table(ctx, "feedback"), [
        {"feedback_id": uuid.uuid4().hex, "submitted_at": now, "decision_id": decision_id, "reviewer_email": actor, "verdict": verdict}])
    doc.update(verdict=verdict, verdict_by=actor, verdict_at=now)
    ctx.store.put_doc(DECISIONS, decision_id, doc)
    ctx.store.put_kv(COUNT, {"n": given(ctx) + 1})
    ctx.emit(PlatformEvent.OWN_FEEDBACK, actor=actor, space="console",
             payload={"decision_id": decision_id, "verdict": verdict, "severity": doc.get("severity"), "path": doc.get("path")})
    return doc
