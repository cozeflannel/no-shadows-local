"""Where the AI runs.

In the Console and the agent every model call is made by the app's own Python on Google Cloud (Cloud Run, the Agent
Runtime) to Vertex AI, runs inside BigQuery, or goes to Gemini Decisions. None is made from Apps Script, and none of
the Python reaches Apps Script. These checks read the source: a change that calls a model another way, or calls
Apps Script, fails here. The sheet-based bot (`apps-script-chat-bot/`) is the older app and is not part of this.
"""

from __future__ import annotations

import re
from pathlib import Path

from test_tempcheck_form import VIEWER, client, iap  # noqa: F401 - fixtures

ROOT = Path(__file__).resolve().parents[1]
PYTHON = ("triage_agent", "console/backend", "jobs", "slrr_campaigns")  # everything that is deployed
CLIENT = "triage_agent/llm.py"  # the one place a Gemini client is made


def sources() -> list[tuple[str, str]]:
    return sorted((str(p.relative_to(ROOT)), p.read_text(encoding="utf-8")) for top in PYTHON for p in (ROOT / top).rglob("*.py"))


def named_in(pattern: str) -> list[str]:
    return [path for path, text in sources() if re.search(pattern, text)]


def test_no_python_code_reaches_apps_script():
    hits = [f"{path}:{n}" for path, text in sources() for n, line in enumerate(text.splitlines(), 1)
            if re.search(r"script\.google(?:apis)?\.com|scripts\.run\b|\bUrlFetchApp\b", line)]
    assert hits == [], "no deployed Python calls an Apps Script web app or the Apps Script API"


def test_gemini_is_only_reached_through_one_vertex_ai_client():
    assert named_in(r"genai\.Client\(") == [CLIENT], "one module makes the Gemini client"
    llm = (ROOT / CLIENT).read_text(encoding="utf-8")
    made = re.findall(r"genai\.Client\((.*?)\)\n", llm, re.S)
    assert len(made) == 2 and all("vertexai=True" in args and "api_key" not in args for args in made), "both are Vertex AI clients, signed in as the service"
    assert named_in(r"\.(?:generate_content|embed_content)\(") == [CLIENT], "nothing calls the SDK's model methods around that client"
    assert named_in(r"import google\.generativeai|from google import generativeai|\bopenai\b|\banthropic\b") == [], "no other model SDK is used"


def test_no_python_code_calls_a_model_over_plain_http():
    assert named_in(r"publishers/google/models|:generateContent|:predict\b|:streamGenerateContent") == []


def test_the_only_other_model_hosts_are_gemini_decisions_and_the_agent_runtime():
    assert named_in(r"generativelanguage\.googleapis\.com") == ["triage_agent/config.py"], "Gemini Decisions' address is a setting"
    config = (ROOT / "triage_agent/config.py").read_text(encoding="utf-8")
    assert re.search(r'base_url: str = Field\("https://generativelanguage\.googleapis\.com", description="Where the Decisions API is reached\."\)', config)
    assert named_in(r"aiplatform\.googleapis\.com") == ["console/backend/connections.py", "console/backend/routes_admin.py", "triage_agent/agent_engine_app.py",
                                                         "triage_agent/agent_runtime.py"], "the last one asks the Agent Runtime to run an operation"
    for path, text in sources():
        for line in text.splitlines():
            if "aiplatform.googleapis.com" in line:
                assert "reasoningEngines" in line or ":query" in line, f"{path}: the Agent Runtime is listed or asked, no model is called: {line.strip()[:120]}"


def test_the_studio_add_on_only_hands_messages_to_the_agent():
    """The Workspace Studio add-on is the one piece of Apps Script written for this app. It is not needed when the QA
    chatbot works through its own Chat sign-in, and it calls no model: it passes a message to the Agent Runtime."""
    for gs in sorted((ROOT / "studio-addon").glob("*.gs")):
        text = gs.read_text(encoding="utf-8")
        assert not re.search(r":generateContent|publishers/google/models|generativelanguage", text), gs.name
        for line in text.splitlines():
            if "aiplatform.googleapis.com" in line:
                assert ":query" in line, f"{gs.name}: {line.strip()[:120]}"


def test_the_ai_page_says_where_each_engine_runs(client):  # noqa: F811
    engines = {e["key"]: e for e in client.get("/api/ai", headers=iap(VIEWER)).json()["engines"]}
    runs = {key: next(f["value"] for f in e["facts"] if f["label"] == "Runs on") for key, e in engines.items()}
    assert runs == {
        "gemini": "Vertex AI, called from Cloud Run and the Agent Runtime",
        "decisions": "Google's Gemini Decisions service, called from Cloud Run and the Agent Runtime",
        "bigquery": "Inside BigQuery, on Vertex AI",
        "documents": "Vertex AI embeddings, called from Cloud Run and the Agent Runtime",
    }
    assert all(e["facts"][0]["label"] == "Runs on" for e in engines.values()), "it is the first thing each card says"
