"""Agent Console API (console/backend, docs/CONTRACTS.md §17).

FastAPI TestClient against a tmp SQLite DB seeded once per module by console.backend.seed_demo
(each test works on its own copy). Identity comes from the IAP email header.
Run: TRIAGE_LLM=fake .venv/bin/python -m pytest -q tests/test_console_api.py
"""

from __future__ import annotations

import base64
import json
import sqlite3
import warnings
from contextlib import closing
from datetime import datetime, timezone
from types import SimpleNamespace
from typing import Any

import pytest

from console.backend.app import create_app
from console.backend.auth import DEFAULT_DEV_USER
from _console_fixtures.seed_demo import seed_database
from conftest import SeededAgentContext, seed_test_config
from triage_agent import operations
from triage_agent.config import load_config
from triage_agent.context import AgentContext
from triage_agent.escalation.gmail import FakeGmail
from triage_agent.events import EventType, SqliteEventLogger
from triage_agent.llm import FakeLLM
from triage_agent.metrics import KPI_DEFINITIONS
from triage_agent.models import CaseStatus, ChatOutputs
from triage_agent.outbox import NoopDoorbell
from triage_agent.store import SqliteStore

with warnings.catch_warnings():  # starlette warns at import time that httpx is deprecated (httpx2)
    warnings.simplefilter("ignore")
    from fastapi.testclient import TestClient

SEED_NOW = datetime(2026, 10, 13, 10, 5, tzinfo=timezone.utc)  # Tue 06:05 America/New_York

ADMIN = "admin@ops.test"  # config.analysts: admin
LEAD = "lead@ops.test"  # config.analysts: lead
IM = "ana.ruiz@roster.test"  # demo slrr_im roster person -> analyst
VIEWER = f"viewer@{'google' + '.com'}"  # domain viewer role -> read-only
OUTSIDER = "stranger@external.invalid"  # no access


def iap(email: str) -> dict[str, str]:
    return {"X-Goog-Authenticated-User-Email": f"accounts.google.com:{email}"}


class Api:
    """TestClient wrapper that signs every request in as `user` (default: the admin)."""

    def __init__(self, client: TestClient, ctx: AgentContext):
        self.client, self.ctx = client, ctx

    def get(self, path: str, user: str = ADMIN, **params: Any):
        return self.client.get(path, headers=iap(user), params=params or None)

    def post(self, path: str, body: Any = None, user: str = ADMIN):
        return self.client.post(path, json=body, headers=iap(user))

    def put(self, path: str, body: Any = None, user: str = ADMIN):
        return self.client.put(path, json=body, headers=iap(user))

    def delete(self, path: str, user: str = ADMIN):
        return self.client.delete(path, headers=iap(user))

    def events(self, event_type: str) -> list:
        return self.ctx.events.query(types=[event_type], limit=10000)


@pytest.fixture(scope="module")
def seeded(tmp_path_factory) -> tuple[Any, dict]:
    path = tmp_path_factory.mktemp("console") / "seed.db"
    summary = seed_database(path, reset=True, now=SEED_NOW)
    return path, summary


@pytest.fixture
def console_ctx(seeded, tmp_path) -> AgentContext:
    src, _ = seeded
    db = tmp_path / "console.db"
    with closing(sqlite3.connect(src)) as a, closing(sqlite3.connect(db)) as b:
        a.backup(b)
    store = SqliteStore(db)
    return SeededAgentContext(
        config=seed_test_config(load_config(store)),
        store=store,
        events=SqliteEventLogger(db),
        llm=FakeLLM(default_json=None, default_text="I don't know."),
        now=lambda: SEED_NOW,
        gmail=FakeGmail(connect_all=True),
        doorbell=NoopDoorbell(),
    )


