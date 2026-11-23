"""Bringing the sheet-based chat bot's knowledge docs over to the Console (triage_agent/knowledge_import.py).

The sheet is never read here: its tabs are small invented rows handed to the importer through a stand-in reader, in
the shape the Sheets API returns them. Everything else runs for real on a SQLite store and through the FastAPI app.
"""

from __future__ import annotations

import json
import warnings
from datetime import UTC, datetime
from typing import Any

import pytest

from console.backend.app import create_app
from triage_agent import knowledge, knowledge_import, sheet_read

with warnings.catch_warnings():
    warnings.simplefilter("ignore")
    from fastapi.testclient import TestClient

ADMIN, LEAD = "admin@ops.test", "lead@ops.test"
DOC_A = "https://docs.google.com/document/d/AAAAAAAAAAAAAAAAAAAAAAAA/edit"
SHEET_B = "https://docs.google.com/spreadsheets/d/BBBBBBBBBBBBBBBBBBBBBBBB/edit"
DOC_C = "https://docs.google.com/document/d/CCCCCCCCCCCCCCCCCCCCCCCC/edit"
GONE = "https://docs.google.com/document/d/DDDDDDDDDDDDDDDDDDDDDDDD/edit?tab=t.old"
CACHE_HEADER = ["Link", "Part", "Text (written by the Burson QA bot)"]


def ms(day: int) -> int:
    return int(datetime(2026, 10, day, 15, 0, tzinfo=UTC).timestamp() * 1000)


def copy_rows(link: str, name: str, parts: list[str], read_day: int, label: str = "Google Doc") -> list[list[Any]]:
    meta = {"url": link, "status": "ok", "name": name, "read_at": ms(read_day), "label": label, "chars": sum(map(len, parts))}
    return [[link, 0, json.dumps(meta)]] + [[link, i, text] for i, text in enumerate(parts, start=1)]


