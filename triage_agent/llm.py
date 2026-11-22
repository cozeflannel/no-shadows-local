"""Gemini access (Vertex AI) behind a small interface, plus a test double.

All model calls go through `LLMClient` so that:
  * tests run offline with `FakeLLM`,
  * every call is tagged with a `purpose` (used for fakes, logging and evals),
  * the model name always comes from config (`AgentConfig.models`).
"""

import json
import os
import threading
import time
from typing import Any, Callable, Protocol, TypeVar

from pydantic import BaseModel

T = TypeVar("T", bound=BaseModel)


class LLMError(RuntimeError):
    pass


class WebSource(BaseModel):
    """One page a searched answer rests on, as Google gave it. `uri` is Google's own link to the page."""

    title: str = ""
    domain: str = ""
    uri: str = ""


class WebCite(BaseModel):
    """The answer's characters from `start` up to `end` rest on these sources (positions in `WebFound.sources`)."""

    start: int = 0
    end: int
    sources: list[int] = []


class WebFound(BaseModel):
    """A searched answer: Gemini's words, the searches Google ran, the pages found, which words rest on which page,
    and Google's search suggestions as the HTML Google gave (shown unchanged wherever the answer is shown)."""

    text: str = ""
    queries: list[str] = []
    sources: list[WebSource] = []
    cites: list[WebCite] = []
    suggestions: str = ""


WEB_SEARCHES = ("google", "enterprise")  # Grounding with Google Search | Web Grounding for Enterprise


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

    def search_web(
        self,
        *,
        model: str,
        system: str,
        prompt: str,
        search: str = "google",
        exclude_sites: list[str] | None = None,
        temperature: float = 1.0,
        purpose: str = "",
    ) -> WebFound: ...


RETRYABLE_CODES = {429, 500, 502, 503, 504}
RETRYABLE_MARKERS = ("429", "500", "502", "503", "504", "RESOURCE_EXHAUSTED", "UNAVAILABLE", "DEADLINE_EXCEEDED")


class VertexGemini:
    """Gemini on Vertex AI via the google-genai SDK (uses ADC; no API keys).

    Location: TRIAGE_LLM_LOCATION env > `location` argument (config `models.location`) > "global".
    Gemini 3.x models are served from the global endpoint, not from us-central1.
    """

    def __init__(self, project: str | None = None, location: str | None = None, max_retries: int = 3,
                 timeout_s: float = 90.0, client: Any = None):
        from google import genai  # lazy import
        from google.genai import types

        self._types = types
        self.location = os.environ.get("TRIAGE_LLM_LOCATION") or location or "global"
        self.client = client or genai.Client(
            vertexai=True,
            project=project or os.environ.get("TRIAGE_PROJECT_ID") or os.environ.get("GOOGLE_CLOUD_PROJECT") or None,
            location=self.location,
            http_options=types.HttpOptions(timeout=int(timeout_s * 1000)),
        )
        self.max_retries = max_retries
        self._usage = threading.local()

    def last_usage(self) -> dict[str, Any] | None:
        """Token counts of this thread's most recent call, as the model reported them."""
        return getattr(self._usage, "value", None)

    def _note_usage(self, resp: Any) -> None:
        meta = getattr(resp, "usage_metadata", None)
        self._usage.value = None if meta is None else {
            "input_tokens": getattr(meta, "prompt_token_count", None),
            "output_tokens": getattr(meta, "candidates_token_count", None),
        }

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
                resp = self.client.models.generate_content(model=model, contents=prompt, config=config)
                self._note_usage(resp)
                return resp
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

    def search_web(self, *, model, system, prompt, search="google", exclude_sites=None, temperature=1.0, purpose=""):
        """Gemini answering from a web search it runs itself: Grounding with Google Search, or Web Grounding for
        Enterprise. The answer is read as words and sources; nothing is asked for as a form."""
        types = self._types
        if search not in WEB_SEARCHES:
            raise LLMError(f"Web search is google or enterprise, not {search!r}")
        leave_out = [s for s in (exclude_sites or []) if s] or None
        tool = (types.Tool(google_search=types.GoogleSearch(exclude_domains=leave_out)) if search == "google"
                else types.Tool(enterprise_web_search=types.EnterpriseWebSearch(exclude_domains=leave_out)))
        config = types.GenerateContentConfig(system_instruction=system, temperature=temperature, tools=[tool])
        found = _web_found(self._call(model, prompt, config))
        if not found.text.strip():
            raise LLMError(f"Empty Gemini response for {purpose or 'a web search'} (blocked or no candidates)")
        return found

    def embed(self, *, texts: list[str], model: str, dimensions: int | None = None, location: str | None = None) -> list[list[float]]:
        """Embeddings for retrieval (model from Settings → Knowledge). Batches of 50."""
        types = self._types
        client = self.client
        if location and location != self.location:
            from google import genai

            client = genai.Client(vertexai=True, project=self.client._api_client.project, location=location)
        config = types.EmbedContentConfig(output_dimensionality=dimensions) if dimensions else None
        out: list[list[float]] = []
        for start in range(0, len(texts), 50):
            batch = texts[start:start + 50]
            try:
                resp = client.models.embed_content(model=model, contents=batch, config=config)
            except Exception as exc:  # noqa: BLE001
                raise LLMError(f"Embedding call failed ({model}): {exc}") from exc
            out.extend([list(e.values) for e in resp.embeddings])
        return out


