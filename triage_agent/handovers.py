"""The handover in the Console: one record per shift.

When a shift ends the scheduled job posts the handover to the team space, as before, and the same handover is kept
here: what was posted, and the notes people add to it. Opened on Workforce it also shows the shift read from the
event log (triage_agent/reports.py): its numbers, each alert with its timeline, and the incident reports that touch
it. A person can ask for the handover of the shift that last ended; a shift is handed over once.
"""

from __future__ import annotations

import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING, Any

from . import incidents, reports
from .events import EventType

if TYPE_CHECKING:  # pragma: no cover
    from .context import AgentContext

ROWS = "handovers"


def _id(name: str, end: datetime) -> str:
    return f"{end.astimezone(timezone.utc):%Y%m%dT%H%M}-{re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-')}"


def get(ctx: "AgentContext", handover_id: str) -> dict[str, Any] | None:
    return ctx.store.get_doc(ROWS, handover_id) if handover_id else None


def record(ctx: "AgentContext", name: str, start: datetime, end: datetime, text: str, *, by: str = "agent") -> dict[str, Any]:
    """Keep the handover of one shift. One per shift: a second call gives back the one there is."""
    doc = get(ctx, _id(name, end))
    if doc is None:
        doc = {"id": _id(name, end), "shift": name, "start": start.isoformat(), "end": end.isoformat(), "made_at": ctx.now().isoformat(),
               "made_by": by, "text": text, "notes": []}
        ctx.store.put_doc(ROWS, doc["id"], doc)
    return doc


def last_shift(ctx: "AgentContext") -> tuple[str, datetime, datetime]:
    """The shift that ended last. With no shifts set, the last six hours."""
    from .followups import _shift_windows

    now = ctx.now()
    over = [w for w in _shift_windows(ctx, now) if w[2] <= now]
    return max(over, key=lambda w: w[2]) if over else ("last 6 hours", now - timedelta(hours=6), now)


def make_now(ctx: "AgentContext", *, by: str) -> dict[str, Any]:
    """The handover of the shift that ended last, made and posted now unless it already was."""
    from . import followups

    name, start, end = last_shift(ctx)
    doc = get(ctx, _id(name, end))
    if doc is not None:
        return doc
    out = followups.build_handover(ctx, name, start, end)
    followups._send(ctx, out, "handover")
    ctx.store.put_kv(f"handover:{end.date().isoformat()}:{name}", {"at": ctx.now().isoformat()})  # the scheduled run finds it done
    ctx.emit(EventType.HANDOVER_POSTED, actor=by, payload={"shift": name, "start": start.isoformat(), "end": end.isoformat(), "on_demand": True})
    return record(ctx, name, start, end, out.team_text or out.handover_text, by=by)


def add_note(ctx: "AgentContext", handover_id: str, text: str, *, by: str) -> dict[str, Any]:
    doc = get(ctx, handover_id)
    if doc is None:
        raise KeyError(handover_id)
    text = (text or "").strip()
    if not text:
        raise ValueError("Write the note first.")
    if len(text) > incidents.NOTE_CHARS:
        raise ValueError(f"A note is at most {incidents.NOTE_CHARS:,} characters.")
    note = {"id": uuid.uuid4().hex[:12], "by": by, "at": ctx.now().isoformat(), "text": text}
    doc["notes"] = [*doc.get("notes", []), note]
    ctx.store.put_doc(ROWS, doc["id"], doc)
    return note


def between(ctx: "AgentContext", since: datetime, until: datetime) -> list[dict[str, Any]]:
    """The handovers whose shift touches a stretch of time, newest first, without their text."""
    out = [{k: d.get(k) for k in ("id", "shift", "start", "end", "made_at", "made_by")} | {"notes": len(d.get("notes", []))}
           for d in ctx.store.list_docs(ROWS, limit=2000)
           if datetime.fromisoformat(d["start"]) <= until and datetime.fromisoformat(d["end"]) >= since]
    return sorted(out, key=lambda d: d["end"], reverse=True)


def detail(ctx: "AgentContext", handover_id: str) -> dict[str, Any] | None:
    """A handover in full: what was posted, the notes, and the shift read from the event log."""
    doc = get(ctx, handover_id)
    if doc is None:
        return None
    start, end = datetime.fromisoformat(doc["start"]), datetime.fromisoformat(doc["end"])
    shift = reports.build(ctx, start, end, window="shift")
    return {**doc, "numbers": shift["totals"], "alerts": shift["alerts"], "cut": shift.get("cut"),
            "incidents": [{k: i[k] for k in ("id", "name", "status", "priority")} for i in incidents.between(ctx, start, end)]}
