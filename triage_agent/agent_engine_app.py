"""Agent Runtime entry point (Gemini Enterprise Agent Platform, formerly Vertex AI Agent Engine).

Deployed from source files by infra/05_deploy_agent_engine.py (Python 3.12,
entrypoint `triage_agent.agent_engine_app:root_agent`, class method `query`).
Workspace Studio custom steps call:
  POST https://<region>-aiplatform.googleapis.com/v1/<resource>:query
  {"class_method": "query", "input": {"op": ..., "payload": ..., "context": ...}}
and receive {"output": OperationResponse}.
"""

import os
from typing import Any


class TriageAgentApp:
    """Custom agent template: one `query` method that dispatches operations."""

    def __init__(self, env: dict[str, str] | None = None):
        self._env = dict(env or {})
        self._ctx = None

    def set_up(self) -> None:
        for key, value in self._env.items():
            os.environ.setdefault(key, value)
        os.environ.setdefault("TRIAGE_BACKEND", "gcp")
        from .context import build_context

        self._ctx = build_context()

    def query(self, *, op: str, payload: dict[str, Any] | None = None, context: dict[str, Any] | None = None) -> dict:
        """Run one agent operation (docs/CONTRACTS.md §3) and return the OperationResponse as JSON.

        Args:
            op: operation name, e.g. "triage_message", "record_reaction", "converse", "drain_outbox", "health".
            payload: the operation's payload (e.g. {"message": ChatMessage}).
            context: RequestContext (invoked_by, flow, run_id, deliver, targets).
        """
        from .operations import handle

        if self._ctx is None:
            self.set_up()
        response = handle({"op": op, "payload": payload or {}, "context": context or {}}, self._ctx)
        return response.model_dump(mode="json")

    def register_operations(self) -> dict[str, list[str]]:
        return {"": ["query"]}


# Entrypoint object for source-file deployments (configuration comes from env_vars).
root_agent = TriageAgentApp()
