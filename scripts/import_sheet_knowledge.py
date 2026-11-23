#!/usr/bin/env python3
"""Bring the sheet-based chat bot's knowledge documents into the Console's store, from this computer.

Does what the Knowledge page's "Bring over from the sheet" does (triage_agent/knowledge_import.py), reading the sheet
with your own Google sign-in (gcloud auth application-default login) instead of the Console's account:

    source infra/.env && .venv/bin/python scripts/import_sheet_knowledge.py --dry-run
    source infra/.env && .venv/bin/python scripts/import_sheet_knowledge.py --apply

    --folder PATH   also bring over the files in PATH (Word, PDF, web pages, Markdown and text, and text files with no
                    ending), as an upload on the Knowledge page makes them; the same file name again updates its document
    --file PATH     one file (repeatable)
    --no-sheet      only the files, not the sheet
    --signals       also the sheet's signals (its Watches tab), all OFF

With infra/.env sourced it works on the live store (TRIAGE_BACKEND=gcp, the project's Firestore database), as the
Console does; without it, on the local one (TRIAGE_LOCAL_DB). --dry-run reads and writes nothing. --apply writes the
Console's knowledge documents (and signals with --signals). Nothing is ever written to the sheet. Names and counts are
printed, with any email address masked.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from pathlib import Path
from collections.abc import Callable
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
os.environ.setdefault("GRPC_VERBOSITY", "ERROR")  # Firestore's client otherwise prints its own housekeeping lines

EMAIL = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")
WORDS = {"add": "New", "update": "Updated", "unchanged": "Already the same", "skip": "Left out"}


def mask(text: Any) -> str:
    return EMAIL.sub(lambda m: m.group(0)[0] + "…@…", str(text))


def build_context() -> Any:
    """The Console's own context: the live store when infra/.env is sourced (as infra/10_seed_settings.py does)."""
    env = lambda name, default="": os.environ.get(name, default).strip()  # noqa: E731
    if env("PROJECT_ID"):
        os.environ.setdefault("TRIAGE_BACKEND", "gcp")
        os.environ.setdefault("TRIAGE_PROJECT_ID", env("PROJECT_ID"))
        os.environ.setdefault("GOOGLE_CLOUD_PROJECT", env("PROJECT_ID"))
        os.environ.setdefault("TRIAGE_FIRESTORE_DB", env("FIRESTORE_DB", "(default)"))
        os.environ.setdefault("TRIAGE_ENV", env("TRIAGE_ENV", "dev"))
    os.environ.setdefault("SLRR_FETCH_SHEET_GROUPS", "0")  # the distribution lists are not needed for this
    from console.backend.state import LazyLLM
    from triage_agent.context import build_context as build

    return build(llm=LazyLLM())


def _print_items(title: str, items: list[dict[str, Any]], out: Callable[[str], None]) -> None:
    for action, word in WORDS.items():
        rows = [i for i in items if i["action"] == action]
        if not rows:
            continue
        out(f"\n{title}, {word.lower()} ({len(rows)}):")
        for i in rows:
            size = f" · {i['chars']:,} characters" if i.get("chars") else ""
            burson = " · Burson may see it" if i.get("external_ok") else ""
            out(f"  - {mask(i['title'])}{size}{burson}")
            if action != "add" or not i.get("chars"):
                out(f"      {mask(i['reason'])}")


def main(argv: list[str] | None = None, *, ctx: Any = None, reader: Callable[..., Any] | None = None,
         out: Callable[[str], None] = print) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--dry-run", action="store_true", help="show what would be brought over; write nothing")
    mode.add_argument("--apply", action="store_true", help="bring it over: write the Console's knowledge documents")
    parser.add_argument("--folder", action="append", default=[], help="also the files in this folder (repeatable)")
    parser.add_argument("--file", action="append", default=[], help="also this file (repeatable)")
    parser.add_argument("--no-sheet", action="store_true", help="only the files, not the sheet")
    parser.add_argument("--signals", action="store_true", help="also the sheet's signals (its Watches tab), all OFF")
    parser.add_argument("--actor", default="", help="who the audit log names (default: sheet import script)")
    args = parser.parse_args(argv)

    from triage_agent import knowledge, sheet_read
    from triage_agent import knowledge_import as ki

    ctx = ctx or build_context()
    actor = args.actor.strip() or "sheet import script"
    dry = bool(args.dry_run)
    backend = os.environ.get("TRIAGE_BACKEND", "local")
    where = (f"the live store (Firestore {os.environ.get('TRIAGE_FIRESTORE_DB', '(default)')} in {os.environ.get('TRIAGE_PROJECT_ID', '?')})"
             if backend == "gcp" else f"the local store ({os.environ.get('TRIAGE_LOCAL_DB', '.local/triage.db')})")
    out(f"{'Dry run: nothing is written.' if dry else 'Applying.'} Console store: {where}.")
    if not args.no_sheet:
        try:
            result = ki.run(ctx, actor=actor, dry_run=dry, surface="system", reader=reader)
        except sheet_read.SheetUnreadable as exc:
            out(f"Could not read the sheet: {exc}")
            return 2
        sheet, counts = result["sheet"], result["counts"]
        out(f"Sheet: {sheet['title'] or sheet['id']}, read as {sheet['read_as'] or 'your own Google sign-in'}.")
        out(f"{'Would bring over' if dry else 'Brought over'}: {counts['add']} new, {counts['update']} updated, "
            f"{counts['unchanged']} already the same, {counts['skip']} left out.")
        _print_items("Documents", result["items"], out)
        for note in result["notes"]:
            out(f"\nNote: {mask(note)}")
    if args.folder or args.file:
        cfg = ctx.config.platform.knowledge
        items = ki.folder_items([Path(p).expanduser() for p in [*args.folder, *args.file]], knowledge.list_docs(ctx),
                                max_doc_chars=cfg.max_doc_chars, max_upload_mb=cfg.max_upload_mb)
        if not dry:
            ki.apply(ctx, items, actor=actor, surface="system")
        _print_items("Files", [i.public() for i in items], out)
    if args.signals:
        from triage_agent import watches_import

        try:
            signals = watches_import.run(ctx, actor=actor, dry_run=dry, reader=reader)
        except sheet_read.SheetUnreadable as exc:
            out(f"Could not read the sheet's signals: {exc}")
            return 2
        c = signals["counts"]
        out(f"\nSignals: {c['add']} new, {c['update']} updated, {c['unchanged']} already the same, {c['skip']} left out "
            "(every new one comes over OFF).")
        for i in signals["items"]:
            out(f"  - {mask(i['name'])} ({'ON' if i['on_in_sheet'] else 'OFF'} on the sheet): {mask(i['reason'])}")
        for note in signals["notes"]:
            out(f"Note: {mask(note)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
