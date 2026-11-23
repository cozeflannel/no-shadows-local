"""Settings: every model setting is a list of the Gemini models this Google Cloud project can use.

GET /api/settings/available-models reads Vertex AI's catalogue of Google's models through the agent's own Gemini client
(the real google-genai client here, its HTTP answered by a stand-in transport: no network), keeps it for an hour, and
says what each model setting picks from and what its default is. When the catalogue cannot be read, the list is the
models the settings name plus a few known to work, with source "fallback" and the reason in plain words.
"""

from __future__ import annotations

from typing import Any

import httpx
import pytest
from google import genai
from google.auth import credentials as gauth
from google.genai import types

from console.backend import model_catalog
from test_platform import ADMIN, LEAD, VIEWER, _llm, client, iap  # noqa: F401 - fixtures

URL = "/api/settings/available-models"
# What Vertex AI's catalogue answered for the project in November 2026, cut down: current models, retired ones it still
# lists, dated previews and experiments, and models for other jobs (speech, pictures, video, live audio).
CATALOGUE = [
    "gemini-1.5-pro-002", "gemini-2.5-flash-preview-04-17", "gemini-2.5-pro-exp-03-25", "gemini-2.5-pro", "gemini-2.5-flash-tts",
    "gemini-live-2.5-flash-native-audio", "gemini-3-pro-preview", "gemini-3.1-flash-lite", "gemini-3.5-flash-lite", "gemini-3.8-flash",
    "gemini-3.8-flash-tts", "gemini-3-pro-image", "gemini-nano-banana-2.1", "gemini-omni-1.2-flash", "gemini-4-argon", "gemini-4-carbon",
    "gemini-4-hydrogen", "gemini-4-neon", "gemini-embedding-001", "gemini-embedding-2", "text-embedding-005", "text-multilingual-embedding-002",
    "textembedding-gecko", "multimodalembedding", "embeddinggemma", "text-embedding-large-exp-03-07", "imagen-4.0-generate-001",
]


class Signed(gauth.Credentials):
    """A signed-in account for the client, with a token that never runs out."""

    def __init__(self):
        super().__init__()
        self.token = "test-token"

    def refresh(self, request: Any) -> None:
        self.token = "test-token"

    @property
    def expired(self) -> bool:
        return False

    @property
    def valid(self) -> bool:
        return True


class Vertex:
    """Vertex AI's HTTP API as the client sees it: records each request and answers with the catalogue, page by page."""

    def __init__(self, names: list[str], status: int = 200, page: int = 100):
        self.names, self.status, self.page = names, status, page
        self.asked: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.asked.append(request)
        if self.status != 200:
            return httpx.Response(self.status, json={"error": {"code": self.status, "status": "PERMISSION_DENIED",
                                                               "message": "Permission 'aiplatform.publishers.models.list' denied"}})
        start = int(request.url.params.get("pageToken") or 0)
        chunk = self.names[start:start + self.page]
        body: dict[str, Any] = {"publisherModels": [{"name": f"publishers/google/models/{n}", "versionId": "default", "launchStage": "GA"} for n in chunk]}
        if start + self.page < len(self.names):
            body["nextPageToken"] = str(start + self.page)
        return httpx.Response(200, json=body)


def vertex_client(api: Vertex) -> Any:
    return genai.Client(vertexai=True, project="proj", location="global", credentials=Signed(),
                        http_options=types.HttpOptions(client_args={"transport": httpx.MockTransport(api)}))


@pytest.fixture(autouse=True)
def fresh():
    model_catalog.forget()
    yield
    model_catalog.forget()


@pytest.fixture
def vertex(ctx, fake_llm):
    """The agent's Gemini client, talking to the stand-in Vertex AI."""
    api = Vertex(list(CATALOGUE))
    fake_llm.client, fake_llm.location = vertex_client(api), "global"
    ctx.config.platform.gcp.project = "proj"
    return api


def names(got: dict[str, Any], kind: str) -> list[str]:
    return [m["name"] for m in got[kind]]


def test_the_list_is_read_from_vertex_ai_through_the_agents_own_client(client, vertex):
    got = client.get(URL, headers=iap(VIEWER))
    assert got.status_code == 200
    body = got.json()
    assert body["source"] == "vertex" and body["error"] == "" and body["project"] == "proj" and body["location"] == "global"
    (asked,) = vertex.asked
    assert asked.method == "GET" and asked.url.path == "/v1beta1/publishers/google/models" and asked.url.params["pageSize"] == "100"
    assert asked.headers["authorization"] == "Bearer test-token", "signed in as the service, no key"
    assert "technical" not in body


