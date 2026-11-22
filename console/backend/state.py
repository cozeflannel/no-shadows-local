"""Shared AgentContext for the Console: built lazily from the environment, config kept fresh.

The Console imports triage_agent directly (docs/CONTRACTS.md §1). One AgentContext is
shared by all requests (SqliteStore / SqliteEventLogger and the Firestore / BigQuery
clients are safe to share). The effective config is reloaded whenever the overrides saved
in the store change, e.g. after a settings edit here or a proposal approved in chat.
"""

from __future__ import annotations

import logging
import threading
from typing import Any, Callable

from triage_agent.context import AgentContext, build_context
from triage_agent.llm import get_llm

log = logging.getLogger(__name__)


class LazyLLM:
    """Defers creating the Gemini client until an operation actually needs it.

    The Console's own endpoints never call Gemini, so the server starts without Vertex AI
    credentials; operations invoked from the Console (e.g. review_decision) get the real
    client (or FakeLLM with TRIAGE_LLM=fake) on first use.
    """

    def __init__(self, factory: Callable[[], Any] = get_llm):
        self._factory = factory
        self._llm: Any = None
        self._lock = threading.Lock()

    def _get(self) -> Any:
        if self._llm is None:
            with self._lock:
                if self._llm is None:
                    self._llm = self._factory()
        return self._llm

    def generate_json(self, **kwargs: Any) -> Any:
        return self._get().generate_json(**kwargs)

    def generate_text(self, **kwargs: Any) -> str:
        return self._get().generate_text(**kwargs)

    def last_usage(self) -> Any:
        usage = getattr(self._llm, "last_usage", None) if self._llm is not None else None
        return usage() if callable(usage) else usage

    def __getattr__(self, name: str) -> Any:  # anything else the client offers (the test double's .on / .calls)
        return getattr(self._get(), name)


def default_context_factory() -> AgentContext:
    """build_context() from env (TRIAGE_BACKEND=local -> SQLite at TRIAGE_LOCAL_DB)."""
    return build_context(llm=LazyLLM())


class ConsoleState:
    """Holds the shared AgentContext (lazy) and keeps its config in sync with the store."""

    def __init__(self, ctx: AgentContext | None = None, factory: Callable[[], AgentContext] | None = None):
        self._ctx = ctx
        self._factory = factory or default_context_factory
        self._lock = threading.RLock()
        self._overrides_seen: dict | None = None
        if ctx is not None:
            self._overrides_seen = self._read_overrides(ctx)

    @staticmethod
    def _read_overrides(ctx: AgentContext) -> dict | None:
        try:
            return ctx.store.get_config_overrides() or {}
        except Exception:  # noqa: BLE001 - store hiccup: keep the current config
            log.warning("could not read config overrides", exc_info=True)
            return None

    @property
    def ctx(self) -> AgentContext:
        if self._ctx is None:
            with self._lock:
                if self._ctx is None:
                    ctx = self._factory()
                    self._overrides_seen = self._read_overrides(ctx)
                    self._ctx = ctx
        return self._ctx

    def fresh(self) -> AgentContext:
        """The context, with config reloaded if the stored overrides changed since last use."""
        ctx = self.ctx
        current = self._read_overrides(ctx)
        if current is not None and current != self._overrides_seen:
            with self._lock:
                ctx.reload_config()
                self._overrides_seen = current
        return ctx

    def reload(self) -> AgentContext:
        """Force a config reload (after this process saved new overrides)."""
        ctx = self.ctx
        with self._lock:
            ctx.reload_config()
            self._overrides_seen = self._read_overrides(ctx)
        return ctx