@pytest.fixture
def api(console_ctx, monkeypatch) -> Api:
    for var in ("TRIAGE_IAP_AUDIENCE", "TRIAGE_DEV_USER", "TRIAGE_OAUTH_CLIENT", "TRIAGE_CONSOLE_BASE_URL", "TRIAGE_GMAIL"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setenv("TRIAGE_BACKEND", "local")
    with TestClient(create_app(ctx=console_ctx)) as client:
        yield Api(client, console_ctx)


@pytest.fixture
def stub_op():
    """Replace operation handlers with recording stubs; the registry is restored afterwards."""
    operations.registered_operations()  # load the real handlers first
    saved = dict(operations._REGISTRY)
    calls: list[dict[str, Any]] = []

    def install(name: str, outputs: ChatOutputs | None = None, data: dict | None = None) -> list[dict[str, Any]]:
        @operations.operation(name)
        def _stub(ctx, payload, rc):
            calls.append({"op": name, "payload": payload, "rc": rc})
            out = outputs or ChatOutputs(summary=f"stub {name}", case_id=str(payload.get("case_id") or ""))
            return out, dict(data or {})

        return calls

    def remove(name: str) -> None:
        operations._REGISTRY.pop(name, None)

    install.remove = remove  # type: ignore[attr-defined]
    yield install
    operations._REGISTRY.clear()
    operations._REGISTRY.update(saved)


def pending_review_ids(api: Api) -> list[str]:
    return [c["case_id"] for c in api.get("/api/review-queue").json()["cases"]]


# ---------------------------------------------------------------------------
# Auth + roles
# ---------------------------------------------------------------------------


def test_seed_is_deterministic_and_complete(seeded):
    _, summary = seeded
    assert summary["coverage"] == {"missing_event_types": [], "zero_kpis": [], "empty_derived": []}
    assert summary["by_status"].get("NEEDS_REVIEW") == 3
    assert summary["by_status"].get("FAILED", 0) >= 1
    assert {"burson_chat", "inhouse", "watchdog"} <= set(summary["by_source"])


def test_health_is_public(api):
    r = api.client.get("/api/health")
    assert r.status_code == 200 and r.json()["ok"] is True


@pytest.mark.parametrize(
    "email, role, source",
    [(ADMIN, "admin", "config"), (LEAD, "lead", "config"), (IM, "analyst", "roster"),
     (VIEWER, "viewer", "domain"), (OUTSIDER, "none", "none")],
)
def test_me_resolves_roles(api, email, role, source):
    r = api.get("/api/me", user=email)
    assert r.status_code == 200
    me = r.json()
    assert (me["email"], me["role"], me["role_source"], me["via"]) == (email, role, source, "iap")
    assert me["can_act"] is (role in ("analyst", "lead", "admin"))
    assert me["is_admin"] is (role == "admin")


def test_iap_header_prefix_and_case_are_normalized(api):
    r = api.client.get("/api/me", headers={"X-Goog-Authenticated-User-Email": "accounts.google.com:Ana.Ruiz@Roster.test"})
    assert (r.json()["email"], r.json()["role"]) == (IM, "analyst")


def test_outsider_is_forbidden(api):
    for path in ("/api/kpis", "/api/cases", "/api/settings", "/api/rosters/slrr_im", "/api/parity"):
        r = api.get(path, user=OUTSIDER)
        assert r.status_code == 403, path
        assert r.json()["code"] == "forbidden" and r.json()["required_role"] == "viewer"


def test_dev_user_fallback_and_gcp_requires_identity(api, monkeypatch):
    me = api.client.get("/api/me").json()
    assert (me["email"], me["via"], me["dev_mode"]) == (DEFAULT_DEV_USER, "dev", True)
    monkeypatch.setenv("TRIAGE_DEV_USER", VIEWER)
    assert api.client.get("/api/me").json()["role"] == "viewer"
    monkeypatch.delenv("TRIAGE_DEV_USER")
    monkeypatch.setenv("TRIAGE_BACKEND", "gcp")
    r = api.client.get("/api/me")
    assert r.status_code == 401 and r.json()["code"] == "unauthenticated"


def test_write_permissions_by_role(api):
    case_id = pending_review_ids(api)[0]
    assert api.post(f"/api/review-queue/{case_id}", {"decision": "suppress"}, user=VIEWER).status_code == 403
    assert api.post(f"/api/cases/{case_id}/close", {"reason": "dup"}, user=VIEWER).status_code == 403
    thresholds = api.get("/api/settings/thresholds").json()["value"]
    for user in (IM, LEAD):  # settings are admin-only
        r = api.put("/api/settings/thresholds", {"value": thresholds}, user=user)
        assert r.status_code == 403 and r.json()["required_role"] == "admin"
    roster = api.get("/api/rosters/slrr_im").json()["roster"]
    assert api.put("/api/rosters/slrr_im", roster, user=IM).status_code == 403
    assert api.get("/api/settings", user=VIEWER).json()["can_edit"] is False
    assert api.get("/api/settings").json()["can_edit"] is True
    pending_fact = next(f for f in api.get("/api/facts", status="PENDING").json()["facts"])
    assert api.post(f"/api/facts/{pending_fact['fact_id']}", {"decision": "approve"}, user=IM).status_code == 403
    pending_prop = next(p for p in api.get("/api/proposals", status="PENDING").json()["proposals"])
    assert api.post(f"/api/proposals/{pending_prop['proposal_id']}", {"decision": "reject"}, user=LEAD).status_code == 403


def test_unknown_api_route_is_json_404(api):
    r = api.get("/api/nope")
    assert r.status_code == 404 and r.json()["code"] == "not_found"
    assert api.client.get("/cases/TRG-1").status_code == 200  # SPA fallback for client-side routes
    assert api.client.get("/assets/index-old.js").status_code == 404  # stale asset after a redeploy


# ---------------------------------------------------------------------------
# Metrics
# ---------------------------------------------------------------------------


def test_kpis_cover_every_definition(api):
    r = api.get("/api/kpis", days=7)
    assert r.status_code == 200
    body = r.json()
    assert set(body["kpis"]) == set(KPI_DEFINITIONS)
    assert [k for k, v in body["kpis"].items() if not v] == []  # the demo data makes every KPI non-trivial
    assert {d["key"] for d in body["definitions"]} == set(KPI_DEFINITIONS)
    assert {d["group"] for d in body["definitions"]} <= {g["key"] for g in body["groups"]}
    assert body["previous"]["event_count"] > 0 and body["event_count"] > 0
    assert body["derived"] and body["metrics_config"]["im_minutes_per_alert"] == 12  # approved proposal in the seed


def test_kpis_reject_bad_window(api):
    r = api.get("/api/kpis", days=0)
    assert r.status_code == 422 and r.json()["code"] == "validation_error"


def test_timeseries_errors_and_failures(api):
    ts = api.get("/api/timeseries", days=7, bucket="day").json()
    assert len(ts["rows"]) >= 7 and all(set(ts["types"]) <= set(row) for row in ts["rows"])
    assert sum(row["alert.received"] for row in ts["rows"]) > 0
    hourly = api.get("/api/timeseries", days=2, bucket="hour", types="triage.failed,email.sent").json()
    assert len(hourly["rows"]) >= 48
    assert api.get("/api/timeseries", days=30, bucket="hour").status_code == 422
    assert api.get("/api/timeseries", types="not.a.type").status_code == 422
    errors = api.get("/api/errors", days=14).json()
    assert errors["rule_codes"] and errors["operation_errors"]
    assert api.get("/api/failures-by-oncall", days=14).json()["rows"]


# ---------------------------------------------------------------------------
# Cases, activity, suppressed
# ---------------------------------------------------------------------------


def test_cases_list_and_filters(api, seeded):
    _, summary = seeded
    assert api.get("/api/cases", limit=5000).json()["total"] == summary["cases"]
    review = api.get("/api/cases", status="NEEDS_REVIEW").json()
    assert review["total"] == 3 and {c["status"] for c in review["cases"]} == {"NEEDS_REVIEW"}
    inhouse = api.get("/api/cases", source="inhouse", limit=5000).json()["cases"]
    assert inhouse and {c["source"] for c in inhouse} == {"inhouse"}
    mixed = api.get("/api/cases", source="inhouse,watchdog", limit=5000).json()["cases"]
    assert {c["source"] for c in mixed} == {"inhouse", "watchdog"}
    urgent = api.get("/api/cases", track="URGENT", priority="P0,P1", limit=5000).json()["cases"]
    assert urgent and all(c["track"] == "URGENT" and c["priority"] in ("P0", "P1") for c in urgent)
    target = review["cases"][0]["case_id"]
    assert target in [c["case_id"] for c in api.get("/api/cases", q=target.lower()).json()["cases"]]
    assert api.get("/api/cases", q="zzz-no-such-alert").json()["total"] == 0
    bad = api.get("/api/cases", status="LOST")
    assert bad.status_code == 422 and "LOST" in bad.json()["error"]


def test_case_detail(api):
    verified = api.get("/api/cases", status="VERIFIED", source="burson_chat", limit=5000).json()["cases"]
    detail = next(d for d in (api.get(f"/api/cases/{c['case_id']}").json() for c in verified) if d["escalations"])
    case_id = detail["case"]["case_id"]
    types = [e["event_type"] for e in detail["events"]]
    assert "alert.received" in types and "escalation.started" in types
    assert [e["event_ts"] for e in detail["events"]] == sorted(e["event_ts"] for e in detail["events"])
    assert all(e["summary"] and "trace" not in (e.get("payload") or {}) for e in detail["events"])
    assert detail["summary"]["case_id"] == case_id and detail["escalations"][0]["case_id"] == case_id
    assert detail["operations"] == {"review_decision": True, "revert_correction": True, "close_case": True}
    missing = api.get("/api/cases/TRG-0")
    assert missing.status_code == 404 and missing.json()["code"] == "not_found"


def test_activity_feed(api):
    feed = api.get("/api/activity", limit=50).json()
    assert feed["count"] == 50
    stamps = [e["event_ts"] for e in feed["events"]]
    assert stamps == sorted(stamps, reverse=True)
    emails = api.get("/api/activity", type="email", limit=500).json()["events"]
    assert emails and all(e["event_type"].startswith("email.") for e in emails)
    assert api.get("/api/activity", type="bogus").status_code == 422


def test_suppressed_lists_reasons(api):
    body = api.get("/api/suppressed", days=14).json()
    assert body["cases"] and {c["status"] for c in body["cases"]} == {"SUPPRESSED"}
    assert sum(r["count"] for r in body["reasons"]) == len(body["cases"])
    assert any(c["reason"] == "im_review" and c["suppressed_by"] != "agent" for c in body["cases"])
    assert body["review_suppressed"] >= 1


# ---------------------------------------------------------------------------
# Review queue, reverts, closing
# ---------------------------------------------------------------------------


def test_review_queue_lists_pending_cases(api):
    body = api.get("/api/review-queue").json()
    rows = body["cases"]
    assert len(rows) == 3 and body["op_available"] is True
    waits = [r["waiting_min"] for r in rows]
    assert waits == sorted(waits, reverse=True) and min(waits) > 0
    assert all(r["proposed_corrections"] and r["issue_list"] and r["normalized"] for r in rows)
    assert body["review_reminder_min"] > 0


def test_review_post_calls_operation_with_console_context(api, stub_op):
    calls = stub_op("review_decision", ChatOutputs(clean_text="Forwarded to the clean space", summary="forwarded"))
    case_id = pending_review_ids(api)[0]
    body = {"decision": "forward", "reason": "  Tag fits  ", "fields": {"exposure_tag": "Product - Perceived bias"}}
    r = api.post(f"/api/review-queue/{case_id}", body, user=IM)
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["ok"] is True and out["summary"] == "forwarded" and len(out["queued_outbox_ids"]) == 1
    call = calls[-1]
    assert call["payload"] == {"case_id": case_id, "decision": "forward", "reason": "Tag fits",
                               "fields": {"exposure_tag": "Product - Perceived bias"}, "actor": IM, "via": "console"}
    assert (call["rc"].deliver, call["rc"].invoked_by, call["rc"].flow) == ("outbox", IM, "console")
    queued = {i.outbox_id: i for i in api.ctx.store.list_outbox(undelivered_only=True, limit=100000)}
    item = queued[out["queued_outbox_ids"][0]]
    assert (item.target, item.text, item.source) == ("clean", "Forwarded to the clean space", "review_decision")


def test_review_post_validation(api):
    case_id = pending_review_ids(api)[0]
    r = api.post(f"/api/review-queue/{case_id}", {"decision": "forward", "fields": {"not_a_field": 1}}, user=IM)
    assert r.status_code == 422 and "not_a_field" in r.json()["error"]
    r = api.post(f"/api/review-queue/{case_id}", {"decision": "bounce", "fields": {"product": "Gemini App"}}, user=IM)
    assert r.status_code == 422 and "forwarding" in r.json()["error"]
    r = api.post(f"/api/review-queue/{case_id}", {"decision": "maybe"}, user=IM)
    assert r.status_code == 422 and r.json()["errors"][0]["loc"] == ["decision"]
    verified = api.get("/api/cases", status="VERIFIED", limit=1).json()["cases"][0]["case_id"]
    assert api.post(f"/api/review-queue/{verified}", {"decision": "suppress"}, user=IM).status_code == 409
    assert api.post("/api/review-queue/TRG-0", {"decision": "suppress"}, user=IM).status_code == 404


def test_review_decisions_run_the_real_operation(api):
    rows = {r["case_id"]: r for r in api.get("/api/review-queue").json()["cases"]}
    first, second, third = rows
    r = api.post(f"/api/review-queue/{first}", {"decision": "suppress", "reason": "Duplicate of an earlier alert"}, user=IM)
    assert r.status_code == 200, r.text
    assert r.json()["case"]["status"] == "SUPPRESSED"
    r = api.post(f"/api/review-queue/{second}", {"decision": "bounce", "reason": "Exposure tag doesn't fit"}, user=IM)
    assert r.status_code == 200, r.text
    assert r.json()["case"]["status"] != "NEEDS_REVIEW"
    proposed = rows[third]["proposed_corrections"][0]
    r = api.post(f"/api/review-queue/{third}", {"decision": "forward", "fields": {proposed["field"]: proposed["new"]}}, user=IM)
    assert r.status_code == 200, r.text
    forwarded = r.json()["case"]
    assert forwarded["status"] not in ("NEEDS_REVIEW", "FAILED") and forwarded["attempts"] == rows[third]["attempts"] + 1
    assert pending_review_ids(api) == []
    for event_type, case_id in ((EventType.REVIEW_SUPPRESSED, first), (EventType.REVIEW_BOUNCED, second),
                                (EventType.REVIEW_FORWARDED, third)):
        assert any(e.case_id == case_id and e.actor == IM for e in api.events(event_type)), event_type
    # a second decision on the same case is a conflict
    assert api.post(f"/api/review-queue/{first}", {"decision": "forward"}, user=IM).status_code == 409


DERIVED_FIELDS = ("priority", "engagement_level", "alert_name", "kof")  # re-derived by finalize(); reverts are pinned


def _revertible(ctx: AgentContext, derived: bool) -> tuple[str, str]:
    for case in ctx.store.list_cases(statuses=[CaseStatus.VERIFIED], limit=5000):
        fields = [c.field for c in case.latest.result.corrections if c.applied and not c.reverted_by] if case.latest else []
        fields = [f for f in fields if (f in DERIVED_FIELDS) == derived]
        if fields:
            return case.case_id, fields[0]
    raise AssertionError("the demo seed has no revertible correction")


@pytest.mark.parametrize("derived", [True, False], ids=["derived-field", "plain-field"])
def test_revert_correction(api, derived):
    case_id, field = _revertible(api.ctx, derived)
    before = api.get(f"/api/cases/{case_id}").json()
    assert field in before["revertible_fields"]
    untouched = next(f["name"] for f in api.get("/api/meta").json()["fields"] if f["name"] not in before["revertible_fields"])
    r = api.post(f"/api/cases/{case_id}/revert", {"field": untouched}, user=IM)
    assert r.status_code == 409 and r.json()["code"] == "conflict"
    r = api.post(f"/api/cases/{case_id}/revert", {"field": field}, user=IM)
    assert r.status_code == 200, r.text
    after = api.get(f"/api/cases/{case_id}").json()
    assert field not in after["revertible_fields"]  # the revert sticks (derived fields too)
    assert any(e["event_type"] == "correction.reverted" and e["actor"] == IM for e in after["events"])


def test_close_case(api):
    case_id = pending_review_ids(api)[0]
    assert api.post(f"/api/cases/{case_id}/close", {"reason": ""}, user=IM).status_code == 422
    r = api.post(f"/api/cases/{case_id}/close", {"reason": "Handled by phone with the PA team"}, user=IM)
    assert r.status_code == 200, r.text
    assert r.json()["case"]["status"] == "CLOSED"
    again = api.post(f"/api/cases/{case_id}/close", {"reason": "again"}, user=IM)
    assert again.status_code == 409 and again.json()["code"] == "conflict"
    assert any(e.case_id == case_id and e.payload.get("reason") == "manual" for e in api.events(EventType.CASE_CLOSED))


def test_unregistered_operation_returns_501(api, stub_op):
    stub_op.remove("close_case")
    case_id = pending_review_ids(api)[0]
    r = api.post(f"/api/cases/{case_id}/close", {"reason": "dup"}, user=IM)
    assert r.status_code == 501 and r.json()["code"] == "op_not_implemented"
    assert api.get(f"/api/cases/{case_id}").json()["operations"]["close_case"] is False


def test_operation_errors_are_mapped(api, stub_op):
    case_id = pending_review_ids(api)[0]

    @operations.operation("close_case")
    def _rejects(ctx, payload, rc):
        raise operations.UserFacingError("Only Incident Managers can close alerts.")

    r = api.post(f"/api/cases/{case_id}/close", {"reason": "dup"}, user=IM)
    assert r.status_code == 400 and r.json()["code"] == "op_rejected" and "Incident Managers" in r.json()["error"]

    @operations.operation("close_case")
    def _flaky(ctx, payload, rc):
        raise operations.RetryableError("Gemini returned 429")

    r = api.post(f"/api/cases/{case_id}/close", {"reason": "dup"}, user=IM)
    assert r.status_code == 503 and r.json()["retryable"] is True and r.json()["code"] == "op_failed"


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------


def new_events(api: Api, event_type: str) -> list:
    """Events emitted during the test (the seed only writes events before SEED_NOW)."""
    return [e for e in api.events(event_type) if e.event_ts >= SEED_NOW]


def test_settings_overview_and_history(api):
    body = api.get("/api/settings").json()
    sections = {s["key"]: s for s in body["sections"]}
    assert "version" not in sections and "env" not in sections
    assert [sections[k]["kind"] for k in ("thresholds", "distribution", "collection")] == ["structured", "table", "json"]
    assert sections["thresholds"]["overridden"] and sections["metrics"]["overridden"]
    assert not sections["collection"]["overridden"]
    assert body["config"]["thresholds"]["sla_warn_fraction"] == 0.5 and body["last_update"]["updated_by"] == ADMIN
    history = api.get("/api/settings/history").json()["history"]
    assert [h["sections_changed"] for h in history[:2]] == [["metrics"], ["thresholds"]]
    assert history[0]["changes"]["metrics"]["after"]["im_minutes_per_alert"] == 12
    section = api.get("/api/settings/thresholds").json()
    assert section["override"] == {"sla_warn_fraction": 0.5} and section["default"]["sla_warn_fraction"] != 0.5


def test_settings_put_validation_errors(api):
    section = api.get("/api/settings/thresholds").json()
    value, version = section["value"], section["config_version"]
    r = api.put("/api/settings/thresholds", {"value": {**value, "sla_warn_fraction": "soon"}})
    assert r.status_code == 422 and r.json()["code"] == "validation_error"
    assert r.json()["errors"][0]["loc"] == ["sla_warn_fraction"]
    r = api.put("/api/settings/thresholds", {"value": {**value, "sla_warn_fracton": 0.4}})
    assert r.status_code == 422
    assert r.json()["errors"] == [{"loc": ["sla_warn_fracton"], "msg": "Unknown setting (it would be ignored)", "type": "unknown_key"}]
    r = api.put("/api/settings/thresholds", {"value": value, "base_version": "stale"})
    assert r.status_code == 409 and r.json()["config_version"] == version
    assert api.put("/api/settings/thresholds", {"note": "no value"}).status_code == 422
    assert api.put("/api/settings/no_such_section", {"value": {}}).status_code == 404
    assert api.put("/api/settings/env", {"value": "prod"}).status_code == 422
    assert api.get("/api/settings/thresholds").json()["config_version"] == version  # nothing was saved
    assert new_events(api, EventType.CONFIG_UPDATED) == []


def test_settings_put_saves_minimal_patch_and_reset(api):
    section = api.get("/api/settings/thresholds").json()
    body = {"value": {**section["value"], "sla_warn_fraction": 0.45}, "note": "Earlier SLA nudges", "base_version": section["config_version"]}
    r = api.put("/api/settings/thresholds", body)
    assert r.status_code == 200, r.text
    saved = r.json()
    assert saved["value"]["sla_warn_fraction"] == 0.45 and saved["overridden"] is True
    assert saved["config_version"] != section["config_version"]
    assert api.ctx.config.thresholds.sla_warn_fraction == 0.45  # the shared context was reloaded
    assert api.ctx.store.get_config_overrides()["thresholds"] == {"sla_warn_fraction": 0.45}  # merge patch vs the defaults
    (event,) = new_events(api, EventType.CONFIG_UPDATED)
    assert event.actor == ADMIN
    assert event.payload == {"section": "thresholds", "via": "console", "note": "Earlier SLA nudges", "reset": False}
    assert api.get("/api/settings/history").json()["history"][0]["note"] == "Earlier SLA nudges"
    r = api.delete("/api/settings/thresholds")
    assert r.status_code == 200 and r.json()["overridden"] is False
    assert r.json()["value"] == api.get("/api/settings/thresholds").json()["default"]
    assert "thresholds" not in api.ctx.store.get_config_overrides()
    assert api.delete("/api/settings/thresholds", user=LEAD).status_code == 403


def test_settings_table_section_edit(api):
    dist = api.get("/api/settings/distribution").json()["value"]
    group = {**dist["groups"][0], "name": "Test Team", "action_code": None, "recipients": ["test-team@alerts.test"]}
    r = api.put("/api/settings/distribution", {"value": {**dist, "groups": dist["groups"] + [group]}})
    assert r.status_code == 200, r.text
    assert api.ctx.config.distribution.group("Test Team").recipients == ["test-team@alerts.test"]
    assert api.ctx.store.get_config_overrides()["distribution"]["groups"][-1]["name"] == "Test Team"  # lists are replaced
    bad_product = {**dist["products"][0], "name": None}
    r = api.put("/api/settings/distribution", {"value": {**dist, "products": [bad_product] + dist["products"][1:]}})
    assert r.status_code == 422 and r.json()["errors"][0]["loc"][:3] == ["products", 0, "name"]


# ---------------------------------------------------------------------------
# Rosters
# ---------------------------------------------------------------------------


def test_rosters_and_schedule(api):
    im = api.get("/api/rosters/slrr_im").json()
    assert [p["id"] for p in im["roster"]["people"]] == ["ana", "ben", "chloe", "dev", "erin"]
    assert im["on_call_now"]["source"] and im["escalation_chain"] and im["timezone"] == "America/New_York"
    burson = api.get("/api/rosters/burson").json()
    assert burson["roster"]["fallback"]["email"] == "burson-lead@agency.test"
    assert api.get("/api/rosters/nope").status_code == 404
    sched = api.get("/api/rosters/slrr_im/schedule", days=7).json()
    assert [d["date"] for d in sched["days"]][:2] == ["2026-10-13", "2026-10-14"] and len(sched["days"]) == 7
    for day in sched["days"]:  # blocks tile each day
        assert sum(b["end_min"] - b["start_min"] for b in day["blocks"]) == day["minutes"]
    sunday = next(d for d in sched["days"] if d["weekday"] == "sun")
    assert any(b["gap"] and b["start_min"] == 0 and b["end_min"] == 360 for b in sunday["blocks"])  # demo IM gap
    assert sched["gaps"] and sched["gap_minutes"] >= 360
    now = api.get("/api/oncall/now").json()
    assert set(now["rosters"]) == {"slrr_im", "burson"}


def test_roster_override_crud(api):
    body = {"person_id": "ben", "start": "2026-10-14T09:00:00", "end": "2026-10-14T12:00:00", "reason": "Swap with Ana"}
    r = api.post("/api/rosters/slrr_im/overrides", body, user=IM)
    assert r.status_code == 200, r.text
    ovr = r.json()["override"]
    assert datetime.fromisoformat(ovr["start"]) == datetime(2026, 10, 14, 13, 0, tzinfo=timezone.utc)  # 09:00 EDT
    assert (ovr["set_by"], ovr["set_via"]) == (IM, "console")
    assert ovr["override_id"] in [o["override_id"] for o in api.get("/api/rosters/slrr_im").json()["roster"]["overrides"]]
    segments = api.get("/api/rosters/slrr_im/schedule", days=2).json()["segments"]
    assert any(s["person_id"] == "ben" and s["source"] == "override" for s in segments)
    assert [e.actor for e in new_events(api, EventType.ONCALL_OVERRIDE_SET)] == [IM]
    r = api.delete(f"/api/rosters/slrr_im/overrides/{ovr['override_id']}", user=IM)
    assert r.status_code == 200
    assert ovr["override_id"] not in [o["override_id"] for o in r.json()["roster"]["overrides"]]
    assert api.delete(f"/api/rosters/slrr_im/overrides/{ovr['override_id']}", user=IM).status_code == 404
    bad = api.post("/api/rosters/slrr_im/overrides", {**body, "person_id": "zed", "end": "2026-10-14T08:00:00"}, user=IM)
    assert bad.status_code == 422 and {tuple(e["loc"]) for e in bad.json()["errors"]} == {("person_id",), ("end",)}
    past = api.post("/api/rosters/slrr_im/overrides", {**body, "start": "2026-10-12T09:00:00", "end": "2026-10-12T10:00:00"}, user=IM)
    assert past.status_code == 422 and "already be over" in json.dumps(past.json())
    assert api.post("/api/rosters/slrr_im/overrides", body, user=VIEWER).status_code == 403


def test_roster_put_validates_and_saves(api):
    roster = api.get("/api/rosters/slrr_im").json()["roster"]
    body = {k: roster[k] for k in ("people", "rotation", "backup_person_id", "fallback", "reminders")}
    bad = json.loads(json.dumps(body))
    bad["rotation"][0].update(person_id="nobody", start="25:00")
    r = api.put("/api/rosters/slrr_im", bad)
    assert r.status_code == 422
    assert {tuple(e["loc"]) for e in r.json()["errors"]} == {("rotation", 0, "person_id"), ("rotation", 0, "start")}
    upcoming = next(o for o in roster["overrides"] if datetime.fromisoformat(o["end"]) > SEED_NOW)
    gone = json.loads(json.dumps(body))
    gone["people"] = [p for p in gone["people"] if p["id"] != upcoming["person_id"]]
    gone["rotation"] = [s for s in gone["rotation"] if s["person_id"] != upcoming["person_id"]]
    if gone["backup_person_id"] == upcoming["person_id"]:
        gone["backup_person_id"] = None
    r = api.put("/api/rosters/slrr_im", gone)
    assert r.status_code == 422 and upcoming["override_id"] in json.dumps(r.json()["errors"])
    good = json.loads(json.dumps(body))
    good["people"].append({**roster["people"][0], "id": "fay", "name": "Fay Lin", "email": "fay.lin@roster.test"})
    r = api.put("/api/rosters/slrr_im", good)
    assert r.status_code == 200, r.text
    assert "fay" in [p["id"] for p in r.json()["roster"]["people"]]
    assert len(r.json()["roster"]["overrides"]) == len(roster["overrides"])  # overrides have their own endpoints
    assert api.get("/api/me", user="fay.lin@roster.test").json()["role"] == "analyst"  # IM roster -> analyst
    assert [e.payload["roster"] for e in new_events(api, EventType.ROSTER_UPDATED)] == ["slrr_im"]


# ---------------------------------------------------------------------------
# Parity, learning, Gmail, read-only pages
# ---------------------------------------------------------------------------


def test_parity(api):
    body = api.get("/api/parity", days=14).json()
    s = body["summary"]
    assert s["matched"] > 0 and s["burson_only"] > 0 and s["inhouse_only"] > 0
    assert 0 < s["recall"] < 1 and 0 < s["precision"] < 1 and 0 <= s["full_agreement"] < 1
    m = body["matched"][0]
    assert (m["burson"]["source"], m["inhouse"]["source"]) == ("burson_chat", "inhouse")
    assert body["field_disagreements"] and all(f["count"] > 0 and f["examples"] for f in body["field_disagreements"])
    checked = 0
    for f in body["field_disagreements"]:  # diffs are oriented: the "burson" value is the Burson case's
        for ex in f["examples"]:
            a = api.ctx.store.get_case(ex["burson_case_id"]).latest.result.assessment
            value = getattr(a, f["field"], None)
            if value is not None:
                assert (sorted(value) if isinstance(value, list) else value) == ex["burson"], (f["field"], ex)
                checked += 1
    assert checked > 0


def test_learning_decisions(api):
    facts = api.get("/api/facts", status="PENDING").json()
    assert facts["pending"] >= 1 and facts["op_available"] is True
    fact_id = facts["facts"][0]["fact_id"]
    r = api.post(f"/api/facts/{fact_id}", {"decision": "approve"}, user=LEAD)
    assert r.status_code == 200, r.text
    assert r.json()["fact"]["status"] == "APPROVED"
    assert api.post(f"/api/facts/{fact_id}", {"decision": "reject"}, user=LEAD).status_code == 409
    proposals = api.get("/api/proposals", status="PENDING").json()["proposals"]
    proposal = next(p for p in proposals if p["preview"]["valid"])
    r = api.post(f"/api/proposals/{proposal['proposal_id']}", {"decision": "approve"})
    assert r.status_code == 200, r.text
    assert r.json()["proposal"]["status"] == "APPROVED"
    overrides = api.get("/api/settings").json()["overrides"]
    assert set(proposal["sections"]) <= set(overrides)
    assert api.post("/api/proposals/PROP-0", {"decision": "approve"}).status_code == 404
    assert api.post(f"/api/facts/{fact_id}", {"decision": "maybe"}, user=LEAD).status_code == 422


def test_gmail_status_and_oauth_start(api, monkeypatch, tmp_path):
    from urllib.parse import parse_qs, urlparse

    status = api.get("/api/gmail/status", user=IM).json()
    assert (status["available"], status["connected"], status["mode"], status["can_connect"]) == (True, True, "fake", False)
    r = api.get("/api/gmail/connect", user=IM, format="json")
    assert r.status_code == 503 and r.json()["code"] == "gmail_not_configured"
    client = {"web": {"client_id": "123.apps.googleusercontent.com", "client_secret": "s3cret",
                      "auth_uri": "https://accounts.google.com/o/oauth2/auth", "token_uri": "https://oauth2.googleapis.com/token",
                      "redirect_uris": ["http://testserver/api/gmail/callback"]}}
    path = tmp_path / "oauth_client.json"
    path.write_text(json.dumps(client))
    monkeypatch.setenv("TRIAGE_OAUTH_CLIENT", str(path))
    assert api.get("/api/gmail/status", user=IM).json()["can_connect"] is True
    r = api.get("/api/gmail/connect", user=IM, format="json")
    assert r.status_code == 200, r.text
    query = parse_qs(urlparse(r.json()["auth_url"]).query)
    assert query["client_id"] == ["123.apps.googleusercontent.com"] and query["access_type"] == ["offline"]
    assert "gmail.compose" in query["scope"][0] and "gmail.metadata" in query["scope"][0]
    assert query["redirect_uri"] == ["http://testserver/api/gmail/callback"] and query["login_hint"] == [IM]
    state = query["state"][0]
    assert api.ctx.store.get_kv(f"gmail_oauth:{state}")["email"] == IM
    r = api.client.get("/api/gmail/callback", params={"state": "bogus", "code": "x"}, headers=iap(IM), follow_redirects=False)
    assert r.status_code == 302 and r.headers["location"].startswith("/?gmail=error")
    r = api.client.get("/api/gmail/callback", params={"state": state, "code": "x"}, headers=iap(ADMIN), follow_redirects=False)
    assert r.status_code == 302 and "different" in r.headers["location"]
    assert api.get("/api/gmail/connect", user=VIEWER, format="json").status_code == 403


def _jwt(claims: dict) -> str:
    def b64(obj: dict) -> str:
        return base64.urlsafe_b64encode(json.dumps(obj).encode()).decode().rstrip("=")

    return f"{b64({'alg': 'RS256', 'typ': 'JWT'})}.{b64(claims)}.signature"


@pytest.fixture
def fake_oauth(api, monkeypatch):
    """google-auth-oauthlib Flow, OAuth client, token vault and Gmail profile replaced (no network).

    `grant_only` limits the scopes the fake Google grants (granular consent); with
    `granted_on_creds=False` they're only in the token response (older google-auth).
    """
    from console.backend import gmail_oauth

    mod = gmail_oauth.gmail_module()
    fake = SimpleNamespace(flows=[], vault={}, authorize_as=None, grant_only=None, granted_on_creds=True)

    class Creds:
        def __init__(self, email: str, scopes: list[str], granted: list[str] | None):
            self.email, self.scopes, self.granted_scopes = email, scopes, granted
            self.token, self.refresh_token = "ya29.token", "1//refresh"
            # Google returns an ID token only when the OpenID scope was requested
            self.id_token = _jwt({"email": email, "email_verified": True}) if "openid" in scopes else None

        def to_json(self) -> str:
            return json.dumps({"token": self.token, "refresh_token": self.refresh_token, "scopes": self.scopes})

    class Flow:
        def __init__(self, scopes: list[str], redirect_uri: str, state: str | None):
            self.scopes, self.redirect_uri, self.state = scopes, redirect_uri, state
            self.code_verifier, self.credentials, self.fetched, self.oauth2session = "verifier-1", None, None, None

        def authorization_url(self, **kwargs: Any) -> tuple[str, str]:
            self.state = f"state-{len(fake.flows)}"
            return f"https://accounts.google.com/o/oauth2/auth?state={self.state}&login_hint={kwargs.get('login_hint')}", self.state

        def fetch_token(self, code: str, code_verifier: str | None = None) -> None:
            self.fetched = {"code": code, "code_verifier": code_verifier}
            granted = list(fake.grant_only) if fake.grant_only is not None else list(self.scopes)
            self.oauth2session = SimpleNamespace(token={"access_token": "ya29.token", "scope": " ".join(granted)})
            self.credentials = Creds(fake.authorize_as, self.scopes, granted if fake.granted_on_creds else None)

    class Vault:
        def get(self, email: str) -> dict | None:
            return fake.vault.get(email)

        def put(self, email: str, info: dict) -> None:
            fake.vault[email] = info

        def delete(self, email: str) -> None:
            fake.vault.pop(email, None)

    def build_oauth_flow(client_config, redirect_uri, scopes=(), state=None):
        flow = Flow(list(scopes), redirect_uri, state)
        fake.flows.append(flow)
        return flow

    def profile_email(creds: Any) -> str:  # Gmail users.getProfile works with compose/metadata/readonly, not gmail.send
        if not any(s.rsplit("/", 1)[-1] in ("gmail.compose", "gmail.metadata", "gmail.readonly") for s in creds.scopes):
            raise PermissionError("403 insufficient authentication scopes")
        return creds.email

    monkeypatch.setattr(mod, "build_oauth_flow", build_oauth_flow)
    monkeypatch.setattr(mod, "load_oauth_client_config", lambda source=None: {"web": {"client_id": "cid"}})
    monkeypatch.setattr(mod, "get_token_vault", lambda: Vault())
    monkeypatch.setattr(gmail_oauth, "_profile_email", profile_email)
    monkeypatch.setenv("TRIAGE_OAUTH_CLIENT", "oauth-client-secret")
    monkeypatch.setenv("TRIAGE_GMAIL", "google")
    api.ctx.gmail = object()  # a real gateway stand-in: connection state comes from the token vault
    fake.mod = mod
    return fake


def _callback(api: Api, user: str, state: str, code: str) -> dict[str, list[str]]:
    from urllib.parse import parse_qs, urlparse

    r = api.client.get("/api/gmail/callback", params={"state": state, "code": code}, headers=iap(user), follow_redirects=False)
    assert r.status_code == 302, r.text
    return parse_qs(urlparse(r.headers["location"]).query)


def test_agent_mailbox_connect_uses_agent_scopes(api, fake_oauth):
    agent = api.ctx.config.agent.email
    assert api.get("/api/me", user=agent).json()["role"] == "none"  # agent mailbox has no Console role, may connect its mailbox
    status = api.get("/api/gmail/status", user=agent).json()
    assert (status["mailbox"], status["connected"], status["can_connect"]) == ("agent", False, True)
    assert "doorbell" in status["message"]
    r = api.get("/api/gmail/connect", user=agent, format="json")
    assert r.status_code == 200, r.text
    assert r.json()["mailbox"] == "agent"
    started = fake_oauth.flows[-1]
    assert started.scopes[:len(fake_oauth.mod.AGENT_SCOPES)] == list(fake_oauth.mod.AGENT_SCOPES)
    assert "openid" in started.scopes and not set(fake_oauth.mod.IM_SCOPES) & set(started.scopes)
    fake_oauth.authorize_as = "someone.else@roster.test"  # the agent picked the wrong Google account
    query = _callback(api, agent, started.state, "code-1")
    assert query["gmail"] == ["error"] and "someone.else@roster.test" in query["reason"][0]
    assert fake_oauth.flows[-1].scopes == started.scopes  # the callback reuses the scopes of the request
    assert fake_oauth.flows[-1].fetched == {"code": "code-1", "code_verifier": "verifier-1"}
    assert agent not in fake_oauth.vault
    assert _callback(api, agent, started.state, "code-1")["gmail"] == ["error"]  # a state works once
    api.get("/api/gmail/connect", user=agent, format="json")
    fake_oauth.authorize_as = agent
    assert _callback(api, agent, fake_oauth.flows[-1].state, "code-2") == {"gmail": ["connected_agent"]}
    assert fake_oauth.vault[agent]["refresh_token"] == "1//refresh"
    assert api.get("/api/gmail/status", user=agent).json()["connected"] is True


def test_im_mailbox_connect_uses_im_scopes(api, fake_oauth):
    from console.backend.gmail_oauth import scope_name

    status = api.get("/api/gmail/status", user=IM).json()
    assert (status["mailbox"], status["connected"], status["can_connect"]) == ("im", False, True)
    assert status["scopes"] == [scope_name(s) for s in fake_oauth.mod.IM_SCOPES]  # compose + metadata|readonly
    assert api.get("/api/gmail/status", user=VIEWER).json()["can_connect"] is False
    assert api.get("/api/gmail/connect", user=VIEWER, format="json").status_code == 403
    r = api.get("/api/gmail/connect", user=IM, format="json")
    assert r.status_code == 200 and r.json()["mailbox"] == "im"
    started = fake_oauth.flows[-1]
    assert started.scopes == list(fake_oauth.mod.IM_SCOPES)
    fake_oauth.authorize_as = IM  # no ID token for IM scopes: the Gmail profile is checked
    assert _callback(api, IM, started.state, "code-3") == {"gmail": ["connected"]}
    assert fake_oauth.vault[IM]["scopes"] == list(fake_oauth.mod.IM_SCOPES)
    assert api.get("/api/gmail/status", user=IM).json()["connected"] is True
    r = api.delete("/api/gmail", user=IM)
    assert r.status_code == 200 and r.json()["connected"] is False and IM not in fake_oauth.vault


def test_gmail_callback_refuses_partial_consent(api, fake_oauth):
    from console.backend.gmail_oauth import scope_name

    compose = next(s for s in fake_oauth.mod.IM_SCOPES if s.endswith("/gmail.compose"))
    read = [s for s in fake_oauth.mod.IM_SCOPES if s != compose]
    api.get("/api/gmail/connect", user=IM, format="json")
    fake_oauth.authorize_as = IM
    fake_oauth.grant_only = [compose]  # the IM unticked the read permission on Google's consent screen
    query = _callback(api, IM, fake_oauth.flows[-1].state, "code-5")
    assert query == {"gmail": ["error"], "reason": ["missing_scopes"],
                     "missing": [",".join(scope_name(s) for s in read)], "mailbox": ["im"]}
    assert IM not in fake_oauth.vault  # the partial token is not kept
    assert api.get("/api/gmail/status", user=IM).json()["connected"] is False
    fake_oauth.grant_only = None  # all permissions on the next try
    api.get("/api/gmail/connect", user=IM, format="json")
    assert _callback(api, IM, fake_oauth.flows[-1].state, "code-6") == {"gmail": ["connected"]}
    assert IM in fake_oauth.vault


def test_read_scope_change_asks_to_reconnect(api, fake_oauth, monkeypatch):
    compose, metadata, readonly = (f"https://www.googleapis.com/auth/gmail.{s}" for s in ("compose", "metadata", "readonly"))
    monkeypatch.setattr(fake_oauth.mod, "IM_SCOPES", (compose, metadata))  # TRIAGE_GMAIL_READ_SCOPE=metadata
    api.get("/api/gmail/connect", user=IM, format="json")
    fake_oauth.authorize_as = IM
    assert _callback(api, IM, fake_oauth.flows[-1].state, "code-9") == {"gmail": ["connected"]}
    assert api.get("/api/gmail/status", user=IM).json()["needs_reconnect"] is False
    monkeypatch.setattr(fake_oauth.mod, "IM_SCOPES", (compose, readonly))  # the Phase 0 spike picked readonly
    status = api.get("/api/gmail/status", user=IM).json()
    assert (status["connected"], status["needs_reconnect"], status["missing_scopes"]) == (True, True, ["readonly"])
    assert "connect again" in status["message"]
    api.get("/api/gmail/connect", user=IM, format="json")
    assert fake_oauth.flows[-1].scopes == [compose, readonly]
    assert _callback(api, IM, fake_oauth.flows[-1].state, "code-10") == {"gmail": ["connected"]}
    assert api.get("/api/gmail/status", user=IM).json()["needs_reconnect"] is False


def test_agent_consent_check_reads_token_scope_and_ignores_identity_aliases(api, fake_oauth):
    from console.backend.gmail_oauth import scope_name

    agent = api.ctx.config.agent.email
    send = list(fake_oauth.mod.AGENT_SCOPES)
    assert api.get("/api/gmail/status", user=agent).json()["scopes"] == [scope_name(s) for s in send]  # no identity scopes
    fake_oauth.authorize_as = agent
    fake_oauth.granted_on_creds = False  # only the token response's `scope` string lists what was granted
    fake_oauth.grant_only = ["openid", "email"]  # gmail.send unticked; identity reported under short aliases
    api.get("/api/gmail/connect", user=agent, format="json")
    query = _callback(api, agent, fake_oauth.flows[-1].state, "code-7")
    assert (query["reason"], query["missing"], query["mailbox"]) == (["missing_scopes"], [",".join(scope_name(s) for s in send)], ["agent"])
    assert agent not in fake_oauth.vault
    fake_oauth.grant_only = send + ["openid", "email"]  # userinfo.email came back as "email": not missing
    api.get("/api/gmail/connect", user=agent, format="json")
    assert _callback(api, agent, fake_oauth.flows[-1].state, "code-8") == {"gmail": ["connected_agent"]}


def test_scope_helpers():
    from console.backend.gmail_oauth import granted_scopes, missing_scopes, scope_name

    compose, metadata = "https://www.googleapis.com/auth/gmail.compose", "https://www.googleapis.com/auth/gmail.metadata"
    assert [scope_name(s) for s in (compose, metadata, "https://mail.google.com/", "openid")] == ["compose", "metadata", "full", "openid"]
    assert missing_scopes([compose, metadata, "openid"], {compose}) == [metadata]
    assert missing_scopes([compose, "https://www.googleapis.com/auth/userinfo.email"], {compose, "email"}) == []
    assert missing_scopes([compose, metadata], None) == []  # no `scope` in the token response: all granted (RFC 6749)
    creds = SimpleNamespace(granted_scopes=[compose])
    assert granted_scopes(SimpleNamespace(), creds) == {compose}
    flow = SimpleNamespace(oauth2session=SimpleNamespace(token={"scope": f"{compose} {metadata}"}))
    assert granted_scopes(flow, SimpleNamespace(granted_scopes=None)) == {compose, metadata}
    assert granted_scopes(SimpleNamespace(), SimpleNamespace()) is None


@pytest.mark.parametrize("path", ["/api/meta", "/api/escalations", "/api/outbox", "/api/oncall/now", "/api/proposals",
                                  "/api/facts", "/api/settings/collection", "/api/rosters/burson/schedule"])
def test_read_endpoints_for_viewers(api, path):
    r = api.get(path, user=VIEWER)
    assert r.status_code == 200, r.text


def test_escalations_and_outbox(api):
    escs = api.get("/api/escalations").json()
    assert escs["count"] > 0 and 0 < escs["open"] < escs["count"]
    assert all(e["is_open"] for e in api.get("/api/escalations", open_only="true").json()["escalations"])
    outbox = api.get("/api/outbox").json()
    assert outbox["count"] > 0 and outbox["undelivered"] >= outbox["stale"] >= 1
    assert all(i["delivered_at"] is None for i in api.get("/api/outbox", undelivered_only="true").json()["items"])


# ---------------------------------------------------------------------------
# Security fixes (Phase A review)
# ---------------------------------------------------------------------------

CONFIG_IM = "im1@ops.test"  # config.analysts role: im


def test_config_im_role_has_analyst_access(api):
    me = api.get("/api/me", user=CONFIG_IM).json()
    assert (me["role"], me["role_source"]) == ("im", "config")
    assert me["can_view"] is True and me["can_act"] is True and me["is_lead"] is False
    assert api.get("/api/cases", user=CONFIG_IM).status_code == 200
    case_id = pending_review_ids(api)[0]
    assert api.post(f"/api/review-queue/{case_id}", {"decision": "suppress", "reason": "dup"}, user=CONFIG_IM).status_code == 200


def test_unsigned_iap_header_is_refused_on_gcp(api, monkeypatch):
    monkeypatch.setenv("TRIAGE_BACKEND", "gcp")
    r = api.get("/api/me", user=ADMIN)  # header only, no signed assertion, no audience configured
    assert r.status_code == 401 and r.json()["code"] == "unauthenticated"
    assert "TRIAGE_IAP_AUDIENCE" in r.json()["error"]
    monkeypatch.setenv("TRIAGE_BACKEND", "local")
    assert api.get("/api/me", user=ADMIN).status_code == 200


def test_chat_app_endpoint_is_disabled_until_configured(api, monkeypatch):
    monkeypatch.delenv("TRIAGE_CHAT_APP_AUDIENCE", raising=False)
    event = {"type": "MESSAGE", "message": {"name": "spaces/x/messages/1", "text": "status TRG-1"},
             "user": {"email": "someone@ops.test"}}
    assert api.client.post("/api/chat-webhook", json=event).status_code == 404


def test_chat_app_endpoint_requires_a_verified_google_chat_token(api, monkeypatch):
    from console.backend import routes_cases

    monkeypatch.setenv("TRIAGE_CHAT_APP_AUDIENCE", "123456789")
    event = {"type": "MESSAGE", "message": {"name": "spaces/x/messages/1", "text": "hello"},
             "user": {"email": "someone@ops.test", "displayName": "Someone"}}
    assert api.client.post("/api/chat-webhook", json=event).status_code == 401  # no bearer token

    def reject(token, audience):
        raise ValueError("bad signature")

    monkeypatch.setattr(routes_cases, "_verify_chat_app_token", reject)
    r = api.client.post("/api/chat-webhook", json=event, headers={"Authorization": "Bearer forged"})
    assert r.status_code == 401 and "Invalid Google Chat token" in r.json()["error"]

    seen = {}

    def accept(token, audience):
        seen.update(token=token, audience=audience)
        return {"iss": "chat@system.gserviceaccount.com", "aud": audience}

    monkeypatch.setattr(routes_cases, "_verify_chat_app_token", accept)
    r = api.client.post("/api/chat-webhook", json=event, headers={"Authorization": "Bearer good"})
    assert r.status_code == 200 and seen == {"token": "good", "audience": "123456789"}
    # never acts for an assumed identity
    anonymous = {"type": "MESSAGE", "message": {"name": "spaces/x/messages/2", "text": "hello"}}
    r = api.client.post("/api/chat-webhook", json=anonymous, headers={"Authorization": "Bearer good"})
    assert r.status_code == 400 and "no sender email" in r.json()["error"]


def test_test_channel_is_admin_only_in_prod_and_uses_config_spaces(api, stub_op):
    calls = stub_op("triage_message", ChatOutputs(summary="stub"))
    body = {"channel": "test_burson", "text": "Alert Name: x\nProduct: Search"}
    assert api.post("/api/test/push", body, user=VIEWER).status_code == 403
    assert api.post("/api/test/push", body, user=IM).status_code == 200
    msg = calls[-1]["payload"]["message"]
    burson = api.ctx.config.space("burson")
    assert msg["space_id"] == burson.space_id and msg["space_name"] == burson.display_name
    assert msg["sender"]["email"] == IM

    api.ctx.config.env = "prod"
    try:
        r = api.post("/api/test/push", body, user=IM)
        assert r.status_code == 403 and r.json()["required_role"] == "admin"
        assert api.post("/api/test/push", body, user=ADMIN).status_code == 200
    finally:
        api.ctx.config.env = "dev"


def test_test_react_acts_as_the_signed_in_user_not_the_im_on_shift(api, stub_op):
    calls = stub_op("record_reaction", ChatOutputs(summary="stub"))
    case_id = api.get("/api/cases").json()["cases"][0]["case_id"]
    on_shift = api.ctx.im_on_shift().person
    assert on_shift is not None and on_shift.email != LEAD, "precondition: someone else is the IM on shift"
    r = api.post("/api/test/react", {"case_id": case_id, "emoji": "📦"}, user=LEAD)
    assert r.status_code == 200
    assert calls[-1]["payload"]["reactor_email"] == LEAD, "never impersonate the IM on shift"


def test_no_incoming_webhook_poster_remains():
    from console.backend import routes_cases

    assert not hasattr(routes_cases, "_deliver_to_google_chat_webhook")
    assert "/api/test/webhook" not in {r.path for r in routes_cases.router.routes}

