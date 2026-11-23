"""The Dashboard's alert lines: counts of alert messages by [Product(s)] / [Social Network] / [Exposure Tag] /
[Sensitive Topic] / [KOF] and sentiment, the filters (in the API and on every number), and the response times.

Alerts go through the real pipeline on a SQLite store (`handle()`), the API through the FastAPI app.
"""

from __future__ import annotations

import json
import warnings
from datetime import timedelta
from typing import Any

import pytest

from conftest import GOOD_ALERT, make_message
from console.backend.app import create_app
from triage_agent import storyread
from triage_agent.events import EventType as E
from triage_agent.events import make_event
from triage_agent.metrics import NO_TOPIC, alert_facts, alert_view, matching_messages, response_times
from triage_agent.models import Attempt
from triage_agent.operations import handle

with warnings.catch_warnings():
    warnings.simplefilter("ignore")
    from fastapi.testclient import TestClient

ADMIN = "admin@ops.test"
CHECKS = ["exposure_tag_fit", "product_fit", "sensitive_topics_fit", "kof_fit", "issue_name_neutral", "summary_grammar"]


def iap(email: str) -> dict[str, str]:
    return {"X-Goog-Authenticated-User-Email": f"accounts.google.com:{email}"}


@pytest.fixture(autouse=True)
def _llm(fake_llm):
    fake_llm.on("triage.assess", lambda call: {"checks": [{"id": c, "ok": True, "confidence": 0.95} for c in CHECKS], "enrichment": {}, "citations": []})


