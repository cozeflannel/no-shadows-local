"""The KOF list: who counts as a key opinion former.

The list is a Google Sheet (Settings, Agent alerts), read with the service's own account. An author is a KOF when a cell
of the sheet names their handle, by the sheet-based bot's rule (apps-script-chat-bot/Knowledge.gs,
knowledgeKofCellHit_): the whole cell ("@handle" or "handle"), "@handle" as a word inside it ("Jane Doe (@handle)"),
or a profile link (x.com/handle, tiktok.com/@handle, bsky.app/profile/handle, ...). Every author starts as not a KOF:
with no sheet set none is one, and when the sheet cannot be read the last list read is used.
"""

from __future__ import annotations

import hashlib
import re
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from ..context import AgentContext

STATE = "own:kof"   # {key, at, handles, parts, error}; the list itself is in STATE:0, STATE:1, ...
PART = 1500         # handles kept in one part
_HANDLE = r"([a-z0-9_][a-z0-9_.\-]{2,})"
_WHOLE = re.compile(r"@*" + _HANDLE)
_AT = re.compile(r"(?:^|[^\w.@])@" + _HANDLE)
_LINK = re.compile(r"(?:^|[^a-z0-9])(?:twitter|x|instagram|tiktok|youtube|threads|facebook|linkedin|bsky|reddit)\.[a-z.]+/"
                   r"(?:@|in/|profile/|user/|u/|c/|channel/)?" + _HANDLE)


class Unreadable(RuntimeError):
    """The KOF sheet could not be read."""


def _handle(value: Any) -> str:
    return str(value or "").strip().lower().lstrip("@").rstrip(".-")


def handles_in(cell: Any) -> set[str]:
    """Every handle one cell names (lowercase, no @, three characters or more)."""
    c = str(cell or "").strip().lower()
    if not c:
        return set()
    found = {_handle(m.group(1)) for rx in (_AT, _LINK) for m in rx.finditer(c)}
    if not found and "/" not in c and ":" not in c:
        whole = _WHOLE.fullmatch(c)
        if whole:
            found.add(_handle(whole.group(1)))
    return {h for h in found if len(h) >= 3}


def build(tabs: list[tuple[str, list[list[Any]]]], own: Any) -> dict[str, dict[str, str]]:
    """handle -> {name, tier}: the name is the row's name cell (or its first filled cell), the tier is the tab it is on.
    The first filled row of a tab is its header."""
    handle_columns = {h.strip().lower() for h in own.kof_handle_columns if h.strip()}
    name_column = own.kof_name_column.strip().lower()
    index: dict[str, dict[str, str]] = {}
    for title, rows in tabs:
        header: list[str] | None = None
        for row in rows:
            cells = [str(c if c is not None else "").strip() for c in row]
            if not any(cells):
                continue
            if header is None:
                header = [c.lower() for c in cells]
                continue
            name = ""
            if name_column and name_column in header and header.index(name_column) < len(cells):
                name = cells[header.index(name_column)]
            name = name or next((c for c in cells if c), "")
            for i, cell in enumerate(cells):
                if handle_columns and (i >= len(header) or header[i] not in handle_columns):
                    continue
                for handle in handles_in(cell):
                    index.setdefault(handle, {"name": name[:120], "tier": str(title)[:80]})
    return index


def match(index: dict[str, dict[str, str]], author: Any) -> dict[str, str] | None:
    handle = _handle(author)
    return index.get(handle) if handle else None


def label(entry: dict[str, str], author: Any) -> str:
    """How a KOF is shown on an alert: "Name (@handle)"."""
    handle = _handle(author)
    name = entry.get("name") or ""
    return name if f"@{handle}" in name.lower() else f"{name} (@{handle})".strip()


