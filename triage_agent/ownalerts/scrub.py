"""Personal details are taken out of a post before it is kept or shown to a model.

Two passes, in this order: patterns (emails, links, @handles, phone numbers; BigQuery's `fast_regex_sanitize` is built
from the same four), then Google's Sensitive Data Protection (Cloud DLP), which also finds names. A post is kept only
when both ran: when DLP fails, cannot be reached or loses a row, nothing is handed back, so nothing is stored.
"""

from __future__ import annotations

import os
import re
from typing import TYPE_CHECKING, Any, Protocol

if TYPE_CHECKING:
    from ..context import AgentContext

# (name, pattern, what replaces it). Both Python's `re` and BigQuery's RE2 read these the same way; schema.py builds
# the SQL function from this list, in this order.
PATTERNS: tuple[tuple[str, str, str], ...] = (
    ("EMAIL", r"(?i)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", "[EMAIL]"),
    ("URL", r"(?:https?://|www\.)\S+", "[URL]"),
    ("HANDLE", r"(^|[^A-Za-z0-9_@])@[A-Za-z0-9_.-]+", r"\1[HANDLE]"),
    ("PHONE", r"(?:\+|\b)(?:\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b", "[PHONE]"),
)
_COMPILED = tuple((re.compile(pattern), put) for _, pattern, put in PATTERNS)
ROWS = 200        # posts in one DLP call
CHARS = 200_000   # ...and characters (the service takes half a megabyte a call)
SCOPE = "https://www.googleapis.com/auth/cloud-platform"


class Unavailable(RuntimeError):
    """Personal details could not be taken out, so nothing may be kept."""


def _cut(text: str, limit: int) -> str:
    """The first `limit` characters, without half a word at the end (half a name is harder to recognise)."""
    if len(text) <= limit:
        return text
    cut = text[:limit]
    if not text[limit].isspace() and not cut[-1].isspace() and " " in cut:
        cut = cut[:cut.rfind(" ")]
    return cut


def patterns(text: Any, limit: int) -> str:
    """The text with emails, links, @handles and phone numbers replaced by what they were, trimmed and cut."""
    out = str(text or "")
    for rx, put in _COMPILED:
        out = rx.sub(put, out)
    return _cut(out.strip(), limit).strip()


class Dlp(Protocol):
    def deidentify(self, texts: list[str], info_types: list[str]) -> list[str]: ...


class CloudDlp:
    """Google's Sensitive Data Protection, called as the service's own account."""

    def __init__(self, project: str, location: str, session: Any = None, timeout: float = 30.0):
        self.project, self.location, self.timeout = project, location, timeout
        self._session = session

    def _http(self) -> Any:
        if self._session is None:
            import google.auth
            from google.auth.transport.requests import AuthorizedSession

            creds, _ = google.auth.default(scopes=[SCOPE])
            self._session = AuthorizedSession(creds)
        return self._session

    def deidentify(self, texts: list[str], info_types: list[str]) -> list[str]:
        kinds = [{"name": name} for name in info_types]
        body = {
            "deidentifyConfig": {"infoTypeTransformations": {"transformations": [
                {"infoTypes": kinds, "primitiveTransformation": {"replaceWithInfoTypeConfig": {}}}]}},
            "inspectConfig": {"infoTypes": kinds},
            "item": {"table": {"headers": [{"name": "text"}], "rows": [{"values": [{"stringValue": t}]} for t in texts]}},
        }
        url = f"https://dlp.googleapis.com/v2/projects/{self.project}/locations/{self.location}/content:deidentify"
        try:
            reply = self._http().post(url, json=body, timeout=self.timeout)
        except Exception as exc:  # whatever stopped the call, nothing is kept
            raise Unavailable(f"Sensitive Data Protection could not be reached: {exc}") from exc
        if reply.status_code != 200:
            raise Unavailable(f"Sensitive Data Protection answered {reply.status_code}: {str(reply.text)[:300]}")
        rows = (((reply.json() or {}).get("item") or {}).get("table") or {}).get("rows") or []
        if len(rows) != len(texts):
            raise Unavailable(f"Sensitive Data Protection handed back {len(rows)} of {len(texts)} posts.")
        return [str(((r.get("values") or [{}])[0]).get("stringValue") or "") for r in rows]


def get_dlp(ctx: "AgentContext") -> Dlp:
    cfg = ctx.config.platform
    project = cfg.gcp.project or os.environ.get("TRIAGE_PROJECT_ID") or os.environ.get("GOOGLE_CLOUD_PROJECT") or ""
    if not project:
        raise Unavailable("The Google Cloud project is not set (Integrations), so Sensitive Data Protection cannot be called.")
    return CloudDlp(project, cfg.own_alerts.dlp_location or cfg.gcp.region or "global")


def clean_all(ctx: "AgentContext", texts: list[Any]) -> list[str]:
    """Each text with personal details taken out, in the order given ("" for a blank one). Raises Unavailable, with
    nothing handed back, when the check could not run on every one of them."""
    own = ctx.config.platform.own_alerts
    if not own.dlp_info_types:
        raise Unavailable("No kinds of personal detail are set (Settings, Agent alerts): nothing is kept without that check.")
    out = [patterns(t, own.snippet_chars) for t in texts]
    todo = [i for i, t in enumerate(out) if t]
    if not todo:
        return out
    gateway = get_dlp(ctx)
    batch: list[int] = []
    size = 0
    batches: list[list[int]] = []
    for i in todo:
        if batch and (len(batch) >= ROWS or size + len(out[i]) > CHARS):
            batches.append(batch)
            batch, size = [], 0
        batch.append(i)
        size += len(out[i])
    batches.append(batch)
    for group in batches:
        cleaned = gateway.deidentify([out[i] for i in group], list(own.dlp_info_types))
        if len(cleaned) != len(group):
            raise Unavailable(f"Sensitive Data Protection handed back {len(cleaned)} of {len(group)} posts.")
        for i, value in zip(group, cleaned, strict=True):
            out[i] = _cut(value.strip(), own.snippet_chars).strip()
    return out