def test_chat_models_and_embedding_models_are_listed_apart_newest_first(client, vertex):
    body = client.get(URL, headers=iap(VIEWER)).json()
    assert names(body, "text") == ["gemini-4-carbon", "gemini-4-argon", "gemini-4-neon", "gemini-4-hydrogen", "gemini-3.8-flash",
                                   "gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3-pro-preview", "gemini-2.5-pro"]
    assert names(body, "embedding") == ["gemini-embedding-2", "gemini-embedding-001", "text-embedding-005", "text-multilingual-embedding-002"]


def test_retired_models_experiments_and_models_for_other_jobs_are_left_out(client, vertex):
    body = client.get(URL, headers=iap(VIEWER)).json()
    offered = set(names(body, "text")) | set(names(body, "embedding"))
    for name in ("gemini-1.5-pro-002", "gemini-2.5-flash-preview-04-17", "gemini-2.5-pro-exp-03-25", "gemini-2.5-flash-tts", "gemini-live-2.5-flash-native-audio",
                 "gemini-3.8-flash-tts", "gemini-3-pro-image", "gemini-nano-banana-2.1", "gemini-omni-1.2-flash", "textembedding-gecko",
                 "multimodalembedding", "embeddinggemma", "text-embedding-large-exp-03-07", "imagen-4.0-generate-001"):
        assert name not in offered, name
    assert not model_catalog.offered("gemini-4-neon", "DEPRECATED"), "a model Vertex AI itself marks retired is left out"


def test_each_model_has_a_friendly_name_and_a_plain_line_and_says_when_it_is_in_use(client, vertex):
    body = client.get(URL, headers=iap(VIEWER)).json()
    by = {m["name"]: m for m in body["text"] + body["embedding"]}
    assert (by["gemini-3.8-flash"]["label"], by["gemini-3.8-flash"]["description"]) == ("Gemini 3.8 Flash", "fast and low cost")
    assert by["gemini-3.1-flash-lite"]["label"] == "Gemini 3.1 Flash-Lite" and by["gemini-3.1-flash-lite"]["description"].startswith("fastest and lowest cost")
    assert by["gemini-3-pro-preview"]["label"] == "Gemini 3 Pro (preview)" and by["gemini-3-pro-preview"]["preview"] is True
    assert by["gemini-4-carbon"]["description"] == "deepest reasoning, slowest and costs the most"
    assert by["text-embedding-005"] == {"name": "text-embedding-005", "label": "Text Embedding 005", "preview": False,
                                         "description": "turns text into numbers, for search and grouping", "in_use": ["Early Detection: grouping posts"]}
    assert "Conversation model" in by["gemini-3.8-flash"]["in_use"] and "Console chat agent" in by["gemini-3.8-flash"]["in_use"]
    assert by["gemini-4-argon"]["in_use"] == ["Agent alerts: review"] and by["gemini-4-carbon"]["in_use"] == []


def test_each_model_setting_says_its_list_and_the_model_its_default_uses(ctx, client, vertex):
    ctx.config.models.converse = "gemini-4-neon"
    fields = client.get(URL, headers=iap(VIEWER)).json()["fields"]
    chat = fields["platform.chat_agent.model"]
    assert chat == {"kind": "text", "label": "Console chat agent", "blank": True, "default": "gemini-4-neon", "follows": "Conversation model", "none_label": ""}
    assert fields["models.converse"]["default"] == "gemini-3.8-flash" and fields["models.converse"]["blank"] is False, "its own default, from the settings files"
    assert fields["platform.own_alerts.fast_endpoint"] == {"kind": "text", "label": "Agent alerts: first look in BigQuery", "blank": False,
                                                           "default": "gemini-4-hydrogen", "follows": "", "none_label": ""}
    assert fields["platform.own_alerts.embedding_endpoint"]["kind"] == "embedding" and fields["platform.own_alerts.embedding_endpoint"]["default"] == "gemini-embedding-001"
    knowledge = fields["platform.knowledge.embedding_model"]
    assert knowledge["kind"] == "embedding" and knowledge["default"] == "" and knowledge["blank"] is True and "searched by their words" in knowledge["none_label"]
    for not_vertex in ("platform.decisions.model", "platform.forecasting.arima_model", "platform.forecasting.model"):
        assert fields[not_vertex]["kind"] == "none", "named model, but not a Vertex AI model: it stays as it is"
    assert fields["prompts.converse.answer"]["default"] == "gemini-4-neon" and fields["prompts.own.review"]["default"] == "gemini-4-argon"
    ctx.config.platform.classification.model = "gemini-4-carbon"
    assert client.get(URL, headers=iap(VIEWER)).json()["fields"]["prompts.triage.classify"]["default"] == "gemini-4-carbon"


