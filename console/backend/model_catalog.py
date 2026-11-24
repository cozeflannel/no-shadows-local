"""The Gemini models a Settings field can pick from: what Vertex AI offers this project, in plain words.

Every model setting in the Console is a list (console/frontend, ModelSelect). The list comes from Vertex AI's catalogue
of Google's models, read through the agent's own Gemini client (triage_agent/llm.py, the one place a Gemini client is
made), in the location the agent calls Gemini in (Settings, Gemini models, location; global unless set otherwise).
It is kept for an hour. Reading it costs nothing and asks no model anything.

Vertex AI's catalogue does not say when a model is retired, and it still lists some that are. So what is offered leaves
out: models for other jobs (speech, pictures, video, live audio, robots), experiments and dated previews, and the
generations Google has retired (1.0, 1.5, 2.0). A preview is offered and says so. The saved value of a field is always
shown, listed or not, and Other... takes any name.

Vertex AI's global catalogue lists few embedding models, while BigQuery calls one in its dataset's region, whose
catalogue lists more. So the embedding models the settings use, and the ones the regional catalogue listed (KNOWN_GOOD),
are always offered for an embedding setting.

When the catalogue cannot be read (offline, no access, a timeout), the list is made of every model the settings and
their defaults name, and a short list known to work, with source "fallback" and the reason in plain words.

`fields` says, for each model setting, which list it picks from, the model it uses when left at its default, and the
setting that default follows. Settings whose name says model but that name no Vertex AI model (Gemini Decisions, the
forecast's method and its BigQuery model) are listed with kind "none" and stay as they are.
"""

from __future__ import annotations

import os
import re
import threading
import time
from datetime import UTC, datetime
from typing import Any

from triage_agent.context import AgentContext

TTL_S = 3600            # the catalogue is kept for an hour
FALLBACK_TTL_S = 300    # a list that could not be read is asked for again after five minutes
TIMEOUT_MS = 15000      # the most a read of the catalogue may take
MOST = 500              # the most catalogue entries read

# Every setting that names a Vertex AI model: (the list it picks from, what it uses when blank, what it is for). What it
# uses when blank is another setting's path, "" when it is never blank (its own default is the default), or "none".
MODEL_FIELDS: dict[str, tuple[str, str, str]] = {
    "models.triage": ("text", "", "Triage model"),
    "models.drafting": ("text", "", "Drafting model"),
    "models.converse": ("text", "", "Conversation model"),
    "platform.chat_agent.model": ("text", "models.converse", "Console chat agent"),
    "platform.classification.model": ("text", "models.triage", "Alert classes"),
    "platform.temp_check.model": ("text", "models.drafting", "Temp check write-up"),
    "platform.stories.read_model": ("text", "models.drafting", "Reading a story"),
    "platform.own_alerts.fast_endpoint": ("text", "", "Agent alerts: first look in BigQuery"),
    "platform.own_alerts.deep_model": ("text", "", "Agent alerts: review"),
    "platform.knowledge.embedding_model": ("embedding", "none", "Document search"),
    "platform.early.embedding_endpoint": ("embedding", "", "Early Detection: grouping posts"),
    "platform.own_alerts.embedding_endpoint": ("embedding", "", "Agent alerts: grouping posts"),
}
NOT_VERTEX = ("platform.decisions.model", "platform.forecasting.model", "platform.forecasting.arima_model", "platform.forecasting.timesfm_version")
NONE_LABEL = {"platform.knowledge.embedding_model": "no embedding model: documents are searched by their words"}
# Each task on Settings, What Gemini is told: the setting whose model it uses when its version names none
# (read from where each task calls Gemini).
PURPOSE_MODELS: dict[str, str] = {
    "triage.assess": "models.triage", "triage.parse_fallback": "models.triage", "watchdog.extract": "models.triage", "tns.assess": "models.triage",
    "early.review": "models.triage", "triage.classify": "platform.classification.model",
    "escalation.draft_email": "models.drafting", "escalation.revise_email": "models.drafting",
    "converse.intent": "models.converse", "converse.answer": "models.converse", "converse.teach": "models.converse",
    "console.chat_agent": "platform.chat_agent.model",
    "temp_check.query": "platform.temp_check.model", "temp_check.suggest": "platform.temp_check.model", "temp_check.relevance": "platform.temp_check.model",
    "temp_check.writeup": "platform.temp_check.model", "temp_check.web": "platform.temp_check.model",
    "stories.read": "platform.stories.read_model", "own.review": "platform.own_alerts.deep_model",
    "qa.comprehend": "models.converse", "lessons.check": "models.converse",
}
# Known to work for this project, offered when the catalogue cannot be read: the chat models each answered Vertex AI in
# November 2026; the embedding models are in Vertex AI's catalogue for us-central1, where BigQuery's US datasets call them.
KNOWN_GOOD: dict[str, tuple[str, ...]] = {
    "text": ("gemini-4-carbon", "gemini-4-argon", "gemini-4-neon", "gemini-4-hydrogen", "gemini-3.8-flash", "gemini-3.5-flash-lite"),
    "embedding": ("gemini-embedding-001", "gemini-embedding-2", "text-embedding-005", "text-multilingual-embedding-002"),
}

