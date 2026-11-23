"""Signals (the Console's watches) made like the sheet's Watches tab: kept whatever the Watches switch says, turned on one
at a time up to the limit, each saying in plain words what is happening, and the sheet's own rows brought over, all OFF.

The sheet is never read here: its Watches tab is invented rows handed over through a stand-in reader.
"""

from __future__ import annotations

import warnings
from typing import Any

import pytest

from console.backend.app import create_app
from triage_agent import sheet_read, watches, watches_import

with warnings.catch_warnings():
    warnings.simplefilter("ignore")
    from fastapi.testclient import TestClient

LEAD, IM = "lead@ops.test", "im1@ops.test"
HEADER = ["Watch", "On", "What to look for (a yes/no question for Gemini)", "How to score impact (1-10)", "Topics (comma-separated)",
          "Flag at score", "Networks (blank: all)", "Status (written by the bot)"]


def watches_tab() -> list[list[Any]]:
    return [HEADER,
            ["Midterms 2026 ×  Civics", "OFF", "Does this post tie Google to the 2026 midterms?", "Score 1-10 for the midterms.",
             "Election info and results; Political ads, Other, political ads", 6, "Twitter, IG", "OFF: not watched"],
            ["Brand Safety Alert", "ON", "Is this post negative about Google?", "", "", "12", "", "✓ watched · today: 0 flagged"],
            ["No question yet", "OFF", "", "", "", "", "", ""],
            ["Brand safety alert", True, "A second row with the same name.", "", "", "", "", ""]]


def reader_for(rows: list[list[Any]]):
    def read(wanted: list[str], *, sheet: str | None = None, link_columns: dict[str, int] | None = None):
        return {"Watches": rows}, {"sheet_id": "sheet-test", "title": "Control sheet (test)", "read_as": "runtime@proj.test",
                                   "missing": [], "links": {}}
    return read


def save(ctx, name: str, **extra: Any) -> watches.Watch:
    return watches.save_watch(ctx, LEAD, {"name": name, "question": f"Is this about {name}?", **extra})


def test_signals_are_kept_whatever_the_switch_says_and_turned_on_up_to_the_limit(ctx):
    assert ctx.flag("watches") is False
    first = save(ctx, "AI answers", topics=["AI 'answers'"], networks=["Twitter", " IG ", "tiktok", "X"])
    assert first.enabled is False and first.topics == ["AI answers"] and first.networks == ["x", "instagram", "tiktok"]
    ctx.config.platform.campaigns.watch_max_enabled = 1
    assert watches.set_enabled(ctx, LEAD, first.watch_id, True).enabled is True
    second = save(ctx, "Privacy")
    with pytest.raises(ValueError, match="At most 1 signal can be on at once: each one is a question Gemini asks of every new post"):
        watches.set_enabled(ctx, LEAD, second.watch_id, True)
    with pytest.raises(ValueError, match="At most 1 signal can be on"):
        save(ctx, "Third", enabled=True)
    assert watches.set_enabled(ctx, LEAD, first.watch_id, False).enabled is False
    assert watches.set_enabled(ctx, LEAD, second.watch_id, True).enabled is True
    with pytest.raises(KeyError):
        watches.set_enabled(ctx, LEAD, "W-none", True)
    assert watches.delete_watch(ctx, LEAD, first.watch_id) and [w.name for w in watches.list_watches(ctx)] == ["Privacy"]


def test_each_signal_says_what_is_happening_in_plain_words():
    w = watches.Watch(watch_id="W-1", name="AI answers", question="q?")
    status = lambda **kw: watches.plain_status(w, **{"switch_on": True, "sources_set": True, "checked": True, "limit": 5, **kw})  # noqa: E731
    assert status() == "Off: not checked."
    w.sheet_on = True
    assert status() == "Off: not checked. It was ON on the sheet: turn it on here when you are ready."
    w.enabled = True
    assert status(switch_on=False).startswith("On, but nothing is checked yet: the Watches switch is off")
    assert status(checked=False) == "On, but not checked: only 5 signals are checked at once."
    assert status(sources_set=False) == "On, but not checked: no table of posts is chosen (Settings, Campaigns & watches)."
    assert status(flagged=2, near=1) == "Checked. Last 24 hours: 2 flagged, 1 near miss. Waiting for its first look."
    w.status = "looked at 1 source(s) at 14:05 UTC"
    assert status() == "Checked. Last 24 hours: 0 flagged, 0 near misses. Last look: looked at 1 source(s) at 14:05 UTC."


def test_the_sheets_rows_are_read_as_the_bot_reads_them():
    rows, note = watches_import.sheet_watches(watches_tab())
    assert note == "" and [r.name for r in rows] == ["Midterms 2026 × Civics", "Brand Safety Alert", "No question yet", "Brand safety alert"]
    mid, brand = rows[0], rows[1]
    assert (mid.on, mid.flag_at_score, mid.networks, mid.topics) == (False, 6.0, ["x", "instagram"], ["Election info and results", "Political ads"])
    assert brand.on is True and brand.flag_at_score is None, "a bar outside 1 to 10 is the default bar"
    assert brand.rubric == watches.SHEET_DEFAULT_RUBRIC and brand.topics == watches.SHEET_DEFAULT_TOPICS
    assert rows[3].on is True, "a ticked box counts as ON"
    assert watches_import.sheet_watches([["Name", "On", "Question"]])[1].startswith("The Watches tab's first row is not the chat bot's")


