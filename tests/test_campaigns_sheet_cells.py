"""Campaign sheet cells: text from an alert email or a public post is never read as a formula."""

from __future__ import annotations

from slrr_campaigns.workspace import MAX_SHEET_CELL_CHARS, _sanitize_cell


def test_text_that_starts_like_a_formula_is_kept_as_text() -> None:
    assert _sanitize_cell('=IMPORTDATA("https://outside.test/x")') == "'=IMPORTDATA(\"https://outside.test/x\")"
    assert _sanitize_cell("=HYPERLINK(\"https://outside.test\",\"click\")").startswith("'=")
    assert _sanitize_cell("+1 for this") == "'+1 for this"
    assert _sanitize_cell("-- a dash to start") == "'-- a dash to start"
    assert _sanitize_cell("@someone said") == "'@someone said"
    assert _sanitize_cell("\t=1+1") == "'=1+1"  # leading white space goes; what is left is still kept as text


def test_ordinary_cells_are_written_as_they_are() -> None:
    assert _sanitize_cell("A post about Search") == "A post about Search"
    assert _sanitize_cell("https://x.com/a/status/1") == "https://x.com/a/status/1"
    assert _sanitize_cell(1250) == "1250"
    assert _sanitize_cell("-12") == "-12"  # a plain number stays a number
    assert _sanitize_cell("+3.5") == "+3.5"
    assert _sanitize_cell(None) == ""
    assert _sanitize_cell("") == ""


def test_long_text_is_capped_and_still_escaped() -> None:
    capped = _sanitize_cell("=" + "x" * (MAX_SHEET_CELL_CHARS + 500))
    assert capped.startswith("'=") and capped.endswith(" [truncated]")
    assert len(capped) <= MAX_SHEET_CELL_CHARS + 1