@pytest.fixture
def client(ctx, monkeypatch):
    for var in ("TRIAGE_IAP_AUDIENCE", "TRIAGE_DEV_USER", "K_SERVICE", "TRIAGE_BOOTSTRAP_ADMIN"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setenv("TRIAGE_BACKEND", "local")
    with TestClient(create_app(ctx=ctx)) as c:
        yield c


def alert(n: int, **changes: str) -> str:
    text = GOOD_ALERT.replace("1845123456789012345", f"18451234567890{n:05d}")
    for label, value in changes.items():
        key = label.replace("_", " ")
        text = "\n".join(f"{key}: {value}" if line.lower().startswith(key.lower() + ":") else line for line in text.splitlines())
    return text


def triage(ctx, text: str = GOOD_ALERT) -> dict[str, Any]:
    return handle({"op": "triage_message", "payload": {"message": make_message(text)}}, ctx).data


def dashboard(client, **filters: list[str]) -> dict[str, Any]:
    params: dict[str, Any] = {"range": "today"}
    if filters:
        params["filters"] = json.dumps(filters)
    res = client.get("/api/dashboard", params=params, headers=iap(ADMIN))
    assert res.status_code == 200, res.text
    return res.json()


# -- the facts of one alert ----------------------------------------------------------------------------------------------------
def test_an_alert_is_counted_by_the_lines_of_the_burson_alert_with_the_taxonomy_names(ctx):
    case_id = triage(ctx)["case_id"]
    facts = alert_facts(ctx.store.get_case(case_id), ctx.config)
    assert facts["product"] == ["Gemini App"] and facts["social_network"] == "X"
    assert facts["exposure_tag"] == "Product - Factual inaccuracies (not dangerous/offensive)" and facts["priority"] == "P1"
    assert facts["kof"] == "No" and facts["kof_list"] == [] and facts["sensitive_topic"] == [NO_TOPIC]
    assert [verdict for _, verdict in facts["messages"]] == ["PASS"]


def test_a_reassessment_by_an_im_is_not_a_new_alert_message_but_a_rerun_is(ctx):
    case = ctx.store.get_case(triage(ctx)["case_id"])
    same = case.attempts[-1]
    case.attempts.append(Attempt(attempt=2, message=same.message, received_at=same.received_at + timedelta(minutes=5), result=same.result))
    assert len(alert_facts(case, ctx.config)["messages"]) == 1, "the same message re-assessed is still one message"
    rerun = same.message.model_copy(update={"message_id": "msg-rerun", "text": same.message.text + " "})
    case.attempts.append(Attempt(attempt=3, message=rerun, received_at=same.received_at + timedelta(minutes=9), result=same.result))
    assert len(alert_facts(case, ctx.config)["messages"]) == 2


def test_a_kof_alert_names_its_lists_and_a_network_outside_the_taxonomy_counts_as_other(ctx):
    case = ctx.store.get_case(triage(ctx, alert(2, KOF="Yes"))["case_id"])
    case.attempts[-1].result.assessment.kof_lists = ["Viral KOFs (KOFs)"]
    case.attempts[-1].result.assessment.platform = '"Why is Kentucky Fried Chicken called KFC"'
    facts = alert_facts(case, ctx.config)
    assert facts["kof"] == "Yes" and facts["kof_list"] == ["Viral KOFs (KOFs)"] and facts["social_network"] == "Other"


# -- counts, breakdowns and filters ------------------------------------------------------------------------------------------
def test_the_dashboard_counts_alert_messages_and_every_number_follows_the_filters(ctx, client, clock):
    triage(ctx, alert(1))
    triage(ctx, alert(2, Product="Pixel", Social_Network="Reddit", View_Post="https://www.reddit.com/r/google/comments/abc002/a_post/"))
    triage(ctx, alert(3, Product="Pixel"))
    clock.advance(minutes=2)

    everything = dashboard(client)
    lines = everything["alert_lines"]
    assert lines["total_messages"] == 3 and lines["total_alerts"] == 3 and everything["filtered"] is False
    assert {b["value"]: b["count"] for b in lines["breakdowns"]["product"]} == {"Pixel": 2, "Gemini App": 1}
    assert {b["value"]: b["count"] for b in lines["breakdowns"]["social_network"]} == {"X": 2, "Reddit": 1}
    tags = [o["value"] for o in lines["options"]["exposure_tag"]]
    assert "Brand - Litigation" in tags, "a filter lists every exposure tag of the taxonomy, not only the ones seen"

    pixel = dashboard(client, product=["Pixel"])
    assert pixel["filtered"] is True and pixel["alert_lines"]["total_messages"] == 2
    assert pixel["kpis"]["alerts_received"] == 2, "the measures count only the alerts in view"
    assert sum(r["alert.received"] for r in pixel["series"]) == 2, "and so does the chart"
    products = {o["value"]: o["count"] for o in pixel["alert_lines"]["options"]["product"]}
    assert products["Gemini App"] == 1 and products["Pixel"] == 2, "a filter's own choices are counted without it"

    assert dashboard(client, product=["Pixel", "Gemini App"])["alert_lines"]["total_messages"] == 3, "picks in one filter: any of them"
    both = dashboard(client, product=["Pixel"], social_network=["Reddit"])
    assert both["alert_lines"]["total_messages"] == 1, "different filters must all hold"
    assert dashboard(client, kof=["Yes"])["alert_lines"]["total_messages"] == 0
    verdicts = {b["value"]: b["count"] for b in lines["breakdowns"]["verdict"]}
    assert sum(verdicts.values()) == 3 and set(verdicts) <= {"PASS", "CORRECTED"}
    assert dashboard(client, verdict=list(verdicts))["alert_lines"]["total_messages"] == 3
    one = next(iter(verdicts))
    assert dashboard(client, verdict=[one])["alert_lines"]["total_messages"] == verdicts[one]


def test_sentiment_comes_from_geminis_read_of_the_story(ctx, client, clock):
    first = triage(ctx, alert(1))["case_id"]
    triage(ctx, alert(2))
    ctx.store.put_doc(storyread.READS, "STY-1", {"story_id": "STY-1", "at": clock.now.isoformat(), "labels": {first: "negative"}})
    clock.advance(minutes=1)
    lines = dashboard(client, sentiment=["negative"])["alert_lines"]
    assert lines["total_messages"] == 1
    options = {o["value"]: o for o in lines["options"]["sentiment"]}
    assert options["negative"]["count"] == 1 and options[""]["count"] == 1 and options[""]["label"] == "Not rated"


def test_unknown_or_unreadable_filters_are_refused(client):
    for bad in ("{not json", json.dumps(["product"]), json.dumps({"colour": ["blue"]}), json.dumps({"product": ["x" * 400]})):
        res = client.get("/api/dashboard", params={"range": "today", "filters": bad}, headers=iap(ADMIN))
        assert res.status_code == 422, bad


def test_the_period_before_is_counted_with_the_same_filters(ctx, clock):
    triage(ctx, alert(1, Product="Pixel"))
    rows = [alert_facts(c, ctx.config) for c in ctx.store.list_cases(limit=50)]
    start = clock.now - timedelta(hours=1)
    assert matching_messages(rows, start, clock.now + timedelta(minutes=1), {"product": ["Pixel"]}) == (1, {rows[0]["case_id"]})
    assert matching_messages(rows, start, clock.now + timedelta(minutes=1), {"product": ["Gemini App"]})[0] == 0


# -- response times -----------------------------------------------------------------------------------------------------------
def test_response_times_count_only_the_alerts_where_the_step_happened(ctx, clock):
    first = ctx.store.get_case(triage(ctx, alert(1))["case_id"])
    second = ctx.store.get_case(triage(ctx, alert(2))["case_id"])
    arrived = first.attempts[0].received_at
    first.acknowledged_at = arrived + timedelta(minutes=6)
    rows = [alert_facts(first, ctx.config), alert_facts(second, ctx.config)]
    events = [
        make_event(E.TRIAGE_PASSED, case_id=first.case_id, event_ts=arrived + timedelta(seconds=30)),
        make_event(E.TRIAGE_PASSED, case_id=second.case_id, event_ts=second.attempts[0].received_at + timedelta(seconds=90)),
        make_event(E.EMAIL_SENT, case_id=first.case_id, event_ts=arrived + timedelta(hours=2),
                   payload={"purpose": "alert", "post_to_send_s": 600}),
        make_event(E.EMAIL_SENT, case_id=second.case_id, event_ts=arrived + timedelta(hours=2), payload={"purpose": "bug_followup"}),
    ]
    steps = {s["key"]: s for s in response_times(rows, events)}
    assert steps["agent_review"]["n"] == 2 and steps["agent_review"]["avg_s"] == 60.0 and steps["agent_review"]["median_s"] == 60.0
    assert steps["im_response"]["n"] == 1 and steps["im_response"]["avg_s"] == 360.0
    base = (first.clean_posted_at or first.created_at) + timedelta(seconds=600)
    assert steps["email_sent"]["n"] == 1 and steps["email_sent"]["avg_s"] == (base - arrived).total_seconds(), "the send time, not when it was noticed"
    assert steps["tns_submitted"]["n"] == 0 and steps["tns_submitted"]["avg_s"] is None and steps["email_sent"]["of"] == 2


def test_the_dashboard_returns_response_times_for_the_alerts_in_view(ctx, client, clock):
    triage(ctx, alert(1))
    clock.advance(minutes=3)
    steps = {s["key"]: s for s in dashboard(client)["alert_lines"]["response_times"]}
    assert steps["agent_review"]["n"] == 1 and steps["agent_review"]["avg_s"] is not None
    assert steps["im_response"]["n"] == 0


def test_alert_view_lists_the_rest_as_more_when_there_are_many_values(ctx):
    case = ctx.store.get_case(triage(ctx, alert(1))["case_id"])
    rows = []
    for n in range(15):
        facts = alert_facts(case, ctx.config)
        rows.append({**facts, "case_id": f"TRG-{n}", "product": [f"Product {n}"]})
    arrived = rows[0]["messages"][0][0]
    view = alert_view(rows, arrived - timedelta(minutes=1), arrived + timedelta(minutes=1), {}, config=ctx.config, top=12)
    products = view["breakdowns"]["product"]
    assert len(products) == 13 and products[-1]["more"] is True and products[-1]["count"] == 3 and products[-1]["label"] == "3 more"