_OTHER_JOBS = re.compile(r"tts|image|banana|live|audio|transcribe|translate|robotics|computer-use|omni|veo|imagen|lyria|chirp|gemma|medlm", re.I)
_RETIRED = re.compile(r"^gemini-(?:1\.0|1\.5|2\.0)(?:-|$)|^gemini-pro(?:-|$)|^gemini-ultra|^textembedding-gecko|multimodalembedding|embeddinggemma", re.I)
_TRIAL = re.compile(r"(?:^|-)exp(?:-|$)|experimental|-\d{2}-\d{2}$|-\d{2}-\d{4}$|-\d{4}-\d{2}-\d{2}$|preview-\d", re.I)
_SAYS_RETIRED = re.compile(r"DEPRECATED|RETIRED|DISCONTINUED|EXPERIMENTAL|PRIVATE_PREVIEW", re.I)
_FAMILY: tuple[tuple[str, str, int], ...] = (  # (word in the name, what it is like, its place in the list)
    ("carbon", "deepest reasoning, slowest and costs the most", 0),
    ("argon", "careful step-by-step reasoning, costs more", 1),
    ("pro", "more capable, slower and costs more", 1),
    ("neon", "balanced: careful reasoning at a good speed", 2),
    ("hydrogen", "fast and low cost", 3),
    ("flash-lite", "fastest and lowest cost, for simple jobs", 4),
    ("flash", "fast and low cost", 3),
)

_cache: dict[tuple[str, str], tuple[float, dict[str, Any]]] = {}
_lock = threading.Lock()


def _clock() -> float:
    return time.monotonic()


def forget() -> None:
    """Drops the kept catalogue (tests, and a refresh asked for by an admin)."""
    with _lock:
        _cache.clear()


# -- what a model is called and what it is like ------------------------------------------------------------------------------
def short_name(name: str) -> str:
    """A catalogue entry's name, or a saved setting, as the model's own short name (gemini-3.8-flash)."""
    return str(name or "").strip().rsplit("/", 1)[-1].split("@", 1)[0]


def kind_of(name: str) -> str:
    """embedding, text, or "" for a model no setting here can use."""
    n = short_name(name).lower()
    if "embedding" in n:
        return "" if _RETIRED.search(n) else "embedding"
    return "text" if n.startswith("gemini-") and not _OTHER_JOBS.search(n) else ""


def offered(name: str, stage: str = "") -> bool:
    """Whether the catalogue entry is offered: one a setting can use, not retired, not an experiment or dated preview, and
    not marked retired or experimental by Vertex AI itself."""
    n = short_name(name)
    return bool(kind_of(n)) and not _RETIRED.search(n) and not _TRIAL.search(n) and not _SAYS_RETIRED.search(stage or "")


def label_of(name: str) -> str:
    """gemini-3.1-flash-lite -> Gemini 3.1 Flash-Lite; gemini-3-pro-preview -> Gemini 3 Pro (preview)."""
    n = short_name(name)
    words = [w for w in n.split("-") if w and w.lower() != "preview"]
    text = " ".join(w if re.match(r"^\d", w) else w[:1].upper() + w[1:] for w in words).replace("Flash Lite", "Flash-Lite")
    return f"{text} (preview)" if "preview" in n.lower().split("-") else text