def sheet_tabs(big_chars: int = 140_000) -> dict[str, list[list[Any]]]:
    big = ["x" * 45_000 + "\n"] * (big_chars // 45_001) + ["tail of the list"]
    return {
        "Resources": [
            ["Name", "Link", "What it covers", "Burson can see it?", "Bot status"],
            ["Alert rules (ask desk@ops.test)", DOC_A, "What to alert on", "Yes", "✓ Read Oct 10, 11:00 AM EDT · Google Doc · 19 characters"],
            ["Big list", SHEET_B, "Who is on the list", "No", "✓ Read Oct 10 · Google Sheet (2 tabs) · 1,000,000 characters"],
            ["Not read", DOC_C, "", "", "✗ Not read: the bot's account can't open it"],
            ["Alert rules again", DOC_A + "?usp=sharing#heading=h.abc", "", "Yes", ""],
            ["A name with no link", "", "", "", ""],
        ],
        "Knowledge cache (bot)": [CACHE_HEADER, *copy_rows(DOC_A, "Alert rules", ["Part one. ", "Part two."], 10),
                                  *copy_rows(SHEET_B, "Big list", big, 10, "Google Sheet (2 tabs)")],
        "Knowledge": [["Link", "Part", "Text"], *copy_rows(DOC_A, "Alert rules", ["An older copy."], 1),
                      *copy_rows(GONE, "Old handbook", ["Removed from the tab long ago."], 1)],
        "Guidance": [["Guidance", "Applies to", "Until", "Added by"]],
        "Learned precedents": [["Date", "Post", "Product", "Exposure Tag", "Engagements", "KOF", "Bot call", "IM call", "Lesson / Why", "Active (Yes/No)"],
                               ["2026-10-11 09:00", "https://x.com/a/status/1", "Search", "Brand", "10", "No", "No Social Alert", "Social Alert", "why", ""],
                               ["2026-10-11 10:00", "https://x.com/b/status/2", "Search", "Brand", "10", "No", "Social Alert", "No Social Alert", "why", "No"]],
    }


def reader_for(tabs: dict[str, list[list[Any]]]):
    def read(wanted: list[str], *, sheet: str | None = None, link_columns: dict[str, int] | None = None):
        return ({t: tabs[t] for t in wanted if t in tabs},
                {"sheet_id": "sheet-test", "title": "Control sheet (test)", "read_as": "runtime@proj.test",
                 "missing": [t for t in wanted if t not in tabs], "links": {}})
    return read


@pytest.fixture
def small_store(ctx, monkeypatch):
    """Small limits, so a "big" document is cut and stored in several parts without building megabytes of text."""
    ctx.config.platform.knowledge.max_doc_chars = 100_000
    monkeypatch.setattr(knowledge, "TEXT_PART_CHARS", 40_000)
    return ctx


def by_title(ctx, title: str) -> knowledge.KnowledgeDoc:
    return next(d for d in knowledge.list_docs(ctx) if d.title == title)


def test_link_key_ignores_decorations_but_keeps_tabs():
    assert knowledge_import.link_key(DOC_A) == knowledge_import.link_key(DOC_A + "?usp=sharing#heading=h.abc")
    assert knowledge_import.link_key(DOC_A + "?tab=t.0") == knowledge_import.link_key(DOC_A)
    assert knowledge_import.link_key(DOC_A + "?tab=t.abc") != knowledge_import.link_key(DOC_A)
    assert knowledge_import.link_key(SHEET_B + "#gid=0") != knowledge_import.link_key(SHEET_B)
    assert knowledge_import.link_key("https://www.example.test/page/") == knowledge_import.link_key("http://example.test/page#top")


def test_the_plan_lists_every_row_with_the_freshest_copy_and_plain_reasons(small_store):
    plan = knowledge_import.plan(sheet_tabs(), [], max_doc_chars=100_000)
    assert plan.counts() == {"add": 3, "update": 0, "unchanged": 0, "skip": 3}
    a = next(i for i in plan.items if i.row == 2)
    assert a.text == "Part one. Part two." and a.external_ok is True and a.source_type == "drive", "the cache tab read it later"
    assert a.copy == "19 characters from the sheet's Knowledge cache (bot) tab"
    b = next(i for i in plan.items if i.row == 3)
    assert b.chars == 100_000 and "Only the first 100,000 characters are kept" in (b.note or "") and b.external_ok is False
    c = next(i for i in plan.items if i.row == 4)
    assert c.action == "add" and c.text is None and c.reason.startswith("Link only")
    skipped = {i.row: i.reason for i in plan.items if i.action == "skip"}
    assert skipped[5] == "The same document as row 2, which is brought over."
    assert skipped[6] == "It has no link in column B of the Resources tab."
    assert skipped[None].startswith("Only an old copy is left in the sheet's hidden Knowledge tab")
    assert any("Learned precedents: the sheet's 2 rows (1 in use by the chat bot) are not brought over" in n for n in plan.notes)
    assert any("Guidance tab has no rows" in n for n in plan.notes)
    assert "text" not in a.public() and "note" not in a.public(), "the page never gets the documents' text"


def test_bringing_it_over_twice_adds_once_then_leaves_it_the_same(small_store):
    ctx = small_store
    first = knowledge_import.run(ctx, actor=ADMIN, dry_run=False, reader=reader_for(sheet_tabs()))
    assert first["counts"]["add"] == 3 and len(first["applied"]) == 3 and first["remaining"] == 0
    a = by_title(ctx, "Alert rules (ask desk@ops.test)")
    assert (a.source_type, a.link, a.covers, a.external_ok, a.imported_from) == ("drive", DOC_A, "What to alert on", True, "sheet")
    assert a.status == "ready" and knowledge.get_text(ctx, a.doc_id) == "Part one. Part two."
    assert a.text_from.startswith("the copy brought over from the sheet (the chat bot read it Oct 10")
    assert a.status_detail.startswith("Brought over from the sheet (the chat bot read it Oct 10, 11:00 AM EDT). Google Doc")
    big = by_title(ctx, "Big list")
    parts = ctx.store.list_docs(knowledge.TEXT, where={"doc_id": big.doc_id}, limit=50)
    assert big.chars == 100_000 and len(parts) == 3 and big.chunks > 50, "a big document is stored in parts and passages"
    pending = by_title(ctx, "Not read")
    assert pending.status == "pending" and pending.status_detail.startswith("Not read yet")
    again = knowledge_import.run(ctx, actor=ADMIN, dry_run=False, reader=reader_for(sheet_tabs()))
    assert again["counts"] == {"add": 0, "update": 0, "unchanged": 3, "skip": 3} and again["applied"] == []
    assert len(knowledge.list_docs(ctx)) == 3
    assert any(p.doc_id == a.doc_id for p in knowledge.retrieve(ctx, "what to alert on part two"))


def test_a_changed_row_updates_its_document_and_console_docs_are_never_removed(small_store):
    ctx = small_store
    mine = knowledge.save_doc(ctx, actor=LEAD, title="Written in the Console", text="Escalate leaks to the leads.")
    knowledge_import.run(ctx, actor=ADMIN, dry_run=False, reader=reader_for(sheet_tabs()))
    tabs = sheet_tabs()
    tabs["Resources"][1][2], tabs["Resources"][1][3] = "What to alert on, and when", "No"
    tabs["Knowledge cache (bot)"] = [CACHE_HEADER, *copy_rows(DOC_A, "Alert rules", ["Part one, edited."], 11), *tabs["Knowledge cache (bot)"][4:]]
    del tabs["Resources"][2]  # the big list is taken off the Resources tab
    plan = knowledge_import.run(ctx, actor=ADMIN, dry_run=True, reader=reader_for(tabs))
    a = next(i for i in plan["items"] if i["link"] == DOC_A)
    assert a["action"] == "update" and a["changes"] == ["what it covers", "Burson no longer sees it", "text"]
    knowledge_import.run(ctx, actor=ADMIN, dry_run=False, reader=reader_for(tabs))
    doc = by_title(ctx, "Alert rules (ask desk@ops.test)")
    assert knowledge.get_text(ctx, doc.doc_id) == "Part one, edited." and doc.external_ok is False and doc.version == 2
    titles = {d.title for d in knowledge.list_docs(ctx)}
    assert {"Written in the Console", "Big list"} <= titles, "nothing in the Console is removed"
    assert knowledge.get_text(ctx, mine.doc_id) == "Escalate leaks to the leads."


def test_a_document_a_person_linked_is_filled_in_not_doubled(small_store, monkeypatch):
    ctx = small_store

    def no_access(link: str, max_chars: int):
        raise knowledge.FetchError("The Console can't open this file as runtime@proj.test: share it with runtime@proj.test (Viewer is enough).")

    monkeypatch.setattr(knowledge, "fetch_drive", no_access)
    theirs = knowledge.save_doc(ctx, actor=LEAD, title="Our alert rules", source_type="drive", link=DOC_A + "?usp=sharing", external_ok=False)
    assert theirs.status == "error"
    plan = knowledge_import.run(ctx, actor=ADMIN, dry_run=True, reader=reader_for(sheet_tabs()))
    a = next(i for i in plan["items"] if i["row"] == 2)
    assert a["action"] == "update" and a["doc_id"] == theirs.doc_id and a["changes"] == ["what it covers", "text"]
    assert "the sheet says Burson can see it; the Console's setting is kept" in a["reason"]
    knowledge_import.run(ctx, actor=ADMIN, dry_run=False, reader=reader_for(sheet_tabs()))
    doc = knowledge.get_doc(ctx, theirs.doc_id)
    assert (doc.title, doc.external_ok, doc.imported_from, doc.status) == ("Our alert rules", False, "", "ready")
    assert knowledge.get_text(ctx, doc.doc_id) == "Part one. Part two."
    assert sum(1 for d in knowledge.list_docs(ctx) if knowledge_import.link_key(d.link) == knowledge_import.link_key(DOC_A)) == 1


def test_the_sheets_copy_stays_in_use_until_the_console_can_read_the_file(small_store, monkeypatch):
    ctx = small_store
    knowledge_import.run(ctx, actor=ADMIN, dry_run=False, reader=reader_for(sheet_tabs()))
    doc = by_title(ctx, "Alert rules (ask desk@ops.test)")

    def no_access(link: str, max_chars: int):
        raise knowledge.FetchError("The Console can't open this file as runtime@proj.test: share it with runtime@proj.test (Viewer is enough).")

    monkeypatch.setattr(knowledge, "fetch_drive", no_access)
    kept = knowledge.refresh_doc(ctx, doc, force=True)
    assert kept.status == "ready" and kept.status_detail.startswith("Using the copy brought over from the sheet")
    assert "share it with runtime@proj.test" in kept.status_detail and kept.content_hash == doc.content_hash
    assert any(p.doc_id == doc.doc_id for p in knowledge.retrieve(ctx, "part two")), "still read by the agent"
    other = knowledge.save_doc(ctx, actor=LEAD, title="Linked by a person", source_type="drive", link=DOC_C + "x")
    assert other.status == "error", "a document with no copy in hand still fails as before"
    monkeypatch.setattr(knowledge, "fetch_drive", lambda link, max_chars: ("Fresh text read by the Console.", "Google Doc"))
    fresh = knowledge.refresh_doc(ctx, knowledge.get_doc(ctx, doc.doc_id))
    assert fresh.text_from == "" and fresh.status_detail == "Google Doc" and knowledge.get_text(ctx, doc.doc_id) == "Fresh text read by the Console."
    plan = knowledge_import.plan(sheet_tabs(), knowledge.list_docs(ctx), max_doc_chars=100_000)
    again = next(i for i in plan.items if i.row == 2)
    assert again.action == "unchanged" and "the Console reads this document itself" in again.reason


def test_guidance_rows_become_guidance_and_expired_ones_are_turned_off(small_store, clock):
    ctx = small_store
    tabs = sheet_tabs()
    tabs["Guidance"] = [["Guidance", "Applies to", "Until", "Added by"],
                        ["Do not alert on benchmark posts this week.", "reviews", "10/20/2026", "lead@ops.test"],
                        ["An old instruction.", "", "2026-10-01", ""]]
    plan = knowledge_import.run(ctx, actor=ADMIN, dry_run=False, reader=reader_for(tabs))
    rules = [i for i in plan["items"] if i["kind"] == "guidance"]
    assert [(i["action"], i["reason"]) for i in rules] == [("add", "New guidance (it outranks documents)."),
                                                          ("skip", "Its Until date (2026-10-01) has passed.")]
    guide = next(d for d in knowledge.list_docs(ctx) if d.kind == "guidance")
    text = knowledge.get_text(ctx, guide.doc_id)
    assert text == "Do not alert on benchmark posts this week.\n\nApplies to: reviews\nUntil: 2026-10-20" and "lead@" not in text
    clock.advance(days=10)
    later = knowledge_import.run(ctx, actor=ADMIN, dry_run=False, reader=reader_for(tabs))
    assert next(i for i in later["items"] if i["kind"] == "guidance" and i["row"] == 2)["changes"] == ["turned off"]
    assert knowledge.get_doc(ctx, guide.doc_id).enabled is False


def test_files_in_a_folder_come_over_as_written_documents(small_store, tmp_path):
    ctx = small_store
    folder = tmp_path / "docs"
    folder.mkdir()
    (folder / "SLRR_handbook").write_text("How the shift works.\n\nHand over at six.", encoding="utf-8")
    (folder / "guide.md").write_text("# Guide\n\n- one\n- two", encoding="utf-8")
    (folder / "slides.png").write_bytes(b"\x89PNG\r\n\x1a\n\x00\x00binary")
    cfg = ctx.config.platform.knowledge
    items = knowledge_import.folder_items([folder], knowledge.list_docs(ctx), max_doc_chars=cfg.max_doc_chars, max_upload_mb=cfg.max_upload_mb)
    assert [(i.action, i.title) for i in items] == [("add", "SLRR handbook"), ("add", "guide"), ("skip", "slides.png")]
    assert items[2].reason == "Not a file the Console can read: Word, PDF, a web page, Markdown or text."
    knowledge_import.apply(ctx, items, actor=ADMIN, surface="system")
    handbook = by_title(ctx, "SLRR handbook")
    assert (handbook.source_type, handbook.file_name, handbook.imported_from, handbook.rich) == ("text", "SLRR_handbook", "folder", True)
    assert knowledge.get_text(ctx, handbook.doc_id) == "How the shift works.\n\nHand over at six."
    (folder / "SLRR_handbook").write_text("How the shift works.\n\nHand over at seven.", encoding="utf-8")
    again = knowledge_import.folder_items([folder], knowledge.list_docs(ctx), max_doc_chars=cfg.max_doc_chars, max_upload_mb=cfg.max_upload_mb)
    assert [i.action for i in again] == ["update", "unchanged", "skip"]


@pytest.fixture
def client(small_store, monkeypatch):
    for var in ("TRIAGE_IAP_AUDIENCE", "TRIAGE_DEV_USER", "K_SERVICE", "TRIAGE_BOOTSTRAP_ADMIN"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setenv("TRIAGE_BACKEND", "local")
    with TestClient(create_app(ctx=small_store)) as c:
        yield c


def iap(email: str) -> dict[str, str]:
    return {"X-Goog-Authenticated-User-Email": f"accounts.google.com:{email}"}


def test_the_endpoint_is_for_admins_previews_first_and_brings_big_sheets_over_in_steps(small_store, client, monkeypatch):
    monkeypatch.setattr(sheet_read, "read_tabs", reader_for(sheet_tabs()))
    assert client.get("/api/knowledge", headers=iap(ADMIN)).json()["can_import"] is True
    assert client.get("/api/knowledge", headers=iap(LEAD)).json()["can_import"] is False
    assert client.post("/api/knowledge/import-sheet", json={"dry_run": True}, headers=iap(LEAD)).status_code == 403
    preview = client.post("/api/knowledge/import-sheet", json={"dry_run": True}, headers=iap(ADMIN)).json()
    assert preview["counts"]["add"] == 3 and preview["sheet"]["read_as"] == "runtime@proj.test" and knowledge.list_docs(small_store) == []
    step = client.post("/api/knowledge/import-sheet", json={"dry_run": False, "budget_chars": 10_000}, headers=iap(ADMIN)).json()
    assert [a["title"] for a in step["applied"]] == ["Alert rules (ask desk@ops.test)", "Not read"] and step["remaining"] == 1
    last = client.post("/api/knowledge/import-sheet", json={"dry_run": False, "budget_chars": 10_000}, headers=iap(ADMIN)).json()
    assert [a["title"] for a in last["applied"]] == ["Big list"] and last["remaining"] == 0
    assert len(knowledge.list_docs(small_store)) == 3


def test_when_the_sheet_cant_be_read_the_page_is_told_whom_to_share_it_with(small_store, client, monkeypatch):
    def refused(*_: Any, **__: Any):
        raise sheet_read.SheetUnreadable("The Console can't open the control sheet as runtime@proj.test. Share the sheet with "
                                         "runtime@proj.test (Viewer is enough), then try again.")

    monkeypatch.setattr(sheet_read, "read_tabs", refused)
    got = client.post("/api/knowledge/import-sheet", json={"dry_run": True}, headers=iap(ADMIN))
    assert got.status_code == 502 and got.json()["code"] == "sheet_unreadable"
    assert got.json()["error"].startswith("The Console can't open the control sheet as runtime@proj.test. Share the sheet with")


def test_the_script_dry_run_writes_nothing_and_masks_addresses(small_store):
    from scripts import import_sheet_knowledge as script

    lines: list[str] = []
    assert script.main(["--dry-run"], ctx=small_store, reader=reader_for(sheet_tabs()), out=lines.append) == 0
    text = "\n".join(lines)
    assert knowledge.list_docs(small_store) == [] and "Would bring over: 3 new, 0 updated, 0 already the same, 3 left out." in text
    assert "desk@ops.test" not in text and "Alert rules (ask d…@…)" in text
    lines.clear()
    assert script.main(["--apply"], ctx=small_store, reader=reader_for(sheet_tabs()), out=lines.append) == 0
    assert len(knowledge.list_docs(small_store)) == 3 and any(line.startswith("Brought over: 3 new") for line in lines)
    with pytest.raises(SystemExit):
        script.main([], ctx=small_store, reader=reader_for(sheet_tabs()), out=lines.append)
