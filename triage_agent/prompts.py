"""Versioned AI behaviour: every Gemini call's instructions, model and temperature are editable from the Console.

Each call in the agent carries a `purpose` (triage.assess, escalation.draft_email, …). ManagedLLM sits in front of
the Gemini client and, per purpose, applies the active PromptVersion published in the Console:

  * system: the instructions. `{{default}}` in the text stands for the built-in instructions, so a version can add
    rules after them ("{{default}}\n\nAlso: …") or replace them outright.
  * model / temperature: optional overrides for that purpose.

With no version published the built-in behaviour is used unchanged. Every call is recorded as an `llm.usage` event
(purpose, model, prompt version, tokens when the model reports them, latency), which the cost views read.
"""

from __future__ import annotations

import logging
import threading
import time
from datetime import datetime
from typing import TYPE_CHECKING, Any, Callable

from pydantic import BaseModel

from . import telemetry
from .events import PlatformEvent

if TYPE_CHECKING:  # pragma: no cover
    from .context import AgentContext

log = logging.getLogger(__name__)

COLLECTION = "prompt_versions"
DEFAULTS = "prompt_defaults"
BUILT_IN = "built-in"
CACHE_TTL_S = 20.0

# What each purpose does, for the Console. A purpose not listed still works and shows by its name.
PURPOSES: dict[str, str] = {
    "triage.classify": "Classify an alert before it is assessed",
    "triage.assess": "Check an alert against the taxonomy and rules; propose corrections",
    "triage.parse_fallback": "Read an alert whose labels could not be parsed",
    "watchdog.extract": "Read alert fields out of a Watchdog email",
    "escalation.draft_email": "Write the Social Alert email",
    "escalation.revise_email": "Revise a draft on an IM's instruction",
    "tns.assess": "Judge Trust & Safety eligibility",
    "converse.intent": "Work out what a Chat message asks for",
    "converse.answer": "Answer a question from knowledge and live data",
    "converse.teach": "Turn a taught fact or a config request into a proposal",
    "handover.summary": "Write the shift handover",
    "console.chat_agent": "The in-Console chat agent's reasoning and tool use",
    "temp_check.writeup": "Write the temp check summary and themes",
    "temp_check.query": "Draft a search query for an issue",
    "temp_check.relevance": "Judge which posts are about the issue",
    "workforce.explain": "Explain a staffing recommendation",
}


class PromptVersion(BaseModel):
    purpose: str
    version: int
    system: str = ""  # "" = keep the built-in instructions
    model: str = ""  # "" = the model set for that part of the agent
    temperature: float | None = None
    note: str = ""
    active: bool = False
    created_by: str = ""
    created_at: datetime

    @property
    def label(self) -> str:
        return f"{self.purpose}@v{self.version}"


def _doc_id(purpose: str, version: int) -> str:
    return f"{purpose}:{version:05d}"


def list_versions(ctx: "AgentContext", purpose: str | None = None) -> list[PromptVersion]:
    rows = ctx.store.list_docs(COLLECTION, where={"purpose": purpose} if purpose else None, limit=2000)
    out = [PromptVersion.model_validate(r) for r in rows]
    out.sort(key=lambda v: (v.purpose, -v.version))
    return out


def active_version(ctx: "AgentContext", purpose: str) -> PromptVersion | None:
    return next((v for v in list_versions(ctx, purpose) if v.active), None)


def publish(ctx: "AgentContext", *, purpose: str, system: str, model: str, temperature: float | None, note: str,
            actor: str, activate: bool = True) -> PromptVersion:
    existing = list_versions(ctx, purpose)
    version = PromptVersion(purpose=purpose, version=(existing[0].version + 1 if existing else 1), system=system,
                            model=model.strip(), temperature=temperature, note=note[:500], active=False,
                            created_by=actor, created_at=ctx.now())
    ctx.store.put_doc(COLLECTION, _doc_id(purpose, version.version), version.model_dump(mode="json"))
    if activate:
        return set_active(ctx, purpose, version.version, actor)
    return version


def set_active(ctx: "AgentContext", purpose: str, version: int | None, actor: str) -> PromptVersion | None:
    """Make `version` the one in use (None = back to the built-in behaviour)."""
    from . import audit

    chosen = None
    for v in list_versions(ctx, purpose):
        want = version is not None and v.version == version
        if v.active != want:
            v.active = want
            ctx.store.put_doc(COLLECTION, _doc_id(purpose, v.version), v.model_dump(mode="json"))
        if want:
            chosen = v
    if version is not None and chosen is None:
        raise KeyError(f"{purpose} has no version {version}")
    ctx.store.put_kv("prompts:stamp", {"at": ctx.now().isoformat()})
    ctx.emit(PlatformEvent.PROMPT_PUBLISHED, actor=actor, payload={"purpose": purpose, "version": version})
    audit.record(ctx, actor=actor, action="prompt.activate", surface="console", target_type="prompt", target_id=purpose,
                 summary=f"{purpose}: now using {'v' + str(version) if version is not None else 'the built-in instructions'}")
    return chosen


