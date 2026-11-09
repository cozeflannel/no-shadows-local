"""Studio add-on contract: generated manifest is current, requests match the Python payload models,
and a real request from the add-on runs through the dispatcher end to end."""

import json
import shutil
import subprocess
import sys
import typing
from pathlib import Path

import pytest

from triage_agent.models import STUDIO_OUTPUT_KEYS, ChatMessage, InboundEmail, OperationName, ReactionEvent
from triage_agent.operations import handle

ROOT = Path(__file__).resolve().parent.parent
ADDON = ROOT / "studio-addon"
NODE = shutil.which("node")


def harness(*args: str) -> dict:
    out = subprocess.run([NODE, str(ADDON / "test" / "harness.js"), *args], capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


def test_manifest_is_generated_from_the_contract():
    res = subprocess.run([sys.executable, str(ADDON / "build_manifest.py"), "--check"], capture_output=True, text=True)
    assert res.returncode == 0, res.stdout + res.stderr
    manifest = json.loads((ADDON / "appsscript.json").read_text())
    steps_gs = (ADDON / "Steps.gs").read_text()
    for el in manifest["addOns"]["flows"]["workflowElements"]:
        wa = el["workflowAction"]
        assert f"function {wa['onExecuteFunction']}(" in steps_gs and f"function {wa['onConfigFunction']}(" in steps_gs
        if el["id"] != "inspect_variables":
            assert [o["id"] for o in wa["outputs"]] == list(STUDIO_OUTPUT_KEYS)
            assert {"targets", "flow"} <= {i["id"] for i in wa["inputs"]}
    assert "https://www.googleapis.com/auth/cloud-platform" in manifest["oauthScopes"]


@pytest.mark.skipif(NODE is None, reason="node not installed")
def test_addon_requests_match_payload_models():
    ops = set(typing.get_args(OperationName))
    results = {r["step"]: r for r in harness()["results"]}
    for step, r in results.items():
        if step == "inspect_variables":
            assert r["request"] is None and set(r["outputs"]) == {"summary"}
            continue
        body = r["request"]["body"]
        assert body["class_method"] == "query" and body["input"]["op"] in ops
        assert r["request"]["headers"]["Authorization"] == "Bearer TOKEN"
        assert list(r["outputs"]) == list(STUDIO_OUTPUT_KEYS)
        payload = body["input"]["payload"]
        if step in ("triage_alert", "converse"):
            ChatMessage.model_validate(payload["message"])
        elif step == "record_reaction":
            ReactionEvent.model_validate(payload)
        elif step == "ingest_email":
            email = InboundEmail.model_validate(payload)
            assert email.from_email == "watchdog@tns.test" and email.to == ["a@ops.test", "b@ops.test"]
    assert results["converse"]["request"]["body"]["input"]["payload"]["message"]["conversation_type"] == "DM"
    assert results["triage_alert"]["request"]["body"]["input"]["context"]["targets"] == ["burson", "clean", "dm", "youtube", "doodle"]


@pytest.mark.skipif(NODE is None, reason="node not installed")
def test_transient_agent_errors_are_retryable():
    r = harness("--error", "503")["results"][0]
    assert r["kind"] == "ReturnElementError" and r["error_retryability"] == "RETRYABLE"
    r = harness("--error", "403")["results"][0]
    assert r["error_retryability"] == "NOT_RETRYABLE" and r["error_actionability"] == "ACTIONABLE"


@pytest.mark.skipif(NODE is None, reason="node not installed")
def test_addon_request_runs_through_dispatcher(ctx, fake_llm):
    fake_llm.on("triage.assess", {"checks": [], "enrichment": {}})
    request = {r["step"]: r for r in harness()["results"]}["triage_alert"]["request"]["body"]["input"]
    from conftest import GOOD_ALERT

    request["payload"]["message"]["text"] = GOOD_ALERT
    resp = handle(request, ctx)
    assert resp.ok and resp.outputs["has_clean"] == "yes" and list(resp.outputs) == list(STUDIO_OUTPUT_KEYS)
