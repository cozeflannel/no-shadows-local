"""Gemini Decisions: the decision maker. Typed questions about one input, answered with probabilities and no text.

The HTTP call and the API key are replaced (no network); the request the bot builds, how it reads answers, the caps,
the pause after a failure and the classifier's use of it are the real code.
"""

from __future__ import annotations

import json
from typing import Any

import pytest

from test_platform import alert, assess_ok, flags, triage  # noqa: F401 - shared helpers
from triage_agent import decisions
from triage_agent.config import ClassDef

QUESTIONS = {
    "about": {"type": "noul", "instructions": "Is it about the company?", "criteria": {"true_description": "yes", "false_description": "no"}},
    "kind": {"type": "choice", "instructions": "Which kind?", "criteria": {"Outage": "service down", "Praise": "kind words"}},
    "severity": {"type": "score", "instructions": "How severe?", "criteria": ["none: nothing", "low: a gripe", "high: an incident"]},
}
ANSWERS = {"about": {"type": "noul", "noul": 0.93, "confidence": 0.9},
           "kind": {"type": "choice", "choice": "Outage", "probabilities": {"Outage": 0.8, "Praise": 0.2}},
           "severity": {"type": "score", "score": 1.7, "probabilities": {"0": 0.1, "1": 0.2, "2": 0.7}}}


class Api:
    """The Decisions endpoint: records each request and answers with what the test queued (default: ANSWERS)."""

    def __init__(self):
        self.requests: list[dict[str, Any]] = []
        self.replies: list[tuple[int, dict[str, Any]]] = []

    def post(self, url: str, key: str, body: dict[str, Any], timeout: float) -> tuple[int, str]:
        self.requests.append({"url": url, "key": key, "body": body})
        status, reply = self.replies.pop(0) if self.replies else (200, {"answers": ANSWERS, "usage": {"total_input_tokens": 3300}})
        return status, json.dumps(reply)


@pytest.fixture
def dec(ctx, monkeypatch) -> Api:
    api = Api()
    ctx.config.platform.decisions.secret = "decisions-key"
    monkeypatch.setattr(decisions, "_post", api.post)
    monkeypatch.setattr(decisions, "_key", lambda c: "k-123")
    return api


def test_one_call_carries_the_key_in_a_header_and_the_answers_come_back_typed(ctx, dec):
    r = decisions.ask(ctx, "Posts say the service is down.", QUESTIONS, purpose="test")
    sent = dec.requests[0]
    assert sent["url"] == "https://generativelanguage.googleapis.com/v1beta/decisions" and "k-123" not in sent["url"]
    assert sent["key"] == "k-123" and sent["body"] == {"model": "gemini-decision-1", "input": "Posts say the service is down.", "questions": QUESTIONS}
    assert r["ok"] and r["tokens"] == 3300
    assert r["answers"]["about"] == {"type": "noul", "p": 0.93, "confidence": 0.9}
    assert r["answers"]["kind"]["choice"] == "Outage" and r["answers"]["kind"]["confidence"] == 0.8
    assert r["answers"]["severity"]["level"] == 2 and r["answers"]["severity"]["probabilities"] == [0.1, 0.2, 0.7]
    assert decisions.status(ctx)["today"] == {"asked": 1, "failed": 0, "refused": 0, "tokens": 3300}


def test_a_failure_is_never_retried_and_pauses_every_call_for_a_while(ctx, clock, dec):
    dec.replies = [(500, {"error": {"status": "INTERNAL"}})]
    r = decisions.ask(ctx, "text", QUESTIONS)
    assert r == {"ok": False, "why": "HTTP 500: internal"} and len(dec.requests) == 1
    skipped = decisions.ask(ctx, "text", QUESTIONS)
    assert skipped["skipped"] and "paused after a failure" in skipped["why"] and len(dec.requests) == 1
    assert decisions.status(ctx)["paused_until"]
    clock.advance(minutes=16)
    assert decisions.ask(ctx, "text", QUESTIONS)["ok"] and decisions.status(ctx)["paused_until"] == ""


def test_a_refused_input_is_counted_without_a_pause_and_an_unreadable_answer_is_a_failure(ctx, dec):
    dec.replies = [(400, {"error": {"code": "safety"}}), (200, {"answers": {"about": {"type": "noul", "noul": 7}}})]
    refused = decisions.ask(ctx, "text", QUESTIONS)
    assert refused["refused"] and "safety filter" in refused["why"]
    unreadable = decisions.ask(ctx, "text", QUESTIONS)
    assert unreadable == {"ok": False, "why": "an answer that couldn't be read (about)"}
    assert decisions.status(ctx)["today"] == {"asked": 2, "failed": 1, "refused": 1, "tokens": 0}


def test_the_day_cap_and_a_missing_key_stop_calls_before_they_are_made(ctx, dec):
    ctx.config.platform.decisions.max_per_day = 1
    assert decisions.ask(ctx, "text", QUESTIONS)["ok"]
    capped = decisions.ask(ctx, "text", QUESTIONS)
    assert capped["skipped"] and capped["why"] == "1 calls today" and len(dec.requests) == 1
    ctx.config.platform.decisions.secret = ""
    assert decisions.ask(ctx, "text", QUESTIONS)["why"] == "no API key is set (Settings, Gemini Decisions)"


def test_public_text_is_sent_without_links_handles_addresses_or_ids():
    raw = "See https://x.example/p/1 from @some_one or u/redditor, mail a.b@mail.test, id 1234567890, CVE-2026-12535  ok"
    assert decisions.clean_text(raw, 200) == "See from or , mail , id , CVE-2026-12535 ok"


def test_gemini_decisions_picks_the_class_when_it_is_sure_and_gemini_picks_when_it_is_not(ctx, fake_llm, dec):
    flags(ctx, classification_layer=True, decisions_classifier=True)
    ctx.config.platform.classification.classes = [ClassDef(name="Outage", description="service down"), ClassDef(name="Praise", description="kind words")]
    dec.replies = [(200, {"answers": {"class": {"type": "choice", "choice": "Outage", "probabilities": {"Outage": 0.91, "Praise": 0.09}}}})]
    assess_ok(fake_llm)
    triage(ctx)
    question = dec.requests[0]["body"]["questions"]["class"]
    assert question["type"] == "choice" and question["criteria"] == {"Outage": "service down", "Praise": "kind words"}
    cls = ctx.store.get_case("TRG-1001").latest.result.extra["classification"]
    assert (cls["label"], cls["confidence"], cls["trusted"], cls["decided_by"]) == ("Outage", 0.91, True, "Gemini Decisions")
    assert "triage.classify" not in [c["purpose"] for c in fake_llm.calls], "no Gemini call when Decisions is sure"

    dec.replies = [(200, {"answers": {"class": {"type": "choice", "choice": "Outage", "probabilities": {"Outage": 0.55, "Praise": 0.45}}}})]
    fake_llm.on("triage.classify", {"label": "Praise", "confidence": 0.8})
    assess_ok(fake_llm)
    triage(ctx, alert(2))
    cases = sorted(ctx.store.list_cases(), key=lambda c: c.case_id)
    second = cases[-1].latest.result.extra["classification"]
    assert (second["label"], second["decided_by"]) == ("Praise", "Gemini") and "triage.classify" in [c["purpose"] for c in fake_llm.calls]