def default_system(ctx: "AgentContext", purpose: str) -> str:
    """The built-in instructions for a purpose: built now where the agent can, else as last seen in a call."""
    try:
        if purpose == "triage.assess":
            from .qa.llm_assess import build_prompts

            return build_prompts(ctx.config, {})[0]
        if purpose == "triage.classify":
            from .classify import build_system

            return build_system(ctx.config)
        if purpose == "console.chat_agent":
            from .chat_agent import build_system as agent_system

            return agent_system(ctx, "")
    except Exception:  # noqa: BLE001
        log.warning("could not build the default instructions for %s", purpose, exc_info=True)
    row = ctx.store.get_doc(DEFAULTS, purpose)
    return str((row or {}).get("system") or "")


def known_purposes(ctx: "AgentContext") -> list[dict[str, Any]]:
    seen = {r.get("purpose"): r for r in ctx.store.list_docs(DEFAULTS, limit=500)}
    names = list(dict.fromkeys([*PURPOSES, *(p for p in seen if p)]))
    versions = list_versions(ctx)
    out = []
    for name in names:
        mine = [v for v in versions if v.purpose == name]
        active = next((v for v in mine if v.active), None)
        out.append({"purpose": name, "description": PURPOSES.get(name, ""), "versions": len(mine),
                    "active_version": active.version if active else None,
                    "active_model": active.model if active else "", "last_called_at": (seen.get(name) or {}).get("at")})
    return out


class ManagedLLM:
    """The Gemini client the agent uses: applies the active prompt version and records usage."""

    def __init__(self, inner: Any, ctx_getter: Callable[[], "AgentContext | None"]):
        self.inner = inner
        self._ctx = ctx_getter
        self._cache: dict[str, tuple[float, PromptVersion | None]] = {}
        self._stamp: tuple[float, Any] = (0.0, None)
        self._lock = threading.Lock()

    def __getattr__(self, name: str) -> Any:  # FakeLLM.on / .calls and anything else on the client
        return getattr(self.inner, name)

    # -- resolution -----------------------------------------------------------------------------------------
    def _active(self, ctx: "AgentContext", purpose: str) -> PromptVersion | None:
        now = time.monotonic()
        with self._lock:
            hit = self._cache.get(purpose)
            if hit and now - hit[0] < CACHE_TTL_S:
                return hit[1]
        try:
            version = active_version(ctx, purpose)
        except Exception:  # noqa: BLE001 - a store hiccup must not stop a model call
            log.warning("could not read prompt versions for %s", purpose, exc_info=True)
            version = hit[1] if hit else None
        with self._lock:
            self._cache[purpose] = (now, version)
        return version

    def invalidate(self) -> None:
        with self._lock:
            self._cache.clear()

    def _remember_default(self, ctx: "AgentContext", purpose: str, system: str) -> None:
        key = f"seen:{purpose}"
        digest = hash(system)
        with self._lock:
            if self._cache.get(key, (0.0, None))[1] == digest:
                return
            self._cache[key] = (time.monotonic(), digest)  # type: ignore[assignment]
        try:
            ctx.store.put_doc(DEFAULTS, purpose, {"purpose": purpose, "system": system[:60000], "at": ctx.now().isoformat()})
        except Exception:  # noqa: BLE001
            log.warning("could not store the default instructions of %s", purpose, exc_info=True)

    def _resolve(self, purpose: str, model: str, system: str, temperature: float) -> tuple[str, str, float, str]:
        ctx = self._ctx()
        if ctx is None or not purpose:
            return model, system, temperature, BUILT_IN
        self._remember_default(ctx, purpose, system)
        version = self._active(ctx, purpose)
        if version is None:
            return model, system, temperature, BUILT_IN
        text = version.system.replace("{{default}}", system) if version.system.strip() else system
        return (version.model or model, text, version.temperature if version.temperature is not None else temperature,
                f"v{version.version}")

    def _record(self, purpose: str, model: str, label: str, elapsed_ms: int, prompt: str, system: str, output_chars: int,
                error: str = "") -> None:
        ctx = self._ctx()
        if ctx is None:
            return
        usage = getattr(self.inner, "last_usage", None)
        usage = usage() if callable(usage) else usage
        payload: dict[str, Any] = {"purpose": purpose or "unspecified", "prompt_version": label,
                                   "input_chars": len(prompt) + len(system), "output_chars": output_chars,
                                   "input_tokens": (usage or {}).get("input_tokens"),
                                   "output_tokens": (usage or {}).get("output_tokens"), "ok": not error}
        if error:
            payload["error"] = error[:300]
        try:
            ctx.emit(PlatformEvent.LLM_USAGE, model=model, prompt_version=label, latency_ms=elapsed_ms, payload=payload)
        except Exception:  # noqa: BLE001
            log.warning("could not record model usage", exc_info=True)

    # -- LLMClient ------------------------------------------------------------------------------------------
    def generate_json(self, *, model: str, system: str, prompt: str, schema: Any, temperature: float = 0.0, purpose: str = "") -> Any:
        model, system, temperature, label = self._resolve(purpose, model, system, temperature)
        t0 = time.monotonic()
        with telemetry.span("llm.generate_json", purpose=purpose, model=model, prompt_version=label):
            try:
                out = self.inner.generate_json(model=model, system=system, prompt=prompt, schema=schema,
                                               temperature=temperature, purpose=purpose)
            except Exception as exc:
                self._record(purpose, model, label, int((time.monotonic() - t0) * 1000), prompt, system, 0, error=str(exc))
                raise
        try:
            size = len(out.model_dump_json())
        except Exception:  # noqa: BLE001
            size = 0
        self._record(purpose, model, label, int((time.monotonic() - t0) * 1000), prompt, system, size)
        return out

    def generate_text(self, *, model: str, system: str, prompt: str, temperature: float = 0.3, purpose: str = "") -> str:
        model, system, temperature, label = self._resolve(purpose, model, system, temperature)
        t0 = time.monotonic()
        with telemetry.span("llm.generate_text", purpose=purpose, model=model, prompt_version=label):
            try:
                out = self.inner.generate_text(model=model, system=system, prompt=prompt, temperature=temperature, purpose=purpose)
            except Exception as exc:
                self._record(purpose, model, label, int((time.monotonic() - t0) * 1000), prompt, system, 0, error=str(exc))
                raise
        self._record(purpose, model, label, int((time.monotonic() - t0) * 1000), prompt, system, len(out or ""))
        return out


