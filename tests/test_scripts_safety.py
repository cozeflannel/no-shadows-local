"""Safety of the two maintenance scripts that can destroy or rewrite local files.

Neither script is run for real here. mine_burson_history is only driven down the paths that stop
before any write (its inputs and outputs are pointed at tmp_path as well, so a mistake in a test
cannot reach config/precedents.json); sync_live_bigquery only has its argument parser exercised,
with sync_live replaced by a recorder.
"""

from __future__ import annotations

import inspect
import json

import pytest

from scripts import mine_burson_history as mine


@pytest.fixture
def sandbox(tmp_path, monkeypatch):
    """The script's history CSV (present, header only) and both output files, all under tmp_path."""
    history = tmp_path / "burson_live_history.csv"
    history.write_text("THREAD_ID,CREATED_TIME,SENDER_TYPE,MESSAGE_TEXT\n", encoding="utf-8")
    monkeypatch.setattr(mine, "CSV_PATH", history)
    monkeypatch.setattr(mine, "PRECEDENTS_OUT", tmp_path / "precedents.json")
    monkeypatch.setattr(mine, "SFT_OUT", tmp_path / "vertex_sft_burson.jsonl")
    return tmp_path


def _nothing_written(sandbox) -> bool:
    return not (sandbox / "precedents.json").exists() and not (sandbox / "vertex_sft_burson.jsonl").exists()


# ---------------------------------------------------------------------------
# V6. mine_burson_history: the emoji export is an argument, and a bad one stops the run
# ---------------------------------------------------------------------------


def test_mining_needs_the_emoji_export_argument(sandbox, capsys):
    with pytest.raises(SystemExit) as stop:
        mine.main([])
    assert stop.value.code == 2 and "--bq-emoji-json" in capsys.readouterr().err
    assert _nothing_written(sandbox)


def test_mining_stops_when_the_emoji_export_is_missing(sandbox, capsys):
    assert mine.main(["--bq-emoji-json", str(sandbox / "absent.json")]) == 2
    err = capsys.readouterr().err
    assert "not found" in err and "Nothing was written" in err
    assert _nothing_written(sandbox)


@pytest.mark.parametrize("content", [
    "this is not json",
    "{}",  # no schema
    '{"schema": {"fields": "url"}}',  # fields is not a list of columns
    '{"schema": {"fields": [{"name": "post"}, {"name": "likes"}]}, "rows": []}',  # another query's result
    '{"schema": {"fields": [{"name": "url"}, {"name": "google_emoji_1"}]}, "rows": [{"f": [{"v": "https://x.com/a"}]}]}',
])
def test_mining_stops_when_the_emoji_export_cannot_be_read(sandbox, capsys, content):
    export = sandbox / "export.json"
    export.write_text(content, encoding="utf-8")
    assert mine.main(["--bq-emoji-json", str(export)]) == 2
    assert "Nothing was written" in capsys.readouterr().err
    assert _nothing_written(sandbox)


def test_a_good_emoji_export_is_parsed(tmp_path):
    export = tmp_path / "export.json"
    export.write_text(json.dumps({
        "schema": {"fields": [{"name": "url"}, {"name": "google_emoji_1"}, {"name": "google_emoji_2"}]},
        "rows": [
            {"f": [{"v": "https://twitter.com/Someone/status/123?s=20"}, {"v": " escalated "}, {"v": None}]},
            {"f": [{"v": ""}, {"v": "no url, skipped"}, {"v": None}]},
            {"f": [{"v": "https://x.com/other/status/456"}, {"v": None}, {"v": ""}]},
        ],
    }), encoding="utf-8")
    assert mine.load_bq_emojis(export) == {"https://x.com/someone/status/123": ["escalated"]}


def test_no_path_outside_the_repository_is_built_in():
    source = inspect.getsource(mine)
    assert ".gemini" not in source and "/Users/" not in source


# ---------------------------------------------------------------------------
# V5. sync_live_bigquery: the local DB is deleted only when the caller asks
# ---------------------------------------------------------------------------


def test_sync_live_resets_only_on_request(monkeypatch, tmp_path):
    pytest.importorskip("google.cloud.bigquery")  # imported by the script at module level
    from scripts import sync_live_bigquery as sync

    assert inspect.signature(sync.sync_live).parameters["reset"].default is False
    assert "[--reset]" in (sync.__doc__ or ""), "the documented command matches the parser"

    calls: list[dict] = []
    monkeypatch.setattr(sync, "sync_live", lambda **kwargs: calls.append(kwargs))  # the real sync never runs
    db = tmp_path / "live.db"
    db.write_bytes(b"existing local data")
    sync.main(["--db", str(db)])
    sync.main(["--db", str(db), "--no-reset"])
    sync.main(["--db", str(db), "--reset"])
    assert calls == [
        {"db_path": str(db), "reset": False},
        {"db_path": str(db), "reset": False},
        {"db_path": str(db), "reset": True},
    ]
    assert db.read_bytes() == b"existing local data"


def test_sync_live_db_default_follows_the_environment(monkeypatch, tmp_path):
    pytest.importorskip("google.cloud.bigquery")
    from scripts import sync_live_bigquery as sync

    calls: list[dict] = []
    monkeypatch.setattr(sync, "sync_live", lambda **kwargs: calls.append(kwargs))
    monkeypatch.setenv("TRIAGE_LOCAL_DB", str(tmp_path / "working.db"))
    sync.main([])
    assert calls == [{"db_path": str(tmp_path / "working.db"), "reset": False}], "the working DB is not reset"
