"""Agent alerts: the KOF list. An author is a KOF when a cell of the sheet names their handle, by the sheet-based bot's
rule. The sheet's read is replaced by a stand-in (no network); the rule, the index and the cache are the real code."""

from __future__ import annotations


import pytest

from triage_agent.ownalerts import kof

SHEET = "https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit"
TABS = [
    ("SLRR Global INFs", [
        ["Name", "Handle", "Profile", "Vertical"],
        ["Jane Doe", "@JDoe", "https://x.com/jdoe", "Tech"],
        ["Sam Lee (@samlee_tv)", "", "tiktok.com/@sam.lee", "Creators"],
        ["", "", "", ""],
    ]),
    ("Regional", [
        ["Outlet", "Link"],
        ["The Daily Example", "https://www.youtube.com/channel/UCexample123"],
    ]),
]


@pytest.mark.parametrize("cell,found", [
    ("@Jane_Doe", {"jane_doe"}),
    ("jdoe", {"jdoe"}),
    ("Jane Doe (@jdoe)", {"jdoe"}),
    ("https://x.com/jdoe", {"jdoe"}),
    ("tiktok.com/@j.doe", {"j.doe"}),
    ("bsky.app/profile/jdoe.bsky.social", {"jdoe.bsky.social"}),
    ("https://www.linkedin.com/in/jane-doe", {"jane-doe"}),
    ("reddit.com/u/jdoe and @other_one", {"jdoe", "other_one"}),
    ("Jane Doe", set()),
    ("ab", set()),
    ("", set()),
    (None, set()),
])
def test_a_cell_names_a_handle_the_way_the_sheet_bot_reads_it(cell, found):
    assert kof.handles_in(cell) == found


def test_the_index_has_each_handle_with_its_name_and_its_list(ctx):
    index = kof.build(TABS, ctx.config.platform.own_alerts)
    assert index["jdoe"] == {"name": "Jane Doe", "tier": "SLRR Global INFs"}
    assert index["samlee_tv"] == {"name": "Sam Lee (@samlee_tv)", "tier": "SLRR Global INFs"}
    assert index["sam.lee"]["tier"] == "SLRR Global INFs"
    assert index["ucexample123"] == {"name": "The Daily Example", "tier": "Regional"}
    assert "handle" not in index and "name" not in index and "link" not in index, "a header row is never a KOF"
    assert "tech" in index, "with no handle columns named, any cell that is one word counts, as in the sheet bot"


def test_naming_the_handle_columns_and_the_name_column_narrows_it(ctx):
    own = ctx.config.platform.own_alerts
    own.kof_handle_columns = ["Handle", "Profile", "Link"]
    own.kof_name_column = "Vertical"
    index = kof.build(TABS, own)
    assert set(index) == {"jdoe", "sam.lee", "ucexample123"}
    assert index["jdoe"] == {"name": "Tech", "tier": "SLRR Global INFs"}
    assert index["ucexample123"]["name"] == "The Daily Example", "a tab without that column falls back to the first filled cell"


def test_an_author_is_matched_whatever_the_case_or_the_at_sign(ctx):
    index = kof.build(TABS, ctx.config.platform.own_alerts)
    assert kof.match(index, "@JDoe") == {"name": "Jane Doe", "tier": "SLRR Global INFs"}
    assert kof.match(index, "nobody_here") is None and kof.match(index, "") is None and kof.match(index, None) is None


def test_with_no_sheet_set_nobody_is_a_kof_and_nothing_is_read(ctx, monkeypatch):
    monkeypatch.setattr(kof, "read_sheet", lambda link: pytest.fail("no sheet is set"))
    assert kof.lookup(ctx) == {}


def test_the_list_is_read_once_and_again_when_it_is_due(ctx, clock, monkeypatch):
    reads = []
    monkeypatch.setattr(kof, "read_sheet", lambda link: reads.append(link) or TABS)
    own = ctx.config.platform.own_alerts
    own.kof_sheet, own.kof_refresh_minutes = SHEET, 60
    first = kof.lookup(ctx)
    assert first["jdoe"]["name"] == "Jane Doe" and reads == [SHEET]
    clock.advance(minutes=59)
    assert kof.lookup(ctx) == first and len(reads) == 1
    clock.advance(minutes=2)
    kof.lookup(ctx)
    assert len(reads) == 2
    assert kof.status(ctx) == {"set": True, "handles": len(first), "error": "", "at": ctx.now().isoformat()}


def test_a_different_sheet_is_read_at_once(ctx, monkeypatch):
    reads = []
    monkeypatch.setattr(kof, "read_sheet", lambda link: reads.append(link) or TABS)
    own = ctx.config.platform.own_alerts
    own.kof_sheet = SHEET
    kof.lookup(ctx)
    own.kof_sheet = SHEET.replace("0123456789", "9876543210")
    kof.lookup(ctx)
    assert len(reads) == 2


def test_a_read_that_fails_keeps_the_last_list_and_says_why(ctx, clock, monkeypatch):
    own = ctx.config.platform.own_alerts
    own.kof_sheet, own.kof_refresh_minutes = SHEET, 60
    monkeypatch.setattr(kof, "read_sheet", lambda link: TABS)
    good = kof.lookup(ctx)

    def refused(link):
        raise kof.Unreadable("The service's account can't open the KOF sheet: share it with that account (Viewer is enough).")

    monkeypatch.setattr(kof, "read_sheet", refused)
    clock.advance(minutes=61)
    assert kof.lookup(ctx) == good
    assert "share it with that account" in kof.status(ctx)["error"]


def test_a_first_read_that_fails_leaves_nobody_a_kof(ctx, monkeypatch):
    ctx.config.platform.own_alerts.kof_sheet = SHEET

    def refused(link):
        raise kof.Unreadable("Drive answered 500.")

    monkeypatch.setattr(kof, "read_sheet", refused)
    assert kof.lookup(ctx) == {}
    assert kof.status(ctx)["error"] == "Drive answered 500." and kof.status(ctx)["handles"] == 0


def test_a_long_list_is_kept_in_parts_and_read_back_whole(ctx, monkeypatch):
    rows = [["Name", "Handle"]] + [[f"Person {n}", f"@handle_{n:05d}"] for n in range(kof.PART * 2 + 7)]
    monkeypatch.setattr(kof, "read_sheet", lambda link: [("Big", rows)])
    own = ctx.config.platform.own_alerts
    own.kof_sheet, own.kof_handle_columns = SHEET, ["Handle"]
    first = kof.lookup(ctx)
    monkeypatch.setattr(kof, "read_sheet", lambda link: pytest.fail("the kept list is used"))
    assert kof.lookup(ctx) == first and len(first) == kof.PART * 2 + 7