def read_sheet(link: str) -> list[tuple[str, list[list[Any]]]]:
    """Every tab of the sheet (or the one tab the link names) as (title, rows), read as the service's own account."""
    import google.auth
    from googleapiclient.discovery import build as discover
    from googleapiclient.errors import HttpError

    from ..knowledge import drive_file_id

    file_id, gid = drive_file_id(link)
    if not file_id:
        raise Unreadable("The KOF sheet's link doesn't look like a Google Sheets link.")
    creds, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/spreadsheets.readonly"])
    sheets = discover("sheets", "v4", credentials=creds, cache_discovery=False)
    try:
        book = sheets.spreadsheets().get(spreadsheetId=file_id, fields="sheets.properties").execute()
        tabs = [s["properties"] for s in book.get("sheets", [])]
        if gid is not None:
            tabs = [t for t in tabs if str(t.get("sheetId")) == gid]
            if not tabs:
                raise Unreadable("The KOF sheet's link names a tab that is no longer in the spreadsheet.")
        out = []
        for tab in tabs:
            quoted = str(tab["title"]).replace("'", "''")
            values = sheets.spreadsheets().values().get(spreadsheetId=file_id, range=f"'{quoted}'").execute().get("values", [])
            out.append((str(tab["title"]), values))
        return out
    except HttpError as exc:
        if exc.resp.status in (403, 404):
            email = str(getattr(creds, "service_account_email", "") or "")
            who = email if "@" in email else "the service's account"
            raise Unreadable(f"Share the KOF sheet with {who} (Viewer is enough). It cannot open the sheet.") from exc
        raise Unreadable(f"Google Sheets answered {exc.resp.status} reading the KOF sheet.") from exc


def _key(own: Any) -> str:
    return hashlib.sha256(repr((own.kof_sheet.strip(), sorted(own.kof_handle_columns), own.kof_name_column)).encode()).hexdigest()[:16]


def _load(ctx: "AgentContext", state: dict[str, Any]) -> dict[str, dict[str, str]]:
    index: dict[str, dict[str, str]] = {}
    for n in range(int(state.get("parts") or 0)):
        for handle, (name, tier) in ((ctx.store.get_kv(f"{STATE}:{n}") or {}).get("handles") or {}).items():
            index[handle] = {"name": name, "tier": tier}
    return index


def _save(ctx: "AgentContext", index: dict[str, dict[str, str]], key: str, now: datetime) -> None:
    items = sorted(index.items())
    parts = [items[i:i + PART] for i in range(0, len(items), PART)]
    for n, part in enumerate(parts):
        ctx.store.put_kv(f"{STATE}:{n}", {"handles": {h: [e["name"], e["tier"]] for h, e in part}})
    ctx.store.put_kv(STATE, {"key": key, "at": now.isoformat(), "handles": len(items), "parts": len(parts), "error": ""})


def lookup(ctx: "AgentContext") -> dict[str, dict[str, str]]:
    """The list as handle -> {name, tier}. Read again when it is due or its settings changed; {} with no sheet set."""
    own = ctx.config.platform.own_alerts
    if not own.kof_sheet.strip():
        return {}
    state = ctx.store.get_kv(STATE) or {}
    key, now = _key(own), ctx.now()
    same = state.get("key") == key
    if same and state.get("at") and now - datetime.fromisoformat(state["at"]) < timedelta(minutes=own.kof_refresh_minutes):
        return _load(ctx, state)
    try:
        index = build(read_sheet(own.kof_sheet.strip()), own)
    except Exception as exc:  # noqa: BLE001 - the last list read stays in use, and the reason is shown
        kept = state if same else {"key": key, "at": "", "handles": 0, "parts": 0}
        ctx.store.put_kv(STATE, {**kept, "error": str(exc)[:300]})
        return _load(ctx, kept)
    _save(ctx, index, key, now)
    return index


def status(ctx: "AgentContext") -> dict[str, Any]:
    state = ctx.store.get_kv(STATE) or {}
    return {"set": bool(ctx.config.platform.own_alerts.kof_sheet.strip()), "handles": int(state.get("handles") or 0),
            "error": str(state.get("error") or ""), "at": str(state.get("at") or "")}
