"""Gemini access (Vertex AI) behind a small interface, plus a test double.

All model calls go through `LLMClient` so that:
  * tests run offline with `FakeLLM`,
  * every call is tagged with a `purpose` (used for fakes, logging and evals),
  * the model name always comes from config (`AgentConfig.models`).
"""

import json
import os
import time
from typing import Any, Callable, Protocol, TypeVar

from pydantic import BaseModel

T = TypeVar("T", bound=BaseModel)


class LLMError(RuntimeError):
    pass


class LLMClient(Protocol):
    def generate_json(
        self,
        *,
        model: str,
        system: str,
        prompt: str,
        schema: type[T],
        temperature: float = 0.0,
        purpose: str = "",
    ) -> T: ...

    def generate_text(
        self,
        *,
        model: str,
        system: str,
        prompt: str,
        temperature: float = 0.3,
        purpose: str = "",
    ) -> str: ...


RETRYABLE_CODES = {429, 500, 502, 503, 504}
RETRYABLE_MARKERS = ("429", "500", "502", "503", "504", "RESOURCE_EXHAUSTED", "UNAVAILABLE", "DEADLINE_EXCEEDED")


class VertexGemini:
    """Gemini on Vertex AI via the google-genai SDK (uses ADC; no API keys).

    Location: TRIAGE_LLM_LOCATION env > `location` argument (config `models.location`) > "global".
    Gemini 3.x models are served from the global endpoint, not from us-central1.
    """

    def __init__(self, project: str | None = None, location: str | None = None, max_retries: int = 3,
                 timeout_s: float = 90.0):
        from google import genai  # lazy import
        from google.genai import types

        self._types = types
        self.location = os.environ.get("TRIAGE_LLM_LOCATION") or location or "global"
        self.client = genai.Client(
            vertexai=True,
            project=project or (os.environ.get("TRIAGE_PROJECT_ID") or os.environ.get("GOOGLE_CLOUD_PROJECT")) or "brand-social-central-data",
            location=self.location,
            http_options=types.HttpOptions(timeout=int(timeout_s * 1000)),
        )
        self.max_retries = max_retries

    @staticmethod
    def _retryable(exc: Exception) -> bool:
        code = getattr(exc, "code", None)
        if isinstance(code, int):
            return code in RETRYABLE_CODES
        return any(marker in str(exc) for marker in RETRYABLE_MARKERS)

    def _call(self, model: str, prompt: str, config: Any):
        delay = 1.0
        for attempt in range(self.max_retries):
            try:
                return self.client.models.generate_content(model=model, contents=prompt, config=config)
            except Exception as exc:  # noqa: BLE001
                if not self._retryable(exc) or attempt == self.max_retries - 1:
                    raise LLMError(f"Gemini call failed ({model} @ {self.location}): {exc}") from exc
                time.sleep(delay)
                delay *= 2
        raise LLMError("unreachable")

    def generate_json(self, *, model, system, prompt, schema, temperature=0.0, purpose=""):
        types = self._types
        config = types.GenerateContentConfig(
            system_instruction=system,
            temperature=temperature,
            response_mime_type="application/json",
            response_schema=schema,
        )
        resp = self._call(model, prompt, config)
        parsed = getattr(resp, "parsed", None)
        if isinstance(parsed, schema):
            return parsed
        text = resp.text or ""  # None when the response was blocked (safety) or empty
        if not text.strip():
            raise LLMError(f"Empty Gemini response for {purpose or schema.__name__} (blocked or no candidates)")
        try:
            return schema.model_validate_json(text)
        except Exception as exc:  # noqa: BLE001
            raise LLMError(f"Unparseable JSON for {purpose or schema.__name__}: {text[:500]}") from exc

    def generate_text(self, *, model, system, prompt, temperature=0.3, purpose=""):
        types = self._types
        config = types.GenerateContentConfig(system_instruction=system, temperature=temperature)
        resp = self._call(model, prompt, config)
        return (resp.text or "").strip()


Handler = Callable[[dict[str, Any]], Any]


class FakeLLM:
    """Deterministic stand-in for tests, evals and offline demos.

    Register responses per `purpose`:
        fake.on("triage.llm_checks", {"checks": [...]})          # static value
        fake.on("draft.email", lambda call: {...})                # computed from the call
    Unregistered purposes return `default_json` / `default_text`.
    Every call is recorded in `fake.calls`.
    """

    def __init__(self, default_json: dict | None = None, default_text: str = "OK"):
        self.handlers: dict[str, Any] = {}
        self.calls: list[dict[str, Any]] = []
        self.default_json = default_json
        self.default_text = default_text

    def on(self, purpose: str, response: Any) -> "FakeLLM":
        self.handlers[purpose] = response
        return self

    def _resolve(self, call: dict[str, Any], default: Any) -> Any:
        handler = self.handlers.get(call["purpose"], default)
        return handler(call) if callable(handler) else handler

    def generate_json(self, *, model, system, prompt, schema, temperature=0.0, purpose=""):
        call = {"kind": "json", "model": model, "system": system, "prompt": prompt, "purpose": purpose, "schema": schema}
        self.calls.append(call)
        value = self._resolve(call, self.default_json)
        if value is None:
            raise LLMError(f"FakeLLM has no JSON response for purpose={purpose!r}")
        if isinstance(value, schema):
            return value
        if isinstance(value, str):
            value = json.loads(value)
        return schema.model_validate(value)

    def generate_text(self, *, model, system, prompt, temperature=0.3, purpose=""):
        call = {"kind": "text", "model": model, "system": system, "prompt": prompt, "purpose": purpose}
        self.calls.append(call)
        return str(self._resolve(call, self.default_text))


def get_llm(location: str | None = None) -> LLMClient:
    """TRIAGE_LLM=fake -> FakeLLM (offline), otherwise Vertex AI Gemini (location: env > argument > global)."""
    if os.environ.get("TRIAGE_LLM", "vertex") == "fake":
        return FakeLLM(default_json=None)
    return VertexGemini(location=location)
