"""The temp check's final output, word for word against the temp check app's.

tests/parity/tempcheck_writeup.json holds what the app's own code (tempcheck-app/lib/tempcheck.js writeup and prompt,
service.js chartOf) writes for four temp checks: a Brandwatch query's, one from our own tables counted from a chosen
time, an update counted in the standing queries, and one that counted nothing. The same inputs go through the
Console's port here, and the write-up (text and HTML), the title, what Gemini is asked and the chart's labels must
be the same. tests/parity/make_tempcheck_writeup.js makes the file.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pytest

from triage_agent import tempcheck

APP = json.loads((Path(__file__).parent / "parity" / "tempcheck_writeup.json").read_text())["cases"]


def at(ms: Any) -> datetime:
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc)


def post(p: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in p.items()}


def check_from(d: dict[str, Any]) -> tuple[tempcheck.TempCheck, dict[str, Any] | None]:
    """The app's temp check as the Console's record."""
    v, level = d.get("velocity"), dict(d.get("level") or {})
    if "fullYear" in level:
        level["full_year"] = level.pop("fullYear")
    check = tempcheck.TempCheck(
        check_id="TC-parity", issue=d["issue"], created_at=at(d["now"]), window_to=at(d["now"]), window_from=at(d["start"]["at"]),
        basis=d["basis"], standing=bool(d.get("standing")),
        query={"name": (d.get("query") or {}).get("name"), "id": (d.get("query") or {}).get("id"), "url": d.get("bwUrl") or ""},
        total=d["total"], start={"at": at(d["start"]["at"]).isoformat(), "why": d["start"]["why"]},
        hours=[{"at": at(h["at"]).isoformat(), "n": h["n"]} for h in d.get("hours") or []],
        velocity=({"peak": {"at": at(v["peak"]["at"]).isoformat(), "n": v["peak"]["n"]}, "last": {"at": at(v["last"]["at"]).isoformat(), "n": v["last"]["n"]},
                   "pct": v["pct"]} if v else None),
        sentiment=d.get("sentiment") or {}, sources=d.get("sources") or [], eng_sources=d.get("engSources") or [], mention_types=d.get("mentionTypes") or [],
        posts=[post(p) for p in d.get("posts") or []], read_posts=[post(p) for p in d.get("linkPosts") or []], gem=d.get("gem") or {}, level=level)
    update = {"at": at(d["update"]["at"]), "total": d["update"]["tot"]} if d.get("update") else None
    return check, update


@pytest.fixture
def pacific(ctx):
    ctx.config.platform.temp_check.timezone = "America/Los_Angeles"
    return ctx


@pytest.mark.parametrize("name", sorted(APP))
def test_the_write_up_is_the_apps_word_for_word(pacific, name):
    check, update = check_from(APP[name]["input"])
    tempcheck.write_up(pacific, check, update=update)
    assert check.title == APP[name]["title"]
    assert check.writeup_text == APP[name]["text"]
    assert check.writeup_html == APP[name]["html"]


@pytest.mark.parametrize("name", [n for n in sorted(APP) if APP[n]["prompt"]])
def test_gemini_is_asked_what_the_app_asks(pacific, name):
    check, update = check_from(APP[name]["input"])
    assert tempcheck.prompt_for(pacific, check, update=update) == APP[name]["prompt"]


def test_the_charts_title_and_hour_labels_are_the_apps(pacific):
    check, _ = check_from(APP["query"]["input"])
    assert tempcheck.chart_of(pacific, check) == APP["query"]["chart"]


def test_times_are_named_the_way_the_team_writes_them(ctx):
    for zone, short in (("America/Los_Angeles", "PT"), ("America/New_York", "ET"), ("America/Chicago", "CT"), ("America/Denver", "MT"), ("UTC", "UTC")):
        ctx.config.platform.temp_check.timezone = zone
        clock = tempcheck._Clock(ctx)
        assert clock.abbr(datetime(2026, 11, 22, 10, 20, tzinfo=timezone.utc)) == short
        assert clock.abbr(datetime(2026, 7, 4, 10, 20, tzinfo=timezone.utc)) == short, "the same in summer"