def describe(name: str) -> str:
    n = short_name(name).lower()
    if "embedding" in n:
        return ("turns text in many languages into numbers, for search and grouping" if "multilingual" in n
                else "turns text into numbers, for search and grouping")
    for word, said, _ in _FAMILY:
        if word in n:
            return said
    return "a Gemini model"


def _order(name: str) -> tuple:
    n = short_name(name).lower()
    version = re.search(r"(?:gemini|embedding)-(\d+(?:\.\d+)?)", n) or re.search(r"-(\d+)$", n)
    place = next((p for word, _, p in _FAMILY if word in n), 5)
    return (0 if n.startswith("gemini") else 1, -float(version.group(1)) if version else 0.0, place, "preview" in n, n)


# -- the settings ------------------------------------------------------------------------------------------------------------
def _at(tree: dict[str, Any], path: str) -> Any:
    node: Any = tree
    for part in path.split("."):
        node = node.get(part) if isinstance(node, dict) else None
    return node


def _uses(current: dict[str, Any], path: str, seen: tuple[str, ...] = ()) -> str:
    """The model a setting uses now: its value, or the model of the setting it follows when blank."""
    value = str(_at(current, path) or "").strip()
    if value or path in seen:
        return value
    follows = MODEL_FIELDS.get(path, ("", "", ""))[1]
    return _uses(current, follows, (*seen, path)) if follows and follows != "none" else ""


def fields(ctx: AgentContext) -> dict[str, dict[str, Any]]:
    """path -> {kind, label, blank, default, follows, none_label}: what each model setting picks from and its default."""
    from .routes_settings import default_config

    current = ctx.config.model_dump(mode="json")
    _, defaults = default_config()
    out: dict[str, dict[str, Any]] = {}
    for path, (kind, follows, label) in MODEL_FIELDS.items():
        blank = bool(follows)
        default = "" if follows == "none" else _uses(current, follows) if follows else str(_at(defaults, path) or "").strip()
        out[path] = {"kind": kind, "label": label, "blank": blank, "default": default,
                     "follows": MODEL_FIELDS[follows][2] if follows in MODEL_FIELDS else "", "none_label": NONE_LABEL.get(path, "")}
    for path in NOT_VERTEX:
        out[path] = {"kind": "none", "label": "", "blank": False, "default": "", "follows": "", "none_label": ""}
    for purpose, path in PURPOSE_MODELS.items():
        out[f"prompts.{purpose}"] = {"kind": "text", "label": purpose, "blank": True, "default": _uses(current, path), "follows": MODEL_FIELDS[path][2],
                                      "none_label": ""}
    return out


def in_use(ctx: AgentContext) -> dict[str, list[str]]:
    """model -> what it does now, by the settings."""
    current = ctx.config.model_dump(mode="json")
    out: dict[str, list[str]] = {}
    for path, (_, _, label) in MODEL_FIELDS.items():
        model = short_name(_uses(current, path))
        if model:
            out.setdefault(model, []).append(label)
    return out


# -- the catalogue -----------------------------------------------------------------------------------------------------------
def _where(ctx: AgentContext) -> tuple[Any, str, str, str]:
    """(the agent's Gemini client, its project, its location, why there is no client). The client is None offline, or
    when it could not be made here (no Google Cloud sign-in)."""
    why = ""
    try:  # the Console makes its Gemini client on first use: asking for it here may be that first use
        client = getattr(ctx.llm, "client", None)  # VertexGemini's SDK client; the offline stand-in has none
        location = str(getattr(ctx.llm, "location", "") or "")
    except Exception as exc:  # noqa: BLE001 - the settings still open, with the fallback list
        client, location, why = None, "", _why(exc)
    location = location or ctx.config.models.location or "global"
    project = (ctx.config.platform.gcp.project or os.environ.get("TRIAGE_PROJECT_ID") or os.environ.get("GOOGLE_CLOUD_PROJECT")
               or str(getattr(getattr(client, "_api_client", None), "project", "") or "")).strip()
    return client, project, location, why


