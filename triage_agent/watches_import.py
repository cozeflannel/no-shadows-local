"""Bringing the sheet-based chat bot's signals (its Watches tab) over to the Console's signals (watches.py).

The Watches tab: Watch · On · What to look for (a yes/no question for Gemini) · How to score impact (1-10) ·
Topics (comma-separated) · Flag at score · Networks (blank: all) · Status (written by the bot). Each named row becomes a
signal with the same question, rubric, topics, bar and networks, read the way the bot reads its rows
(ProactiveWatch.gs pwWatchFrom_): a blank rubric or topics take the sheet's defaults, a bar outside 1-10 is the default
bar, each name once. Every signal comes over OFF, whatever the sheet says: the preview shows which ones were ON there,
and only a person turns one on in the Console.

Bringing them over again updates instead of duplicating: a row is the same as the Console's signal of the same name. A
signal's on/off is never changed by it, and no signal is ever deleted.
"""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from collections.abc import Callable
from typing import TYPE_CHECKING, Any

from . import watches

if TYPE_CHECKING:  # pragma: no cover
    from .context import AgentContext

TAB = "Watches"
HEADER = ("Watch", "On", "What to look for (a yes/no question for Gemini)")


@dataclass
class SheetWatch:
    row: int
    name: str
    on: bool
    question: str
    rubric: str
    topics: list[str]
    flag_at_score: float | None
    networks: list[str]
    status: str


@dataclass
class Item:
    action: str  # add | update | unchanged | skip
    name: str
    row: int | None = None
    on_in_sheet: bool = False
    sheet_status: str = ""
    watch_id: str = ""
    enabled: bool = False  # what it is in the Console after this (always OFF when new)
    reason: str = ""
    changes: list[str] = field(default_factory=list)
    data: dict[str, Any] = field(default_factory=dict)

    def public(self) -> dict[str, Any]:
        out = asdict(self)
        out.pop("data", None)
        return out


def _cell(row: list[Any], i: int) -> str:
    value = row[i] if i < len(row) else ""
    return "" if value is None else str(value).strip()


def sheet_watches(values: list[list[Any]]) -> tuple[list[SheetWatch], str]:
    """The tab's rows with a name, read as the bot reads them; and a note when the tab isn't the bot's."""
    if not values or tuple(_cell(values[0], i) for i in range(3)) != HEADER:
        return [], "The Watches tab's first row is not the chat bot's (Watch, On, What to look for…): nothing was read from it."
    out = []
    for i, r in enumerate(values[1:], start=2):
        name = re.sub(r"\s+", " ", _cell(r, 0))[:80]
        if not name:
            continue
        raw_topics = [watches.clean_topic(t) for t in re.split(r"[,;\n]+", _cell(r, 4))] if _cell(r, 4) else list(watches.SHEET_DEFAULT_TOPICS)
        topics: list[str] = []
        for t in raw_topics:  # each topic once, never "Other" (the look adds it itself), at most 12, as on the sheet
            if t and t.lower() != "other" and t.lower() not in {x.lower() for x in topics}:
                topics.append(t)
        topics = topics[:12]
        try:
            bar = float(_cell(r, 5)) if _cell(r, 5) else None
        except ValueError:
            bar = None
        bar = round(bar, 1) if bar is not None and 1 <= bar <= 10 else None
        nets = [n for n in dict.fromkeys(watches.network_key(n) for n in re.split(r"[,;\n]+", _cell(r, 6))) if n]
        on = (r[1] is True) if len(r) > 1 and isinstance(r[1], bool) else _cell(r, 1).upper() == "ON"
        out.append(SheetWatch(row=i, name=name, on=on, question=_cell(r, 2)[:2000],
                              rubric=(_cell(r, 3) or watches.SHEET_DEFAULT_RUBRIC)[:2000], topics=topics, flag_at_score=bar,
                              networks=nets, status=_cell(r, 7)))
    return out, ""


def _norm(name: str) -> str:
    return re.sub(r"\s+", " ", name).strip().lower()


def plan(rows: list[SheetWatch], existing: list[watches.Watch]) -> list[Item]:
    """What bringing the rows over would do, one item a row."""
    by_name = {_norm(w.name): w for w in existing}
    seen: dict[str, int] = {}
    items = []
    for r in rows:
        key = _norm(r.name)
        item = Item("add", name=r.name, row=r.row, on_in_sheet=r.on, sheet_status=r.status)
        if key in seen:
            item.action, item.reason = "skip", f"The same name as row {seen[key]}: the sheet watches each name once."
            items.append(item)
            continue
        seen[key] = r.row
        if not r.question:
            item.action, item.reason = "skip", "Its question (What to look for) is empty on the sheet."
            items.append(item)
            continue
        data = {"name": r.name, "question": r.question, "rubric": r.rubric, "topics": r.topics, "flag_at_score": r.flag_at_score,
                "networks": r.networks}
        match = by_name.get(key)
        if match is None:
            item.data = {**data, "enabled": False, "imported_from": "sheet", "sheet_on": r.on}
            item.reason = "New signal, OFF." + (" It is ON on the sheet: turn it on here when you are ready." if r.on else "")
        else:
            item.watch_id, item.enabled = match.watch_id, match.enabled
            labels = {"question": "question", "rubric": "how to score", "topics": "topics", "flag_at_score": "flag at score",
                      "networks": "networks"}
            for field_name, label in labels.items():
                if getattr(match, field_name) != data[field_name]:
                    item.changes.append(label)
            if item.changes:
                item.action = "update"
                item.data = {**data, "watch_id": match.watch_id, "enabled": match.enabled, "sheet_on": r.on}
                item.reason = "Updates its " + ", ".join(item.changes) + f". It stays {'ON' if match.enabled else 'OFF'} here."
            else:
                item.action, item.reason = "unchanged", "Already the same in the Console."
        items.append(item)
    return items


def run(ctx: AgentContext, *, actor: str, dry_run: bool = True,
        reader: Callable[..., tuple[dict[str, list[list[Any]]], dict[str, Any]]] | None = None) -> dict[str, Any]:
    """Read the Watches tab (as the Console's own account), plan, and unless `dry_run` apply."""
    from . import sheet_read

    values, meta = (reader or sheet_read.read_tabs)([TAB])
    notes = []
    if TAB not in values:
        rows, note = [], "The sheet has no Watches tab, so there are no signals to bring over."
    else:
        rows, note = sheet_watches(values[TAB])
    if note:
        notes.append(note)
    items = plan(rows, watches.list_watches(ctx))
    applied = []
    if not dry_run:
        for it in items:
            if it.action in ("add", "update"):
                saved = watches.save_watch(ctx, actor, it.data)
                it.watch_id = saved.watch_id
                applied.append({"name": saved.name, "watch_id": saved.watch_id, "action": it.action})
    counts = {a: sum(1 for i in items if i.action == a) for a in ("add", "update", "unchanged", "skip")}
    return {"dry_run": dry_run, "sheet": {"id": meta.get("sheet_id", ""), "title": meta.get("title", ""), "read_as": meta.get("read_as", "")},
            "counts": counts, "items": [i.public() for i in items], "notes": notes, "applied": applied,
            "on_in_sheet": [i.name for i in items if i.on_in_sheet]}
