"""Bringing the sheet-based chat bot's knowledge documents over to the Console: a plan first (pure), then apply.

What the control sheet holds (read by sheet_read.py, read-only):
  Resources              Name · Link · What it covers · Burson can see it? · Bot status: the documents, one a row
  Knowledge cache (bot)  Link · Part · Text: the bot's copy of each document's text (part 0: what it knows about the
                         document, as JSON; parts 1 and up: the text, in order, up to 45,000 characters a cell)
  Knowledge              the same shape: an older copy an earlier build of the bot left behind
  Guidance               Guidance · Applies to · Until · Added by: what the leads want escalated (or not) for now
  Learned precedents     the bot's record of calls the IMs made differently: not brought over (said in the notes)

Each Resources row becomes a Console document: its name, link, what it covers, whether Burson may see it (external_ok)
and the text of the freshest copy the sheet keeps (the bot's cache tab, unless the older Knowledge tab read it later).
It keeps its Drive link as its source, so the Console reads it from Drive itself once its account can open the file
(knowledge.refresh_doc); until then the sheet's copy is used. A document of a million characters (the KOF lists) is
stored like any other: in parts, split into passages for retrieval, up to Settings → Knowledge → max_doc_chars.

Bringing it over again updates instead of duplicating: a sheet document is the same as a Console document with the same
link (whatever its #heading or ?usp decorations) or one this import made. Nothing in the Console is ever removed. A
document a person made in the Console keeps its name, visibility, kind and text; only what it lacks is filled in (its
text when it has none, what it covers when that is blank). Each Guidance row still in force becomes a guidance document.

Files in a folder (scripts/import_sheet_knowledge.py --folder) are brought over the same way, as uploads are.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import asdict, dataclass, field
from datetime import UTC, date, datetime
from pathlib import Path
from collections.abc import Callable
from typing import TYPE_CHECKING, Any
from urllib.parse import parse_qs, urlparse
from zoneinfo import ZoneInfo

from . import knowledge

if TYPE_CHECKING:  # pragma: no cover
    from .context import AgentContext
    from .knowledge import KnowledgeDoc

RESOURCES, CACHE, OLD_COPY, GUIDANCE, PRECEDENTS = "Resources", "Knowledge cache (bot)", "Knowledge", "Guidance", "Learned precedents"
TABS = [RESOURCES, CACHE, OLD_COPY, GUIDANCE, PRECEDENTS]
RESOURCES_HEADER = ("Name", "Link", "What it covers")
ACTIONS = ("add", "update", "unchanged", "skip")
_DOC_HOSTS = re.compile(r"(?i)^https?://(docs|drive|sheets|slides)\.google\.com/")


@dataclass
class Copy:
    """The bot's copy of one document's text, from one tab of the sheet."""

    link: str
    text: str
    tab: str
    name: str = ""
    read_at: datetime | None = None
    label: str = ""
    complete: bool = True  # no part of the text is missing


@dataclass
class Row:
    """One row of the Resources tab."""

    row: int
    name: str
    link: str
    covers: str
    burson: bool
    bot_status: str


@dataclass
class Item:
    """One thing the import would do. `text` (never sent to the page) is what the document's text becomes; None keeps
    the text it has."""

    action: str  # add | update | unchanged | skip
    title: str
    row: int | None = None  # its row on the sheet's tab
    link: str = ""
    key: str = ""  # what makes it the same document next time (KnowledgeDoc.import_key)
    covers: str = ""
    external_ok: bool = False
    kind: str = "document"
    source_type: str = "drive"
    chars: int = 0
    doc_id: str = ""  # the Console document it updates (or made)
    reason: str = ""  # plain words: what happens and why
    changes: list[str] = field(default_factory=list)
    copy: str = ""  # where its text comes from
    text: str | None = None
    html: str | None = None
    file_name: str | None = None
    text_from: str = ""
    note: str | None = None  # the status line the document gets (None keeps its own)
    imported_from: str | None = "sheet"
    enabled: bool | None = None  # None leaves it as it is

    def public(self) -> dict[str, Any]:
        out = asdict(self)
        for name in ("text", "html", "text_from", "note", "imported_from", "enabled", "key"):
            out.pop(name, None)
        return out


@dataclass
class Plan:
    items: list[Item] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)

    def counts(self) -> dict[str, int]:
        return {a: sum(1 for i in self.items if i.action == a) for a in ACTIONS}


# -- reading the sheet's rows (pure) --------------------------------------------------------------------------------
def _cell(row: list[Any], i: int) -> str:
    value = row[i] if i < len(row) else ""
    return "" if value is None else str(value).strip()


def _yes(value: Any) -> bool:
    """A Yes in "Burson can see it?", as the chat bot reads it (Yes, Y, TRUE, a tick, a ticked box)."""
    return value is True or bool(re.fullmatch(r"\s*(yes|y|true|✓|✔)\s*", "" if value is None else str(value), re.I))


def _digest(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def link_key(link: str) -> str:
    """What makes two links the same document: a Docs, Sheets, Slides or Drive file by its id (with the Sheet's tab or the
    Doc's tab when the link names one), any other page without its scheme, www., #fragment or trailing slash."""
    link = (link or "").strip()
    if not link:
        return ""
    file_id, gid = knowledge.drive_file_id(link)
    if file_id and _DOC_HOSTS.match(link):
        tab = (parse_qs(urlparse(link).query).get("tab") or [""])[0]
        return f"drive:{file_id}" + (f"#gid={gid}" if gid else "") + (f"?tab={tab}" if tab and tab != "t.0" else "")
    parsed = urlparse(link if "://" in link else f"https://{link}")
    host = (parsed.hostname or "").lower().removeprefix("www.")
    return f"{host}{parsed.path.rstrip('/')}" + (f"?{parsed.query}" if parsed.query else "")


def resource_rows(values: list[list[Any]], links: list[str] | None = None) -> list[Row]:
    """The Resources tab's rows with a name or a link (row 1 is the header). The link is the cell's text when that is a
    link, else the link on the cell (Sheets shows a pasted link as the document's title): `links`, one a row."""
    rows = []
    for i, r in enumerate(values[1:], start=2):
        text = _cell(r, 1)
        link = text if re.match(r"(?i)^https?://", text) else ((links[i - 1] if links and i - 1 < len(links) else "") or text)
        name, covers = re.sub(r"\s+", " ", _cell(r, 0)), _cell(r, 2)
        if name or link:
            rows.append(Row(row=i, name=name, link=link.strip(), covers=covers, burson=_yes(r[3] if len(r) > 3 else ""),
                            bot_status=_cell(r, 4)))
    return rows


def _read_at(value: Any) -> datetime | None:
    try:
        ms = float(value)
    except (TypeError, ValueError):
        return None
    return datetime.fromtimestamp(ms / 1000, UTC) if ms > 0 else None


def copies(values: list[list[Any]], tab: str) -> dict[str, Copy]:
    """The documents' text a Knowledge-shaped tab keeps, by link: only copies the bot read (status ok) and whose
    part 0 names the same link, as the bot itself reads its tab."""
    found: dict[str, dict[str, Any]] = {}
    for r in values[1:]:
        link = _cell(r, 0)
        try:
            part = int(float(r[1])) if len(r) > 1 and str(r[1]).strip() != "" else -1
        except (TypeError, ValueError):
            continue
        if not link or part < 0:
            continue
        entry = found.setdefault(link, {"meta": None, "parts": {}})
        cell = r[2] if len(r) > 2 and r[2] is not None else ""
        if part == 0:
            try:
                entry["meta"] = json.loads(str(cell).lstrip("'"))
            except ValueError:
                entry["meta"] = None
        else:
            entry["parts"][part] = str(cell)
    out: dict[str, Copy] = {}
    for link, entry in found.items():
        meta, parts = entry["meta"], entry["parts"]
        if not isinstance(meta, dict) or str(meta.get("url") or "") != link or meta.get("status") != "ok" or not parts:
            continue
        last = max(parts)
        text = "".join(parts.get(i, "") for i in range(1, last + 1))
        if text.strip():
            out[link] = Copy(link=link, text=text, tab=tab, name=str(meta.get("name") or meta.get("title") or ""),
                             read_at=_read_at(meta.get("read_at")), label=str(meta.get("label") or ""),
                             complete=len(parts) == last)
    return out


def _pick(found: list[Copy]) -> Copy | None:
    """The freshest complete copy (else the freshest); the bot's own cache tab when two were read at the same time."""
    floor = datetime.min.replace(tzinfo=UTC)
    return max(found, key=lambda c: (c.complete, c.read_at or floor, c.tab == CACHE)) if found else None


def _when(at: datetime | None, tz: str) -> str:
    if at is None:
        return ""
    try:
        local = at.astimezone(ZoneInfo(tz))
    except Exception:  # noqa: BLE001 - an unknown zone: shown in UTC
        local = at
    return f"{local:%b} {local.day}, {local.strftime('%I:%M %p').lstrip('0')} {local.tzname() or ''}".strip()


def _guidance_day(value: Any) -> str:
    """An Until cell ("2026-10-25", "10/25/2026") as 2026-10-25, or '' (the chat bot's guidanceDay_)."""
    s = "" if value is None else str(value).strip()
    m = re.match(r"^(\d{4})-(\d{1,2})-(\d{1,2})", s)
    if m:
        return f"{m[1]}-{int(m[2]):02d}-{int(m[3]):02d}"
    m = re.match(r"^(\d{1,2})/(\d{1,2})/(\d{2}|\d{4})\b", s)
    if m:
        return f"{'20' + m[3] if len(m[3]) == 2 else m[3]}-{int(m[1]):02d}-{int(m[2]):02d}"
    return ""


# -- the plan (pure) ------------------------------------------------------------------------------------------------
def _match(key: str, existing: list[KnowledgeDoc]) -> KnowledgeDoc | None:
    """The Console document this one is the same as: the one this import made for it, else one with the same link."""
    for doc in existing:
        if key and doc.import_key == key:
            return doc
    same = [d for d in existing if key and link_key(d.link) == key]
    return next((d for d in same if d.imported_from == "sheet"), same[0] if same else None)


def _copy_note(r: Row, c: Copy, kept: int, tz: str) -> tuple[str, str]:
    """(the status line the document shows, where its text came from)."""
    when = _when(c.read_at, tz)
    read = f" (the chat bot read it {when})" if when else ""
    text_from = f"the copy brought over from the sheet{read}"
    said = re.sub(r"^\s*[✓✗]\s*", "", r.bot_status) if c.tab == CACHE else c.label  # the bot's own words on what it read
    said = re.sub(r"^Read [^·]*·\s*", "", said).strip()
    note = f"Brought over from the sheet{read}" + (f". {said}" if said else "")
    if len(c.text) > kept:
        note += f". Only the first {kept:,} characters are kept (Settings, Knowledge)"
    if not c.complete:
        note += ". Part of the sheet's copy is missing"
    return note + ".", text_from


def _doc_item(r: Row, c: Copy | None, match: KnowledgeDoc | None, *, kept: int, tz: str) -> Item:
    key = link_key(r.link)
    title = (r.name or (c.name if c else "") or r.link).strip()[:200]
    text = c.text[:kept] if c else None
    note, text_from = _copy_note(r, c, kept, tz) if c else (None, "")
    where = f"{len(text or ''):,} characters from the sheet's {c.tab} tab" if c else ""
    item = Item("add", title=title, row=r.row, link=r.link, key=key, covers=r.covers.strip()[:1000], external_ok=r.burson,
                source_type="drive" if _DOC_HOSTS.match(r.link) else "url", chars=len(text or ""), copy=where)
    if match is None:
        if c is None:
            item.note = ("Not read yet: the sheet had no copy of its text. The Console reads it from the link once its account "
                         "can open the file.")
            item.reason = ("Link only: the sheet has no copy of its text (the chat bot couldn't read it). The Console reads it "
                           "from the link once its account can open the file.")
        else:
            item.text, item.text_from, item.note, item.reason = text, text_from, note, f"New: {where}."
        return item
    item.action, item.doc_id, item.kind = "unchanged", match.doc_id, match.kind
    left: list[str] = []
    if match.imported_from == "sheet":  # made by this import: it follows the sheet
        if item.title != match.title:
            item.changes.append("name")
        if item.covers != match.covers:
            item.changes.append("what it covers")
        if item.external_ok != match.external_ok:
            item.changes.append("Burson may see it" if item.external_ok else "Burson no longer sees it")
        if item.link != match.link:
            item.changes.append("link")
    else:  # made by a person in the Console: only what it lacks is filled in
        item.imported_from = None
        item.title, item.link, item.source_type, item.external_ok = match.title, match.link, match.source_type, match.external_ok
        if match.covers:
            item.covers = match.covers
        elif item.covers:
            item.changes.append("what it covers")
        if r.burson != match.external_ok:
            left.append(f"the sheet says Burson {'can' if r.burson else 'can not'} see it; the Console's setting is kept")
    read_here = match.source_type != "text" and match.status == "ready" and match.chars > 0 and not match.text_from
    written_here = match.source_type == "text" and match.chars > 0
    if c is not None and read_here:
        left.append("the Console reads this document itself, so its own copy of the text is kept")
    elif c is not None and written_here:
        left.append("its text was written in the Console and is kept")
    elif c is not None and text is not None and _digest(text) != match.content_hash:
        item.changes.append("text")
        item.text, item.text_from, item.note = text, text_from, note
    if item.changes:
        item.action, item.reason = "update", "Updates its " + ", ".join(item.changes) + "."
    else:
        item.reason = "Already the same in the Console."
    if left:
        item.reason += " Left as it is: " + "; ".join(left) + "."
    return item


def guidance_items(values: list[list[Any]], existing: list[KnowledgeDoc], today: date) -> list[Item]:
    """Each Guidance row still in force as a guidance document (guidance outranks documents). A row whose Until date has
    passed is left out, and a guidance document this import made for it is turned off."""
    items = []
    for i, r in enumerate(values[1:], start=2):
        text = _cell(r, 0)
        if not text:
            continue
        applies, until = _cell(r, 1), _cell(r, 2)
        day = _guidance_day(r[2] if len(r) > 2 else "")
        title = "Guidance: " + (text if len(text) <= 80 else text[:77].rstrip() + "…")
        key = "guidance:" + _digest(re.sub(r"\s+", " ", text).strip().lower())[:16]
        match = next((d for d in existing if d.import_key == key), None)
        base = {"title": title, "row": i, "key": key, "kind": "guidance", "source_type": "text"}
        if day and day < today.isoformat():
            if match is not None and match.enabled:
                items.append(Item("update", **base, doc_id=match.doc_id, enabled=False, changes=["turned off"],
                                  reason=f"Turns it off: its Until date ({day}) has passed."))
            else:
                items.append(Item("skip", **base, doc_id=match.doc_id if match else "", reason=f"Its Until date ({day}) has passed."))
            continue
        body = text + (f"\n\nApplies to: {applies}" if applies else "") + (f"\nUntil: {day or until}" if (day or until) else "")
        if match is None:
            items.append(Item("add", **base, chars=len(body), text=body, note="Brought over from the sheet's Guidance tab.",
                              reason="New guidance (it outranks documents).", copy="the sheet's Guidance tab"))
        elif _digest(body) != match.content_hash:
            items.append(Item("update", **base, chars=len(body), doc_id=match.doc_id, text=body, changes=["text"],
                              reason="Updates its text.", copy="the sheet's Guidance tab"))
        else:
            items.append(Item("unchanged", **base, chars=len(body), doc_id=match.doc_id, reason="Already the same in the Console."))
    return items


def precedents_note(values: list[list[Any]]) -> str:
    rows = [r for r in values[1:] if any(_cell(r, j) for j in range(min(len(r), 9)))]
    if not rows:
        return ""
    used = sum(1 for r in rows if _cell(r, 9).lower() not in ("no", "n", "false"))
    return (f"Learned precedents: the sheet's {len(rows)} rows ({used} in use by the chat bot) are not brought over. The Console has "
            "no store for them: it learns from its own cases instead (similar past alerts with the IMs' reviews, and the Golden set).")


def plan(tabs: dict[str, list[list[Any]]], existing: list[KnowledgeDoc], *, max_doc_chars: int, tz: str = "America/New_York",
         today: date | None = None, links: list[str] | None = None) -> Plan:
    """What bringing the sheet's knowledge over would do: an item for every Resources row, every left-over copy of a
    document no longer listed, and every Guidance row, plus notes on what is not brought over."""
    out = Plan()
    today = today or datetime.now(UTC).date()
    res = tabs.get(RESOURCES)
    if res is None:
        out.notes.append("The sheet has no Resources tab, so there are no documents to bring over.")
    elif not res or tuple(_cell(res[0], i) for i in range(3)) != RESOURCES_HEADER:
        out.notes.append("The Resources tab's first row is not the chat bot's (Name, Link, What it covers): nothing was read from it.")
    else:
        cache, old = copies(tabs.get(CACHE) or [], CACHE), copies(tabs.get(OLD_COPY) or [], OLD_COPY)
        by_key: dict[str, list[Copy]] = {}
        for c in [*cache.values(), *old.values()]:
            by_key.setdefault(link_key(c.link), []).append(c)
        seen: dict[str, int] = {}
        for r in resource_rows(res, links):
            if not r.link:
                out.items.append(Item("skip", title=r.name, row=r.row, reason="It has no link in column B of the Resources tab."))
                continue
            key = link_key(r.link)
            if key in seen:
                out.items.append(Item("skip", title=r.name or r.link, row=r.row, link=r.link,
                                      reason=f"The same document as row {seen[key]}, which is brought over."))
                continue
            seen[key] = r.row
            exact = [c for c in (cache.get(r.link), old.get(r.link)) if c]
            out.items.append(_doc_item(r, _pick(exact or by_key.get(key, [])), _match(key, existing), kept=max_doc_chars, tz=tz))
        gone: set[str] = set()
        for key, found in by_key.items():
            if key in seen or key in gone:
                continue
            gone.add(key)
            c = _pick(found) or found[0]
            out.items.append(Item("skip", title=c.name or c.link, link=c.link, copy=f"the sheet's {c.tab} tab",
                                  reason=f"Only an old copy is left in the sheet's hidden {c.tab} tab: it is no longer on the Resources tab."))
    if tabs.get(GUIDANCE):
        rules = guidance_items(tabs[GUIDANCE], existing, today)
        out.items += rules
        if not rules:
            out.notes.append("Guidance: the sheet's Guidance tab has no rows, so there is no guidance to bring over.")
    note = precedents_note(tabs.get(PRECEDENTS) or [])
    if note:
        out.notes.append(note)
    return out


# -- files in a folder ----------------------------------------------------------------------------------------------
def _plain_text(data: bytes) -> bool:
    head = data[:8192]
    if b"\x00" in head:
        return False
    try:
        head.decode("utf-8")
    except UnicodeDecodeError as exc:
        return exc.start > len(head) - 4  # only a character cut at the end of the sample
    return True


def folder_items(paths: list[Path], existing: list[KnowledgeDoc], *, max_doc_chars: int, max_upload_mb: int) -> list[Item]:
    """Files (or every file in a folder) as documents written in the Console, as an upload makes them: Word, PDF, web
    pages, Markdown and text, and text files without an ending. The same file name again updates its document."""
    from . import docfiles

    items: list[Item] = []
    files: list[Path] = []
    for p in paths:
        if p.is_dir():
            files += sorted(f for f in p.iterdir() if f.is_file() and not f.name.startswith("."))
        elif p.is_file():
            files.append(p)
        else:
            items.append(Item("skip", title=p.name, source_type="text", imported_from="folder", reason="There is no such file or folder."))
    for f in files:
        base = {"title": f.name, "source_type": "text", "imported_from": "folder", "file_name": f.name, "key": f"file:{f.name}"}
        data = f.read_bytes()
        if len(data) > max_upload_mb * 1024 * 1024:
            items.append(Item("skip", **base, reason=f"It is larger than {max_upload_mb} MB."))
            continue
        upload = f.name
        if f.suffix.lower() not in docfiles.TYPES:
            if f.suffix or not _plain_text(data):
                items.append(Item("skip", **base, reason="Not a file the Console can read: Word, PDF, a web page, Markdown or text."))
                continue
            upload = f.name + ".txt"
        try:
            title, html = docfiles.from_upload(upload, data)
        except ValueError as exc:
            items.append(Item("skip", **base, reason=str(exc)))
            continue
        text = docfiles.to_text(docfiles.clean_html(html)[:max_doc_chars])[:max_doc_chars]
        match = next((d for d in existing if d.import_key == base["key"]), None) or next(
            (d for d in existing if d.source_type == "text" and d.file_name == f.name), None)
        item = Item("add", **{**base, "title": title}, chars=len(text), html=html, copy=f"the file {f.name}",
                    note=f"Brought over from the file {f.name}.", reason=f"New: {len(text):,} characters from {f.name}.")
        if match is not None:
            item.doc_id, item.title, item.kind, item.external_ok, item.covers = match.doc_id, match.title, match.kind, match.external_ok, match.covers
            if match.imported_from != "folder":
                item.imported_from = None
            if _digest(text) == match.content_hash:
                item.action, item.html, item.note, item.reason = "unchanged", None, None, "Already the same in the Console."
            else:
                item.action, item.changes, item.reason = "update", ["text"], f"Updates its text from {f.name}."
        items.append(item)
    return items


# -- applying it ----------------------------------------------------------------------------------------------------
def apply(ctx: AgentContext, items: list[Item], *, actor: str, surface: str = "console",
          budget_chars: int | None = None) -> tuple[list[dict[str, Any]], int]:
    """Does what the plan's add and update items say. With `budget_chars`, stops starting new documents once about that
    much text was stored (always at least one), so a page can bring a big sheet over in a few steps: run it again and
    what was done is already the same. Returns (what was done, how many are left for the next run)."""
    done: list[dict[str, Any]] = []
    remaining, used = 0, 0
    for it in items:
        if it.action not in ("add", "update"):
            continue
        size = max(len(it.text or it.html or ""), 1)
        if budget_chars and done and used + size > budget_chars:
            remaining += 1
            continue
        doc = knowledge.import_doc(ctx, actor=actor, title=it.title, doc_id=it.doc_id or None, source_type=it.source_type,  # type: ignore[arg-type]
                                   link=it.link, covers=it.covers, kind=it.kind, external_ok=it.external_ok, text=it.text,
                                   html=it.html, file_name=it.file_name, imported_from=it.imported_from, import_key=it.key,
                                   text_from=it.text_from, note=it.note, enabled=it.enabled, surface=surface)
        it.doc_id = doc.doc_id
        used += size
        done.append({"title": doc.title, "doc_id": doc.doc_id, "action": it.action, "status": doc.status})
    return done, remaining


def run(ctx: AgentContext, *, actor: str, dry_run: bool = True, budget_chars: int | None = None, surface: str = "console",
        reader: Callable[..., tuple[dict[str, list[list[Any]]], dict[str, Any]]] | None = None) -> dict[str, Any]:
    """Read the sheet (as the Console's own account), plan, and unless `dry_run` apply. Raises sheet_read.SheetUnreadable
    with what to share with whom when the sheet can't be read."""
    from . import sheet_read

    values, meta = (reader or sheet_read.read_tabs)(TABS, link_columns={RESOURCES: 1})
    cfg = ctx.config.platform.knowledge
    tz = ctx.config.timezone
    try:
        today = ctx.now().astimezone(ZoneInfo(tz)).date()
    except Exception:  # noqa: BLE001 - an unknown zone: today in UTC
        today = ctx.now().date()
    the_plan = plan(values, knowledge.list_docs(ctx), max_doc_chars=cfg.max_doc_chars, tz=tz, today=today,
                    links=(meta.get("links") or {}).get(RESOURCES))
    for tab in meta.get("missing") or []:
        if tab in (CACHE, OLD_COPY):
            continue  # either copy may be missing: the other one is used
        if tab != RESOURCES:
            the_plan.notes.append(f"The sheet has no {tab} tab.")
    applied, remaining = ([], 0) if dry_run else apply(ctx, the_plan.items, actor=actor, surface=surface, budget_chars=budget_chars)
    return {"dry_run": dry_run, "sheet": {"id": meta.get("sheet_id", ""), "title": meta.get("title", ""), "read_as": meta.get("read_as", "")},
            "counts": the_plan.counts(), "items": [i.public() for i in the_plan.items], "notes": the_plan.notes,
            "applied": applied, "remaining": remaining}
