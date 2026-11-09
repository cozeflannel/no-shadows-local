"""Invoke agent operations from the Console (docs/CONTRACTS.md §3).

Console calls always use context {deliver: "outbox", invoked_by: <user>, flow: "console"}:
every chat output is queued for the Studio Outbox flow. Ops that other workstreams haven't
registered yet answer 501 with a JSON error so the UI can say "not available yet".
"""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException
from fastapi.encoders import jsonable_encoder

from triage_agent.context import AgentContext
from triage_agent.operations import handle, registered_operations

from .auth import User


def op_available(op: str) -> bool:
    try:
        return op in registered_operations()
    except Exception:  # noqa: BLE001 - a broken handler module shouldn't take the Console down
        return False


def run_op(ctx: AgentContext, op: str, payload: dict[str, Any], user: User) -> dict[str, Any]:
    if not op_available(op):
        raise HTTPException(
            501,
            {
                "error": f"The '{op}' operation isn't available in this build yet. Try again after the agent is updated.",
                "code": "op_not_implemented",
                "op": op,
            },
        )
    request = {
        "op": op,
        "payload": payload,
        "context": {"deliver": "outbox", "invoked_by": user.email, "flow": "console"},
    }
    resp = handle(request, ctx)
    if not resp.ok:
        error = resp.error or "operation failed"
        status = 501 if error.startswith("Operation not implemented") else (503 if resp.retryable else 500)
        raise HTTPException(status, {"error": error, "code": "op_failed", "op": op, "retryable": resp.retryable})
    data = jsonable_encoder(resp.data or {})
    if data.get("user_error"):
        raise HTTPException(400, {"error": data["user_error"], "code": "op_rejected", "op": op})
    return {
        "ok": True,
        "op": op,
        "summary": resp.outputs.get("summary", ""),
        "case_id": resp.outputs.get("case_id") or None,
        "escalation_id": resp.outputs.get("escalation_id") or None,
        "verdict": resp.outputs.get("verdict") or None,
        "reply_text": data.get("reply_text") or "",
        "queued_outbox_ids": data.get("queued_outbox_ids") or [],
        "data": data,
    }