def _web_found(resp: Any) -> WebFound:
    """A searched answer out of the SDK's response. The API says where a citation ends in bytes of one part of the
    answer; here it is a character position in the whole answer. Gemini's thinking aloud is not part of the answer."""
    candidates = getattr(resp, "candidates", None) or []
    if not candidates:
        return WebFound()
    parts = getattr(getattr(candidates[0], "content", None), "parts", None) or []
    text, starts = "", {}  # part number -> (where its words start in the answer, its words)
    for i, part in enumerate(parts):
        words = getattr(part, "text", None)
        if not words or getattr(part, "thought", None):
            continue
        starts[i] = (len(text), words)
        text += words
    meta = getattr(candidates[0], "grounding_metadata", None)
    if meta is None:
        return WebFound(text=text)
    sources, place = [], {}  # place: the API's chunk number -> its position among the sources kept
    for i, chunk in enumerate(getattr(meta, "grounding_chunks", None) or []):
        page = getattr(chunk, "web", None) or getattr(chunk, "retrieved_context", None)  # as the sheet-based bot reads them
        if page is None or not getattr(page, "uri", None):
            continue
        place[i] = len(sources)
        sources.append(WebSource(title=getattr(page, "title", None) or "", domain=getattr(page, "domain", None) or "", uri=page.uri))
    cites = []
    for support in getattr(meta, "grounding_supports", None) or []:
        seg = getattr(support, "segment", None)
        where = starts.get((getattr(seg, "part_index", None) or 0) if seg is not None else -1)
        named = [place[i] for i in (getattr(support, "grounding_chunk_indices", None) or []) if i in place]
        if where is None or not named or getattr(seg, "end_index", None) is None:
            continue
        raw = where[1].encode("utf-8")
        chars = lambda n: len(raw[: max(0, n)].decode("utf-8", errors="ignore"))  # noqa: E731 - bytes into the part -> characters
        cites.append(WebCite(start=where[0] + chars(seg.start_index or 0), end=where[0] + chars(seg.end_index), sources=named))
    entry = getattr(meta, "search_entry_point", None)
    return WebFound(text=text, queries=[q for q in (getattr(meta, "web_search_queries", None) or []) if q], sources=sources, cites=cites,
                    suggestions=(getattr(entry, "rendered_content", None) or "") if entry is not None else "")


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

    def search_web(self, *, model, system, prompt, search="google", exclude_sites=None, temperature=1.0, purpose=""):
        call = {"kind": "web", "model": model, "system": system, "prompt": prompt, "purpose": purpose, "search": search,
                "exclude_sites": list(exclude_sites or []), "temperature": temperature}
        self.calls.append(call)
        value = self._resolve(call, None)
        if value is None:
            raise LLMError(f"FakeLLM has no web search answer for purpose={purpose!r}")
        return value if isinstance(value, WebFound) else WebFound.model_validate(value)


def get_llm(location: str | None = None, project: str | None = None) -> LLMClient:
    """TRIAGE_LLM=fake -> FakeLLM (offline), otherwise Vertex AI Gemini (location: env > argument > global)."""
    if os.environ.get("TRIAGE_LLM", "vertex") == "fake":
        return FakeLLM(default_json=None)
    return VertexGemini(project=project or None, location=location)