def usage_summary(events: list[Any], prices: dict[str, Any], currency: str = "USD") -> dict[str, Any]:
    """Calls, tokens and cost by purpose and by model from `llm.usage` events. Cost only where a price is set."""
    by_purpose: dict[str, dict[str, Any]] = {}
    by_model: dict[str, dict[str, Any]] = {}
    by_day: dict[str, dict[str, Any]] = {}
    total = {"calls": 0, "errors": 0, "input_tokens": 0, "output_tokens": 0, "cost": 0.0, "unpriced_calls": 0, "untokenized_calls": 0}
    for e in events:
        if e.event_type != PlatformEvent.LLM_USAGE:
            continue
        p = e.payload or {}
        model = e.model or "unknown"
        tin, tout = p.get("input_tokens"), p.get("output_tokens")
        price = prices.get(model)
        cost = None
        if price is not None and tin is not None and tout is not None:
            pin = price.input_per_million if hasattr(price, "input_per_million") else price.get("input_per_million", 0)
            pout = price.output_per_million if hasattr(price, "output_per_million") else price.get("output_per_million", 0)
            cost = (tin * pin + tout * pout) / 1_000_000
        day = e.event_ts.date().isoformat()
        for bucket, key in ((by_purpose, p.get("purpose") or "unspecified"), (by_model, model), (by_day, day)):
            row = bucket.setdefault(key, {"key": key, "calls": 0, "errors": 0, "input_tokens": 0, "output_tokens": 0,
                                          "cost": 0.0, "latency_ms": []})
            row["calls"] += 1
            row["errors"] += 0 if p.get("ok", True) else 1
            row["input_tokens"] += tin or 0
            row["output_tokens"] += tout or 0
            row["cost"] += cost or 0.0
            if e.latency_ms is not None:
                row["latency_ms"].append(e.latency_ms)
        total["calls"] += 1
        total["errors"] += 0 if p.get("ok", True) else 1
        total["input_tokens"] += tin or 0
        total["output_tokens"] += tout or 0
        total["cost"] += cost or 0.0
        total["unpriced_calls"] += 1 if price is None else 0
        total["untokenized_calls"] += 1 if tin is None else 0

    def finish(bucket: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
        rows = []
        for row in bucket.values():
            lat = sorted(row.pop("latency_ms"))
            row["p50_ms"] = lat[len(lat) // 2] if lat else None
            row["cost"] = round(row["cost"], 4)
            rows.append(row)
        return sorted(rows, key=lambda r: (-r["cost"], -r["calls"]))

    total["cost"] = round(total["cost"], 4)
    return {"currency": currency, "total": total, "by_purpose": finish(by_purpose), "by_model": finish(by_model),
            "by_day": sorted(finish(by_day), key=lambda r: r["key"])}