def read_catalogue(client: Any) -> list[tuple[str, str]]:
    """(short name, launch stage when known) for each of Google's models in Vertex AI's catalogue."""
    out: list[tuple[str, str]] = []
    pager = client.models.list(config={"query_base": True, "page_size": 100, "http_options": {"timeout": TIMEOUT_MS}})
    for model in pager:
        name = short_name(getattr(model, "name", "") or "")
        if name:
            stage = " ".join(str(v) for v in (getattr(model, "launch_stage", None), (getattr(model, "labels", None) or {}).get("launch_stage")) if v)
            out.append((name, stage))
        if len(out) >= MOST:
            break
    return out


def _why(exc: Exception) -> str:
    text = str(exc)
    if re.search(r"\b403\b|PERMISSION_DENIED|permission", text, re.I):
        return "The Console's Google Cloud account is not allowed to read Vertex AI's list of models."
    if re.search(r"timed? ?out|timeout|deadline", text, re.I):
        return "Vertex AI took too long to send its list of models."
    if re.search(r"credential|default credentials|could not automatically determine", text, re.I):
        return "The Console is not signed in to Google Cloud here, so Vertex AI's list of models could not be read."
    return "Vertex AI's list of models could not be read just now."


def _choice(name: str, uses: dict[str, list[str]]) -> dict[str, Any]:
    return {"name": name, "label": label_of(name), "description": describe(name), "preview": "preview" in name.lower().split("-"),
            "in_use": uses.get(name, [])}


def _listed(names: list[str], uses: dict[str, list[str]]) -> dict[str, list[dict[str, Any]]]:
    grouped: dict[str, list[dict[str, Any]]] = {"text": [], "embedding": []}
    for name in sorted(set(names), key=_order):
        kind = kind_of(name)
        if kind:
            grouped[kind].append(_choice(name, uses))
    return grouped


def catalogue(ctx: AgentContext, refresh: bool = False) -> dict[str, Any]:
    """The models on offer, kept for an hour: {source, project, location, fetched_at, error, names}."""
    client, project, location, why = _where(ctx)
    key = (project, location)
    now = _clock()
    with _lock:
        hit = _cache.get(key)
    if hit and not refresh and now - hit[0] < (TTL_S if hit[1]["source"] == "vertex" else FALLBACK_TTL_S):
        return hit[1]
    entry: dict[str, Any] = {"source": "fallback", "project": project, "location": location, "fetched_at": datetime.now(UTC).isoformat(),
                             "error": "", "names": []}
    if client is None:
        entry["error"] = why or "The Console is running offline, so Vertex AI's list of models could not be read."
    else:
        try:
            names = [name for name, stage in read_catalogue(client) if offered(name, stage)]
            if names:
                entry.update(source="vertex", names=names)
            else:
                entry["error"] = "Vertex AI's list of models came back empty."
        except Exception as exc:  # noqa: BLE001 - the settings still open, with the fallback list
            entry["error"] = _why(exc)
            entry["technical"] = str(exc)[:500]
    with _lock:
        _cache[key] = (now, entry)
    return entry


def choices(ctx: AgentContext, refresh: bool = False, admin: bool = False) -> dict[str, Any]:
    """What GET /api/settings/available-models answers."""
    found = catalogue(ctx, refresh=refresh)
    uses, described = in_use(ctx), fields(ctx)
    named = [*uses, *(f["default"] for f in described.values() if f["default"])]  # every model the settings and their defaults name
    names = list(found["names"])
    if found["source"] == "vertex":  # the global catalogue lists few embedding models: those in use and the regional ones are added
        names += [n for n in named if kind_of(n) == "embedding"] + list(KNOWN_GOOD["embedding"])
    else:
        names += [*named, *KNOWN_GOOD["text"], *KNOWN_GOOD["embedding"]]
    grouped = _listed([short_name(n) for n in names], uses)
    out = {"source": found["source"], "project": found["project"], "location": found["location"], "fetched_at": found["fetched_at"],
           "error": found["error"], "text": grouped["text"], "embedding": grouped["embedding"], "fields": described}
    if admin and found.get("technical"):
        out["technical"] = found["technical"]
    return out