def test_an_embedding_setting_is_offered_the_models_in_use_and_the_regional_ones(ctx, client, vertex):
    """Vertex AI's global catalogue lists few embedding models; BigQuery calls one in its dataset's region."""
    vertex.names = ["gemini-3.8-flash", "gemini-embedding-2"]
    ctx.config.platform.knowledge.embedding_model = "text-embedding-004"
    body = client.get(URL, headers=iap(VIEWER)).json()
    assert body["source"] == "vertex" and names(body, "text") == ["gemini-3.8-flash"]
    assert names(body, "embedding") == ["gemini-embedding-2", "gemini-embedding-001", "text-embedding-005", "text-embedding-004",
                                        "text-multilingual-embedding-002"]


def test_every_paged_answer_is_read(client, vertex):
    vertex.page = 5
    body = client.get(URL, headers=iap(VIEWER)).json()
    assert len(vertex.asked) == 6 and len(body["text"]) == 9 and len(body["embedding"]) == 4


def test_the_list_is_kept_for_an_hour_and_an_admin_can_read_it_again(client, vertex, monkeypatch):
    clock = [1000.0]
    monkeypatch.setattr(model_catalog, "_clock", lambda: clock[0])
    client.get(URL, headers=iap(VIEWER))
    client.get(URL, headers=iap(VIEWER))
    assert len(vertex.asked) == 1
    client.get(URL, params={"refresh": True}, headers=iap(LEAD))
    assert len(vertex.asked) == 1, "only an admin can make it read the list again"
    client.get(URL, params={"refresh": True}, headers=iap(ADMIN))
    assert len(vertex.asked) == 2
    clock[0] += model_catalog.TTL_S + 1
    client.get(URL, headers=iap(VIEWER))
    assert len(vertex.asked) == 3


def test_when_vertex_ai_refuses_the_list_is_the_models_already_set_and_ones_known_to_work(ctx, client, vertex):
    vertex.status = 403
    ctx.config.platform.chat_agent.model = "gemini-3.7-flash"
    body = client.get(URL, headers=iap(VIEWER)).json()
    assert body["source"] == "fallback"
    assert body["error"] == "The Console's Google Cloud account is not allowed to read Vertex AI's list of models."
    text = names(body, "text")
    for model in ("gemini-3.7-flash", "gemini-3.8-flash", "gemini-4-hydrogen", "gemini-4-argon", *model_catalog.KNOWN_GOOD["text"]):
        assert model in text, model
    assert set(model_catalog.KNOWN_GOOD["embedding"]) <= set(names(body, "embedding")) and "gemini-embedding-001" in names(body, "embedding")
    assert "technical" not in body, "Google's own words are for admins"
    admin = client.get(URL, headers=iap(ADMIN)).json()
    assert "403" in admin["technical"] and admin["fields"]["platform.chat_agent.model"]["blank"] is True


def test_offline_the_fallback_list_says_so_in_plain_words(client):
    body = client.get(URL, headers=iap(VIEWER)).json()
    assert body["source"] == "fallback" and body["error"] == "The Console is running offline, so Vertex AI's list of models could not be read."
    assert "gemini-3.8-flash" in names(body, "text") and body["fields"]["models.triage"]["default"] == "gemini-3.8-flash"


def test_the_list_does_not_take_the_place_of_the_models_section(client):
    section = client.get("/api/settings/models", headers=iap(VIEWER))
    assert section.status_code == 200 and section.json()["section"] == "models", "a section's name has no hyphen: the two cannot clash"
    assert client.get(URL, headers=iap("stranger@elsewhere.test")).status_code == 403
