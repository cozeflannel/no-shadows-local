"""Reading the sheet-based chat bot's control sheet, read-only, with the Console's own Google account.

Used to bring the chat bot's knowledge documents (the Resources tab and the copies of their text the bot keeps) and its
signals (the Watches tab) over to the Console. Nothing is ever written to the sheet: the only scope asked for is
spreadsheets.readonly. The sheet is STORE_SHEET_ID (env SLRR_STORE_SHEET_ID, else the live control sheet).

When the Console's account can't open the sheet, SheetUnreadable says which account to share the sheet with.
"""

from __future__ import annotations

import os
import re
from typing import Any
from urllib.parse import quote

SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly"
API = "https://sheets.googleapis.com/v4/spreadsheets/"


class SheetUnreadable(RuntimeError):
    """The control sheet could not be read; the message says what to do."""


def sheet_id() -> str:
    from .brand_safety_groups import DEFAULT_STORE_SHEET_ID

    return (os.environ.get("SLRR_STORE_SHEET_ID") or DEFAULT_STORE_SHEET_ID).strip()


def _quota_project() -> str:
    return (os.environ.get("TRIAGE_PROJECT_ID") or os.environ.get("GOOGLE_CLOUD_PROJECT") or "brand-social-central-data").strip()


def _session() -> tuple[Any, str]:
    """(an authorised requests session, the address it reads as: '' when that is a person's own sign-in)."""
    import google.auth
    from google.auth.transport.requests import AuthorizedSession, Request

    try:
        creds, _ = google.auth.default(scopes=[SCOPE])
        creds.refresh(Request())
    except Exception as exc:  # no credentials at all: said plainly
        raise SheetUnreadable(f"The Console has no Google credentials to read the sheet with: {exc}") from exc
    who = str(getattr(creds, "service_account_email", "") or "")
    session = AuthorizedSession(creds)
    if "@" not in who:  # a person's own sign-in (local ADC): Sheets bills the reads to the project named here
        session.headers["x-goog-user-project"] = _quota_project()
    return session, who if "@" in who else ""


def _check(resp: Any, who: str) -> None:
    if resp.status_code in (401, 403, 404):
        name = who or "the Google account the Console runs as"
        raise SheetUnreadable(f"The Console can't open the control sheet as {name}. Share the sheet with {name} "
                              "(Viewer is enough), then try again.")
    if resp.status_code >= 400:
        raise SheetUnreadable(f"Google Sheets answered {resp.status_code} reading the control sheet: {resp.text[:200]}")


def _range(tab: str, cells: str = "") -> str:
    return "'" + tab.replace("'", "''") + "'" + (f"!{cells}" if cells else "")


def _is_link(value: Any) -> bool:
    return bool(re.match(r"(?i)^https?://", str(value or "").strip()))


def read_tabs(tabs: list[str], *, sheet: str | None = None,
              link_columns: dict[str, int] | None = None) -> tuple[dict[str, list[list[Any]]], dict[str, Any]]:
    """The cells of `tabs` the sheet has (numbers as numbers, ticked boxes as True), and what was read:
    {sheet_id, title, read_as, missing: [tabs it doesn't have], links: {tab: [link per row]}}.

    link_columns {tab: 0-based column}: where a cell there shows text rather than a link (Sheets shows a pasted link as
    the document's title), the link on the cell is read too, in links[tab] (index 0 is the header row)."""
    import requests

    sid = sheet or sheet_id()
    session, who = _session()
    present: list[str] = []
    values: dict[str, list[list[Any]]] = {}
    links: dict[str, list[str]] = {}
    book: dict[str, Any] = {}
    try:
        meta = session.get(API + quote(sid), params={"fields": "properties.title,sheets.properties(title,sheetId)"}, timeout=30)
        _check(meta, who)
        book = meta.json()
        titles = {str(s.get("properties", {}).get("title", "")) for s in book.get("sheets", [])}
        present = [t for t in tabs if t in titles]
        if present:
            params = [("ranges", _range(t)) for t in present] + [("valueRenderOption", "UNFORMATTED_VALUE"),
                                                                  ("dateTimeRenderOption", "FORMATTED_STRING")]
            resp = session.get(API + quote(sid) + "/values:batchGet", params=params, timeout=180)
            _check(resp, who)
            for tab, block in zip(present, resp.json().get("valueRanges", []), strict=False):
                values[tab] = block.get("values", []) or []
        for tab, col in (link_columns or {}).items():
            rows = values.get(tab) or []
            if not any(len(r) > col and str(r[col] or "").strip() and not _is_link(r[col]) for r in rows[1:]):
                continue  # every link is written out: nothing more to read
            letter = chr(ord("A") + col)
            fields = "sheets(data(rowData(values(hyperlink,chipRuns(chip(richLinkProperties(uri)))))))"
            got = session.get(API + quote(sid), params={"ranges": _range(tab, f"{letter}1:{letter}"), "fields": fields}, timeout=60)
            _check(got, who)
            found: list[str] = []
            for data in (got.json().get("sheets") or [{}])[0].get("data", []) or []:
                for row in data.get("rowData", []) or []:
                    cell = (row.get("values") or [{}])[0]
                    chips = [run.get("chip", {}).get("richLinkProperties", {}).get("uri", "") for run in cell.get("chipRuns", []) or []]
                    found.append(str(cell.get("hyperlink") or next((c for c in chips if c), "") or ""))
            links[tab] = found
    except requests.RequestException as exc:
        raise SheetUnreadable(f"The control sheet could not be reached: {exc}") from exc
    return values, {"sheet_id": sid, "title": str(book.get("properties", {}).get("title", "")), "read_as": who,
                    "missing": [t for t in tabs if t not in present], "links": links}
