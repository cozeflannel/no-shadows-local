"""Ask the deployed Agent Runtime ("SLRR Triage Agent") to run one operation.

The runtime runs the same operations as this code (triage_agent.agent_engine_app). The Workspace Studio flows call
it the same way: its `query` method, with the operation, its payload and its context. No model is called from here.
"""

from __future__ import annotations

import re
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from .context import AgentContext

SCOPE = "https://www.googleapis.com/auth/cloud-platform"
_RESOURCE = re.compile(r"projects/[^/]+/locations/([\w-]+)/reasoningEngines/[^/]+")


class Unreachable(RuntimeError):
    """The Agent Runtime did not run the operation."""


def session() -> Any:
    import google.auth
    from google.auth.transport.requests import AuthorizedSession

    creds, _ = google.auth.default(scopes=[SCOPE])
    return AuthorizedSession(creds)


def query(ctx: "AgentContext", op: str, payload: dict[str, Any], context: dict[str, Any], timeout: float) -> dict[str, Any]:
    """The operation's answer as the runtime gives it: {ok, op, outputs, data, error, retryable}."""
    resource = ctx.config.platform.gcp.agent_runtime_resource.strip()
    found = _RESOURCE.fullmatch(resource)
    if not found:
        raise Unreachable("No Agent Runtime is set (Integrations)")
    url = f"https://{found.group(1)}-aiplatform.googleapis.com/v1/{resource}:query"
    try:
        reply = session().post(url, json={"class_method": "query", "input": {"op": op, "payload": payload, "context": context}}, timeout=timeout)
    except Exception as exc:  # whatever stopped the call, the caller carries on without the runtime
        raise Unreachable(f"The Agent Runtime could not be reached: {exc}") from exc
    if reply.status_code != 200:
        raise Unreachable(f"The Agent Runtime answered {reply.status_code}: {str(reply.text)[:200]}")
    out = (reply.json() or {}).get("output")
    if not isinstance(out, dict):
        raise Unreachable("The Agent Runtime's answer was not an operation's answer")
    return out