def test_the_sheets_signals_come_over_off_and_again_update_by_name(ctx):
    first = watches_import.run(ctx, actor=LEAD, dry_run=True, reader=reader_for(watches_tab()))
    assert first["counts"] == {"add": 2, "update": 0, "unchanged": 0, "skip": 2} and watches.list_watches(ctx) == []
    reasons = {i["name"]: i["reason"] for i in first["items"]}
    assert reasons["Brand Safety Alert"] == "New signal, OFF. It is ON on the sheet: turn it on here when you are ready."
    assert reasons["No question yet"] == "Its question (What to look for) is empty on the sheet."
    assert reasons["Brand safety alert"] == "The same name as row 3: the sheet watches each name once."
    assert first["on_in_sheet"] == ["Brand Safety Alert", "Brand safety alert"]
    watches_import.run(ctx, actor=LEAD, dry_run=False, reader=reader_for(watches_tab()))
    made = {w.name: w for w in watches.list_watches(ctx)}
    assert set(made) == {"Midterms 2026 × Civics", "Brand Safety Alert"} and not any(w.enabled for w in made.values())
    assert made["Brand Safety Alert"].sheet_on is True and made["Brand Safety Alert"].imported_from == "sheet"
    watches.set_enabled(ctx, LEAD, made["Brand Safety Alert"].watch_id, True)  # a person turns it on here
    rows = watches_tab()
    rows[2][2] = "Is this post negative about Google, its products or its people?"
    again = watches_import.run(ctx, actor=LEAD, dry_run=False, reader=reader_for(rows))
    assert again["counts"] == {"add": 0, "update": 1, "unchanged": 1, "skip": 2}
    assert next(i for i in again["items"] if i["action"] == "update")["reason"] == "Updates its question. It stays ON here."
    now = {w.name: w for w in watches.list_watches(ctx)}
    assert len(now) == 2 and now["Brand Safety Alert"].enabled is True and now["Brand Safety Alert"].question.endswith("its people?")


@pytest.fixture
def client(ctx, monkeypatch):
    for var in ("TRIAGE_IAP_AUDIENCE", "TRIAGE_DEV_USER", "K_SERVICE", "TRIAGE_BOOTSTRAP_ADMIN"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setenv("TRIAGE_BACKEND", "local")
    with TestClient(create_app(ctx=ctx)) as c:
        yield c


def iap(email: str) -> dict[str, str]:
    return {"X-Goog-Authenticated-User-Email": f"accounts.google.com:{email}"}


def test_the_signal_endpoints_work_with_the_switch_off(ctx, client, monkeypatch):
    made = client.post("/api/watches", json={"name": "AI answers", "question": "Is this about a harmful AI answer?"}, headers=iap(LEAD))
    assert made.status_code == 200 and made.json()["watch"]["enabled"] is False
    assert client.post("/api/watches", json={"name": "W", "question": "q?"}, headers=iap(IM)).status_code == 403
    wid = made.json()["watch"]["watch_id"]
    on = client.post(f"/api/watches/{wid}/switch", json={"enabled": True}, headers=iap(LEAD))
    assert on.status_code == 200 and on.json()["watch"]["enabled"] is True
    assert client.post("/api/watches/W-none/switch", json={"enabled": True}, headers=iap(LEAD)).status_code == 404
    ctx.config.platform.campaigns.watch_max_enabled = 1
    other = client.post("/api/watches", json={"name": "Privacy", "question": "Is this about privacy?"}, headers=iap(LEAD)).json()["watch"]
    refused = client.post(f"/api/watches/{other['watch_id']}/switch", json={"enabled": True}, headers=iap(LEAD))
    assert refused.status_code == 422 and refused.json()["error"].startswith("At most 1 signal can be on at once")
    listing = client.get("/api/watches", headers=iap(IM)).json()
    assert listing["switch"] is False and listing["can_edit"] is False and listing["defaults"]["rubric"] == watches.SHEET_DEFAULT_RUBRIC
    assert listing["defaults"]["topics"] == watches.SHEET_DEFAULT_TOPICS and listing["defaults"]["flag_at_score"] == 7
    assert [t["name"] for t in listing["templates"]] == ["Midterms 2026 × Google", "Google brand safety (all)"]
    first = next(w for w in listing["watches"] if w["name"] == "AI answers")
    assert first["plain_status"].startswith("On, but nothing is checked yet") and first["checked"] is False
    assert client.post("/api/watches/run", headers=iap(LEAD)).json()["error"].startswith("Checking new posts against the signals is switched off")
    monkeypatch.setattr(sheet_read, "read_tabs", reader_for(watches_tab()))
    assert client.post("/api/watches/import-sheet", json={"dry_run": True}, headers=iap(IM)).status_code == 403
    preview = client.post("/api/watches/import-sheet", json={"dry_run": True}, headers=iap(LEAD)).json()
    assert preview["counts"]["add"] == 2 and len(watches.list_watches(ctx)) == 2
    done = client.post("/api/watches/import-sheet", json={"dry_run": False}, headers=iap(LEAD)).json()
    assert len(done["applied"]) == 2 and len(watches.list_watches(ctx)) == 4
    assert sum(1 for w in watches.list_watches(ctx) if w.enabled) == 1, "only the signal a person turned on is on"
