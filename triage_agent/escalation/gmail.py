"""Gmail gateway: drafts in the acting IM's mailbox (From the Brand Social alias) + the email doorbell.

There is no Chat API and no webhook: the agent only *drafts*; the Incident
Manager always sends (docs/CONTRACTS.md §7).

  GmailGateway             protocol used by escalation.service / escalation.tns / outbox
  FakeGmail                in-memory gateway for tests and local dev (TRIAGE_GMAIL=fake, the default)
  GoogleGmail              Gmail API with per-user OAuth tokens from a TokenVault (TRIAGE_GMAIL=google)
  LocalTokenVault          .local/gmail_tokens.json (dev; TRIAGE_TOKEN_VAULT=local, the default)
  SecretManagerTokenVault  one Secret Manager secret per user (TRIAGE_TOKEN_VAULT=secretmanager)

Scopes: IMs grant gmail.compose + gmail.metadata (create/update drafts; see whether a
draft's thread has a SENT message and read its Message-ID). The Triage Agent account
grants gmail.send only, for the email doorbell. Tokens never go to the Store.

Sent detection: once a draft is gone, its thread is read with format=metadata. A SENT
message newer than the draft (minus a small clock skew) that isn't the message being
replied to means the IM sent it; otherwise the draft was discarded.
"""

import base64
import hashlib
import html
import json
import logging
import os
import re
import threading
from datetime import datetime, timedelta, timezone
from email import policy
from email.message import EmailMessage
from email.parser import BytesParser
from email.utils import formataddr, getaddresses
from pathlib import Path
from typing import Any, Callable, Iterable, Protocol

from ..models import utcnow

log = logging.getLogger(__name__)

GMAIL_COMPOSE = "https://www.googleapis.com/auth/gmail.compose"
GMAIL_METADATA = "https://www.googleapis.com/auth/gmail.metadata"
GMAIL_SEND = "https://www.googleapis.com/auth/gmail.send"
GMAIL_READONLY = "https://www.googleapis.com/auth/gmail.readonly"
# Read scope for sent detection: gmail.metadata (default, least access) or gmail.readonly. Gmail may block
# drafts.get(format=raw) whenever gmail.metadata is granted; the Phase 0 spike checks this with a real IM token
# (flows/PHASE0_SPIKE.md). Without raw reads, revisions start from our last version instead of the IM's Gmail edits.
IM_READ_SCOPE = {"metadata": GMAIL_METADATA, "readonly": GMAIL_READONLY}.get(
    (os.environ.get("TRIAGE_GMAIL_READ_SCOPE") or "metadata").strip().lower(), GMAIL_METADATA)
IM_SCOPES: tuple[str, ...] = (GMAIL_COMPOSE, IM_READ_SCOPE)  # Incident Managers (drafts + sent detection)
AGENT_SCOPES: tuple[str, ...] = (GMAIL_SEND,)  # Triage Agent account (email doorbell only)

DEFAULT_TOKEN_PATH = ".local/gmail_tokens.json"
SENT_SKEW = timedelta(seconds=60)  # tolerated clock skew between us and Gmail's internalDate
DRAFT_FIELDS = ("from_header", "to", "cc", "bcc", "subject", "body", "html_body", "in_reply_to", "references", "thread_id")


class GmailError(RuntimeError):
    """Gmail API failure (message is safe to show to the IM)."""


class GmailNotConnected(GmailError):
    """The user hasn't connected Gmail in the Agent Console (or the token was revoked)."""


class GmailDraftNotFound(GmailError):
    """The draft (or the thread it should join) no longer exists: sent or deleted by the IM."""


# ---------------------------------------------------------------------------
# Protocols
# ---------------------------------------------------------------------------


class GmailGateway(Protocol):
    def is_connected(self, user_email: str) -> bool: ...

    def create_draft(
        self, user_email: str, *, from_header: str, to: list[str], cc: list[str], bcc: list[str],
        subject: str, body: str, html_body: str | None = None, in_reply_to: str | None = None,
        references: str | list[str] | None = None, thread_id: str | None = None,
    ) -> dict: ...  # {draft_id, message_id, thread_id}

    # Partial update: fields not given keep their current value (edits the IM made in Gmail survive).
    def update_draft(self, user_email: str, draft_id: str, **fields: Any) -> dict: ...  # {draft_id, message_id, thread_id}

    # Optional: current content {to, cc, bcc, subject, body, thread_id, …}; None if unreadable.
    def get_draft(self, user_email: str, draft_id: str) -> dict | None: ...

    def send_draft(self, user_email: str, draft_id: str) -> dict: ...  # sends it as it stands in Gmail: {message_id, thread_id}

    def draft_status(
        self, user_email: str, draft_id: str, thread_id: str | None,
        *, since: datetime | None = None, exclude: Iterable[str] = (),
    ) -> dict: ...  # {status: DRAFT|SENT|DISCARDED|UNKNOWN, rfc822_message_id?, sent_at?}

    def send_as_agent(self, agent_email: str, to: list[str], subject: str, body: str) -> None: ...


class TokenVault(Protocol):
    """Per-user OAuth tokens (authorized-user JSON from google-auth). Never the Store."""

    def get(self, email: str) -> dict | None: ...

    def put(self, email: str, creds: dict) -> None: ...

    def delete(self, email: str) -> None: ...


# ---------------------------------------------------------------------------
# RFC 2822 message building
# ---------------------------------------------------------------------------


def _header_value(value: str) -> str:
    """Header values can't contain line breaks (header injection / EmailMessage ValueError)."""
    return " ".join((value or "").split())


def references_header(references: str | Iterable[str] | None, in_reply_to: str | None = None) -> str | None:
    """Space-separated, de-duplicated Message-IDs; the parent (In-Reply-To) is always last."""
    items: list[str] = []
    if isinstance(references, str):
        items = references.split()
    elif references:
        items = [part for ref in references for part in (ref or "").split()]
    if in_reply_to:
        items = [i for i in items if i != in_reply_to] + [in_reply_to]
    items = list(dict.fromkeys(i for i in items if i))
    return " ".join(items) or None


def _recipient(value: str) -> str:
    """One recipient for a To/Cc/Bcc header: a display name with a comma (`Doe, Jane <jane@x>`) is quoted so the
    joined header doesn't split it into two addresses; non-ASCII names are RFC 2047-encoded by formataddr."""
    m = re.match(r'^\s*"?(?P<name>[^"<]*?)"?\s*<(?P<addr>[^<>@\s]+@[^<>\s]+)>\s*$', value or "")
    return formataddr((m["name"].strip(), m["addr"].strip())) if m else (value or "").strip()


def join_recipients(values: Iterable[str] | None) -> str:
    return ", ".join(_header_value(_recipient(v)) for v in values or () if v and v.strip())


def build_mime(
    *, from_header: str, to: Iterable[str], cc: Iterable[str] = (), bcc: Iterable[str] = (),
    subject: str, body: str, html_body: str | None = None,
    in_reply_to: str | None = None, references: str | Iterable[str] | None = None,
) -> EmailMessage:
    """Plain-text or multipart/alternative (plain + HTML) RFC 2822 message."""
    msg = EmailMessage()
    msg["From"] = _header_value(from_header)
    for name, values in (("To", to), ("Cc", cc), ("Bcc", bcc)):
        joined = join_recipients(values)
        if joined:
            msg[name] = joined
    msg["Subject"] = _header_value(subject)
    if in_reply_to:
        msg["In-Reply-To"] = _header_value(in_reply_to)
    refs = references_header(references, in_reply_to)
    if refs:
        msg["References"] = refs
    msg.set_content(body or "")
    if html_body:
        msg.add_alternative(html_body, subtype="html")
    return msg


def encode_message(msg: EmailMessage) -> str:
    """base64url `raw` value for the Gmail API."""
    return base64.urlsafe_b64encode(msg.as_bytes()).decode("ascii")


def decode_message(raw: str) -> EmailMessage:
    """Parse a Gmail `raw` value (base64url, padding optional)."""
    data = base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4))
    return BytesParser(policy=policy.default).parsebytes(data)  # type: ignore[return-value]


def _addresses(msg: EmailMessage, header: str) -> list[str]:
    return [addr for _name, addr in getaddresses([str(v) for v in msg.get_all(header, [])]) if addr]


def _html_to_text(markup: str) -> str:
    text = re.sub(r"(?i)<br\s*/?>|</p>|</div>|</li>", "\n", markup)
    text = re.sub(r"<[^>]+>", "", text)
    return re.sub(r"\n{3,}", "\n\n", html.unescape(text)).strip()


def message_fields(msg: EmailMessage) -> dict[str, Any]:
    """Draft content as plain fields (text/plain part preferred; HTML is flattened)."""
    part = msg.get_body(preferencelist=("plain", "html"))
    body = ""
    if part is not None:
        body = part.get_content()
        if part.get_content_subtype() == "html":
            body = _html_to_text(body)
    return {
        "from_header": str(msg.get("From") or ""), "to": _addresses(msg, "To"), "cc": _addresses(msg, "Cc"),
        "bcc": _addresses(msg, "Bcc"), "subject": str(msg.get("Subject") or ""), "body": body,
        "in_reply_to": str(msg.get("In-Reply-To") or "") or None, "references": str(msg.get("References") or "") or None,
    }


def merge_mime(msg: EmailMessage, fields: dict[str, Any]) -> EmailMessage:
    """Apply a partial update to a parsed draft: given headers are replaced; the body (even HTML) is
    kept unless `body` is given."""
    for key, header in (("from_header", "From"), ("subject", "Subject"), ("in_reply_to", "In-Reply-To")):
        if key in fields:
            del msg[header]
            if fields[key]:
                msg[header] = _header_value(fields[key])
    for key, header in (("to", "To"), ("cc", "Cc"), ("bcc", "Bcc")):
        if key in fields:
            del msg[header]
            joined = join_recipients(fields[key])
            if joined:
                msg[header] = joined
    if "references" in fields or "in_reply_to" in fields:
        refs = references_header(fields.get("references", msg.get("References")),
                                 fields.get("in_reply_to") or msg.get("In-Reply-To"))
        del msg["References"]
        if refs:
            msg["References"] = refs
    if "body" in fields:
        if msg.is_multipart():  # edited in Gmail (text + HTML, maybe attachments): new text body, attachments kept
            attachments = list(msg.iter_attachments())
            msg.clear_content()  # set_content raises TypeError on multipart messages
            msg.set_content(fields["body"] or "")
            if fields.get("html_body"):
                msg.add_alternative(fields["html_body"], subtype="html")
            if attachments:
                msg.make_mixed()
                for part in attachments:
                    msg.attach(part)
        else:
            msg.set_content(fields["body"] or "")
            if fields.get("html_body"):
                msg.add_alternative(fields["html_body"], subtype="html")
    return msg


def _check_fields(fields: dict[str, Any]) -> None:
    unknown = set(fields) - set(DRAFT_FIELDS)
    if unknown:
        raise TypeError(f"unknown draft fields: {sorted(unknown)}")


# ---------------------------------------------------------------------------
# FakeGmail (tests + local dev)
# ---------------------------------------------------------------------------


class FakeGmail:
    """In-memory Gmail for tests and the local simulator.

    * `connected`: users who connected Gmail (`connect_all=True` = everyone; the dev default).
    * Drafts live in `drafts` (draft_id -> dict); threads in `threads` (thread_id -> {user, messages}).
    * Tests simulate the IM with `mark_sent(draft_id, rfc822_message_id=None, sent_at=None)` and
      `mark_discarded(draft_id)`; `draft_status` then answers like GoogleGmail (thread lookup).
    * `send_as_agent` records doorbell emails in `sent`.
    """

    def __init__(
        self, connected: Iterable[str] | None = None, *, connect_all: bool = False,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        self.connected: set[str] = {e.strip().lower() for e in (connected or ()) if e}
        self.connect_all = connect_all
        self.clock = clock or utcnow
        self.drafts: dict[str, dict[str, Any]] = {}
        self.threads: dict[str, dict[str, Any]] = {}
        self.sent: list[dict[str, Any]] = []  # send_as_agent
        self.sent_drafts: list[dict[str, Any]] = []  # send_draft: each draft as it stood when it went out
        self.history: list[tuple[str, str]] = []  # (operation, draft_id)
        self._n = 0
        self._lock = threading.Lock()

    # -- connection (the Console's connect/disconnect in dev) -------------------
    def connect(self, user_email: str) -> None:
        self.connected.add(user_email.strip().lower())

    def disconnect(self, user_email: str) -> None:
        self.connected.discard(user_email.strip().lower())

    def is_connected(self, user_email: str) -> bool:
        return bool(user_email) and (self.connect_all or user_email.strip().lower() in self.connected)

    def _require(self, user_email: str) -> str:
        if not self.is_connected(user_email):
            raise GmailNotConnected(f"Gmail isn't connected for {user_email}")
        return user_email.strip().lower()

    def _next(self, kind: str) -> str:
        self._n += 1
        return f"{kind}-{self._n}"

    # -- drafts -------------------------------------------------------------------
    def create_draft(self, user_email, *, from_header, to, cc, bcc, subject, body,
                     html_body=None, in_reply_to=None, references=None, thread_id=None) -> dict:
        user = self._require(user_email)
        with self._lock:
            if thread_id and (thread_id not in self.threads or self.threads[thread_id]["user"] != user):
                raise GmailDraftNotFound(f"thread {thread_id} not found in {user}'s mailbox")
            draft_id, message_id = self._next("r"), self._next("m")
            thread_id = thread_id or self._next("t")
            self.threads.setdefault(thread_id, {"user": user, "messages": []})
            self.threads[thread_id]["messages"].append({"id": message_id, "labels": ["DRAFT"], "draft_id": draft_id})
            now = self.clock()
            self.drafts[draft_id] = {
                "draft_id": draft_id, "user": user, "message_id": message_id, "thread_id": thread_id,
                "from_header": from_header, "to": list(to), "cc": list(cc), "bcc": list(bcc),
                "subject": subject, "body": body, "html_body": html_body, "in_reply_to": in_reply_to,
                "references": references_header(references, in_reply_to),
                "created_at": now, "updated_at": now, "updates": 0,
            }
            self.history.append(("create", draft_id))
            return {"draft_id": draft_id, "message_id": message_id, "thread_id": thread_id}

    def update_draft(self, user_email, draft_id, **fields) -> dict:
        user = self._require(user_email)
        _check_fields(fields)
        with self._lock:
            draft = self.drafts.get(draft_id)
            if draft is None or draft["user"] != user:
                raise GmailDraftNotFound(f"draft {draft_id} not found")
            for key, value in fields.items():
                if key == "thread_id" and value is None:
                    continue
                draft[key] = list(value) if key in ("to", "cc", "bcc") else value
            if "references" in fields or "in_reply_to" in fields:
                draft["references"] = references_header(draft.get("references"), draft.get("in_reply_to"))
            # Gmail gives an updated draft a new message id (same thread).
            old_id, draft["message_id"] = draft["message_id"], self._next("m")
            for m in self.threads[draft["thread_id"]]["messages"]:
                if m["id"] == old_id:
                    m["id"] = draft["message_id"]
            draft["updated_at"] = self.clock()
            draft["updates"] += 1
            self.history.append(("update", draft_id))
            return {"draft_id": draft_id, "message_id": draft["message_id"], "thread_id": draft["thread_id"]}

    def get_draft(self, user_email, draft_id) -> dict | None:
        user = self._require(user_email)
        draft = self.drafts.get(draft_id)
        if draft is None or draft["user"] != user:
            raise GmailDraftNotFound(f"draft {draft_id} not found")
        return {k: (list(v) if isinstance(v, list) else v) for k, v in draft.items()}

    def draft_status(self, user_email, draft_id, thread_id=None, *, since=None, exclude=()) -> dict:
        user = self._require(user_email)
        draft = self.drafts.get(draft_id)
        if draft is not None and draft["user"] == user:
            return {"status": "DRAFT"}
        if not thread_id:
            return {"status": "UNKNOWN"}
        thread = self.threads.get(thread_id)
        if thread is None or thread["user"] != user:
            return {"status": "DISCARDED"}
        excluded = set(exclude or ())
        best: dict[str, Any] | None = None
        for m in thread["messages"]:
            if "SENT" not in m["labels"] or m.get("rfc822") in excluded:
                continue
            if since is not None and m["internal_date"] < since - SENT_SKEW:
                continue
            if best is None or m["internal_date"] > best["internal_date"]:
                best = m
        if best is None:
            return {"status": "DISCARDED"}
        return {"status": "SENT", "rfc822_message_id": best.get("rfc822"), "sent_at": best["internal_date"]}

    def send_draft(self, user_email, draft_id) -> dict:
        """Sends the draft as it stands, as Gmail does: it must be this person's, and it must have a recipient."""
        user = self._require(user_email)
        draft = self.drafts.get(draft_id)
        if draft is None or draft["user"] != user:
            raise GmailDraftNotFound(f"draft {draft_id} not found")
        if not (draft["to"] or draft["cc"] or draft["bcc"]):
            raise GmailError("Gmail API error 400: Recipient address required")
        self.sent_drafts.append({k: (list(v) if isinstance(v, list) else v) for k, v in draft.items()})
        thread_id = draft["thread_id"]
        self.mark_sent(draft_id)
        return {"message_id": self.threads[thread_id]["messages"][-1]["id"], "thread_id": thread_id}

    # -- test helpers (simulate the IM in Gmail) --------------------------------------
    def mark_sent(self, draft_id: str, rfc822_message_id: str | None = None, sent_at: datetime | None = None) -> str:
        """The IM sent the draft: it disappears and its thread gets a SENT message. Returns the Message-ID."""
        with self._lock:
            draft = self.drafts.pop(draft_id)
            rfc = rfc822_message_id or f"<fake-{self._next('msgid')}@mail.gmail.com>"
            thread = self.threads[draft["thread_id"]]
            thread["messages"] = [m for m in thread["messages"] if m.get("draft_id") != draft_id]
            thread["messages"].append({
                "id": self._next("m"), "labels": ["SENT"], "rfc822": rfc,
                "internal_date": sent_at or self.clock(), "subject": draft["subject"],
            })
            self.history.append(("sent", draft_id))
            return rfc

    def mark_discarded(self, draft_id: str) -> None:
        """The IM deleted the draft."""
        with self._lock:
            draft = self.drafts.pop(draft_id)
            thread = self.threads[draft["thread_id"]]
            thread["messages"] = [m for m in thread["messages"] if m.get("draft_id") != draft_id]
            if not thread["messages"]:
                del self.threads[draft["thread_id"]]
            self.history.append(("discarded", draft_id))

    def drafts_for(self, user_email: str) -> list[dict[str, Any]]:
        key = user_email.strip().lower()
        return [d for d in self.drafts.values() if d["user"] == key]

    # -- doorbell -------------------------------------------------------------------
    def send_as_agent(self, agent_email, to, subject, body) -> None:
        self.sent.append({"from": agent_email, "to": list(to), "subject": subject, "body": body, "at": self.clock()})


# ---------------------------------------------------------------------------
# Token vaults
# ---------------------------------------------------------------------------


class LocalTokenVault:
    """Dev vault: one JSON file (default .local/gmail_tokens.json, git-ignored, mode 600)."""

    def __init__(self, path: str | Path = DEFAULT_TOKEN_PATH):
        self.path = Path(path)
        self._lock = threading.Lock()

    def _read(self) -> dict[str, dict]:
        if not self.path.exists():
            return {}
        try:
            return json.loads(self.path.read_text(encoding="utf-8") or "{}")
        except json.JSONDecodeError:
            log.warning("token vault %s is not valid JSON; treating as empty", self.path)
            return {}

    def _write(self, data: dict[str, dict]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(self.path.suffix + ".tmp")
        tmp.write_text(json.dumps(data, indent=2, sort_keys=True), encoding="utf-8")
        try:
            os.chmod(tmp, 0o600)
        except OSError:  # pragma: no cover - best effort on exotic filesystems
            pass
        os.replace(tmp, self.path)

    def get(self, email: str) -> dict | None:
        with self._lock:
            return self._read().get((email or "").strip().lower())

    def put(self, email: str, creds: dict) -> None:
        with self._lock:
            data = self._read()
            data[email.strip().lower()] = dict(creds)
            self._write(data)

    def delete(self, email: str) -> None:
        with self._lock:
            data = self._read()
            if data.pop((email or "").strip().lower(), None) is not None:
                self._write(data)


class SecretManagerTokenVault:
    """Prod vault: one secret per user, named `<prefix><sha256(email)[:40]>` (no PII in names).

    The runtime service account needs secretmanager.secrets.create/delete and
    secretmanager.versions.add/access in the project.
    """

    def __init__(self, project: str | None = None, prefix: str = "gmail-token-", client: Any = None):
        self.project = project or os.environ.get("GOOGLE_CLOUD_PROJECT")
        if not self.project:
            raise GmailError("SecretManagerTokenVault needs GOOGLE_CLOUD_PROJECT")
        self.prefix = prefix
        if client is None:
            from google.cloud import secretmanager  # lazy: not a default dependency

            client = secretmanager.SecretManagerServiceClient()
        self.client = client

    @staticmethod
    def _exceptions():
        from google.api_core import exceptions  # lazy

        return exceptions

    def secret_id(self, email: str) -> str:
        digest = hashlib.sha256(email.strip().lower().encode("utf-8")).hexdigest()
        return f"{self.prefix}{digest[:40]}"

    def _secret_path(self, email: str) -> str:
        return f"projects/{self.project}/secrets/{self.secret_id(email)}"

    def get(self, email: str) -> dict | None:
        exc = self._exceptions()
        try:
            resp = self.client.access_secret_version(name=f"{self._secret_path(email)}/versions/latest")
        except (exc.NotFound, exc.FailedPrecondition):  # no secret / no enabled version
            return None
        return json.loads(resp.payload.data.decode("utf-8"))

    def put(self, email: str, creds: dict) -> None:
        exc = self._exceptions()
        try:
            self.client.create_secret(
                parent=f"projects/{self.project}",
                secret_id=self.secret_id(email),
                secret={"replication": {"automatic": {}}, "labels": {"app": "triage-agent", "kind": "gmail-token"}},
            )
        except exc.AlreadyExists:
            pass
        self.client.add_secret_version(
            parent=self._secret_path(email), payload={"data": json.dumps(creds).encode("utf-8")}
        )

    def delete(self, email: str) -> None:
        exc = self._exceptions()
        try:
            self.client.delete_secret(name=self._secret_path(email))
        except exc.NotFound:
            pass


def get_token_vault() -> TokenVault:
    """TRIAGE_TOKEN_VAULT=local (default, .local/gmail_tokens.json) | secretmanager."""
    kind = (os.environ.get("TRIAGE_TOKEN_VAULT") or "local").strip().lower()
    if kind in ("secretmanager", "secret_manager", "secret-manager", "gcp"):
        return SecretManagerTokenVault()
    return LocalTokenVault()


# ---------------------------------------------------------------------------
# GoogleGmail (Gmail API)
# ---------------------------------------------------------------------------


def _build_service(creds: Any) -> Any:
    from googleapiclient.discovery import build  # lazy

    return build("gmail", "v1", credentials=creds, cache_discovery=False)


def _http_status(exc: Exception) -> int | None:
    status = getattr(exc, "status_code", None)
    if status is None and getattr(exc, "resp", None) is not None:
        status = getattr(exc.resp, "status", None)
    try:
        return int(status) if status is not None else None
    except (TypeError, ValueError):
        return None


def _draft_result(resp: dict) -> dict:
    message = resp.get("message") or {}
    return {"draft_id": resp.get("id"), "message_id": message.get("id"), "thread_id": message.get("threadId")}


def _header(message: dict, name: str) -> str | None:
    for h in (message.get("payload") or {}).get("headers") or []:
        if (h.get("name") or "").lower() == name.lower():
            return h.get("value")
    return None


class GoogleGmail:
    """Gmail API gateway. Each IM's OAuth token (IM_SCOPES) comes from the TokenVault;
    the Triage Agent account's token (AGENT_SCOPES) is used only by send_as_agent."""

    def __init__(self, vault: TokenVault, *, client_config: dict | None = None,
                 service_factory: Callable[[Any], Any] | None = None):
        self.vault = vault
        self.client_config = client_config  # optional: fills client_id/secret missing from stored tokens
        self._service_factory = service_factory or _build_service

    # -- credentials ------------------------------------------------------------
    def is_connected(self, user_email: str) -> bool:
        if not user_email:
            return False
        try:
            info = self.vault.get(user_email)
        except Exception as exc:  # noqa: BLE001 - a vault outage reads as "not connected"
            log.warning("token vault read failed for %s: %s", user_email, exc)
            return False
        return bool(info and info.get("refresh_token"))

    def _credentials(self, user_email: str) -> Any:
        from google.auth.exceptions import RefreshError, TransportError
        from google.auth.transport.requests import Request
        from google.oauth2.credentials import Credentials

        info = self.vault.get(user_email) if user_email else None
        if not info or not info.get("refresh_token"):
            raise GmailNotConnected(f"Gmail isn't connected for {user_email}")
        info = dict(info)
        web = (self.client_config or {}).get("web") or (self.client_config or {}).get("installed") or {}
        for key, src in (("client_id", "client_id"), ("client_secret", "client_secret"), ("token_uri", "token_uri")):
            if not info.get(key) and web.get(src):
                info[key] = web[src]
        try:
            creds = Credentials.from_authorized_user_info(info)
        except ValueError as exc:
            raise GmailNotConnected(f"Stored Gmail token for {user_email} is incomplete; reconnect Gmail") from exc
        if not creds.valid:
            try:
                creds.refresh(Request())
            except RefreshError as exc:
                raise GmailNotConnected(
                    f"Gmail access for {user_email} was revoked or expired; reconnect Gmail in the Agent Console"
                ) from exc
            except TransportError as exc:  # network trouble reaching the token endpoint: try again later
                raise GmailError(f"Couldn't reach Google to refresh the Gmail token: {exc}") from exc
            try:
                self.vault.put(user_email, json.loads(creds.to_json()))
            except Exception as exc:  # noqa: BLE001 - the refreshed token still works for this call
                log.warning("could not persist refreshed token for %s: %s", user_email, exc)
        return creds

    def _execute(self, user_email: str, request: Callable[[Any], Any]) -> dict:
        import httplib2
        from google.auth.exceptions import RefreshError, TransportError
        from googleapiclient.errors import HttpError

        service = self._service_factory(self._credentials(user_email))
        try:
            return request(service).execute()
        except HttpError as exc:
            status = _http_status(exc)
            if status == 404:
                raise GmailDraftNotFound(f"Gmail: not found ({exc})") from exc
            if status == 401:
                raise GmailNotConnected(f"Gmail rejected the token for {user_email}; reconnect Gmail") from exc
            raise GmailError(f"Gmail API error {status}: {exc}") from exc
        except RefreshError as exc:  # 401 -> the automatic refresh failed: access revoked while the token looked valid
            raise GmailNotConnected(
                f"Gmail access for {user_email} was revoked or expired; reconnect Gmail in the Agent Console"
            ) from exc
        except (TransportError, OSError, httplib2.HttpLib2Error) as exc:  # timeouts, DNS, TLS
            raise GmailError(f"Gmail is unreachable right now: {exc}") from exc

    # -- drafts -------------------------------------------------------------------
    @staticmethod
    def _message(fields: dict[str, Any]) -> dict:
        mime = build_mime(
            from_header=fields.get("from_header") or "",
            to=fields.get("to") or (),
            cc=fields.get("cc") or (),
            bcc=fields.get("bcc") or (),
            subject=fields.get("subject") or "",
            body=fields.get("body") or "",
            html_body=fields.get("html_body"),
            in_reply_to=fields.get("in_reply_to"),
            references=fields.get("references"),
        )
        message: dict[str, Any] = {"raw": encode_message(mime)}
        if fields.get("thread_id"):
            message["threadId"] = fields["thread_id"]
        return message

    def create_draft(self, user_email, *, from_header, to, cc, bcc, subject, body,
                     html_body=None, in_reply_to=None, references=None, thread_id=None) -> dict:
        message = self._message(dict(
            from_header=from_header, to=to, cc=cc, bcc=bcc, subject=subject, body=body,
            html_body=html_body, in_reply_to=in_reply_to, references=references, thread_id=thread_id,
        ))
        resp = self._execute(user_email, lambda s: s.users().drafts().create(userId="me", body={"message": message}))
        return _draft_result(resp)

    def _raw_draft(self, user_email: str, draft_id: str) -> tuple[EmailMessage, str | None]:
        resp = self._execute(user_email, lambda s: s.users().drafts().get(userId="me", id=draft_id, format="raw"))
        message = resp.get("message") or {}
        return decode_message(message.get("raw") or ""), message.get("threadId")

    def update_draft(self, user_email, draft_id, **fields) -> dict:
        """Partial update: given fields replace the draft's; the rest (including an HTML body the IM
        edited in Gmail) is kept. Passing every field skips reading the draft."""
        _check_fields(fields)
        if all(k in fields for k in ("from_header", "to", "cc", "bcc", "subject", "body")):
            message = self._message(fields)
        else:
            try:
                current, thread_id = self._raw_draft(user_email, draft_id)
            except (GmailDraftNotFound, GmailNotConnected):
                raise
            except GmailError as exc:
                raise GmailError(f"Partial draft update needs read access to the draft: {exc}") from exc
            message = {"raw": encode_message(merge_mime(current, fields))}
            if fields.get("thread_id") or thread_id:
                message["threadId"] = fields.get("thread_id") or thread_id
        resp = self._execute(
            user_email,
            lambda s: s.users().drafts().update(userId="me", id=draft_id, body={"id": draft_id, "message": message}),
        )
        return _draft_result(resp)

    def get_draft(self, user_email, draft_id) -> dict | None:
        """Current draft content (the IM may have edited it in Gmail); None if the token can't read it."""
        try:
            current, thread_id = self._raw_draft(user_email, draft_id)
        except (GmailDraftNotFound, GmailNotConnected):
            raise
        except GmailError as exc:
            log.info("draft %s unreadable for %s: %s", draft_id, user_email, exc)
            return None
        return {**message_fields(current), "draft_id": draft_id, "thread_id": thread_id}

    def send_draft(self, user_email, draft_id) -> dict:
        """Sends the draft as it stands in Gmail (users.drafts.send: gmail.compose allows it, no further permission)."""
        resp = self._execute(user_email, lambda s: s.users().drafts().send(userId="me", body={"id": draft_id}))
        return {"message_id": resp.get("id"), "thread_id": resp.get("threadId")}

    def draft_status(self, user_email, draft_id, thread_id=None, *, since=None, exclude=()) -> dict:
        try:
            self._execute(user_email, lambda s: s.users().drafts().get(userId="me", id=draft_id, format="minimal"))
            return {"status": "DRAFT"}
        except GmailDraftNotFound:
            pass
        if not thread_id:
            return {"status": "UNKNOWN"}
        try:
            thread = self._execute(
                user_email,
                lambda s: s.users().threads().get(
                    userId="me", id=thread_id, format="metadata", metadataHeaders=["Message-ID", "Date"]
                ),
            )
        except GmailDraftNotFound:
            return {"status": "DISCARDED"}
        excluded = set(exclude or ())
        best: tuple[datetime, str | None] | None = None
        for m in thread.get("messages") or []:
            if "SENT" not in (m.get("labelIds") or []):
                continue
            sent_at = datetime.fromtimestamp(int(m.get("internalDate") or 0) / 1000, tz=timezone.utc)
            rfc = _header(m, "Message-ID")
            if rfc in excluded or (since is not None and sent_at < since - SENT_SKEW):
                continue
            if best is None or sent_at > best[0]:
                best = (sent_at, rfc)
        if best is None:
            return {"status": "DISCARDED"}
        return {"status": "SENT", "rfc822_message_id": best[1], "sent_at": best[0]}

    # -- doorbell -------------------------------------------------------------------
    def send_as_agent(self, agent_email, to, subject, body) -> None:
        message = {"raw": encode_message(build_mime(from_header=agent_email, to=list(to), subject=subject, body=body))}
        self._execute(agent_email, lambda s: s.users().messages().send(userId="me", body=message))


# ---------------------------------------------------------------------------
# OAuth helpers for the Agent Console (GET /api/gmail/connect, /callback, DELETE /api/gmail)
# ---------------------------------------------------------------------------


def load_oauth_client_config(source: str | None = None) -> dict:
    """OAuth web client JSON from TRIAGE_OAUTH_CLIENT: a file path, or a Secret Manager secret
    (`projects/<p>/secrets/<s>[/versions/<v>]`, or a bare secret id in GOOGLE_CLOUD_PROJECT)."""
    source = source or os.environ.get("TRIAGE_OAUTH_CLIENT")
    if not source:
        raise GmailError("TRIAGE_OAUTH_CLIENT is not set")
    path = Path(source)
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    from google.cloud import secretmanager  # lazy

    name = source if source.startswith("projects/") else f"projects/{os.environ.get('GOOGLE_CLOUD_PROJECT')}/secrets/{source}"
    if "/versions/" not in name:
        name += "/versions/latest"
    resp = secretmanager.SecretManagerServiceClient().access_secret_version(name=name)
    return json.loads(resp.payload.data.decode("utf-8"))


def build_oauth_flow(client_config: dict, redirect_uri: str, scopes: Iterable[str] = IM_SCOPES,
                     state: str | None = None) -> Any:
    """google-auth-oauthlib Flow; use `flow.authorization_url(access_type="offline", prompt="consent")`."""
    from google_auth_oauthlib.flow import Flow  # lazy

    return Flow.from_client_config(client_config, scopes=list(scopes), redirect_uri=redirect_uri, state=state)


def store_credentials(vault: TokenVault, email: str, creds: Any) -> None:
    """Save google.oauth2 Credentials (after flow.fetch_token) for `email`."""
    vault.put(email, json.loads(creds.to_json()))


# ---------------------------------------------------------------------------
# Factory
# ---------------------------------------------------------------------------


def get_gmail_gateway(config: Any = None) -> GmailGateway | None:
    """TRIAGE_GMAIL=fake (default: in-memory, every user counts as connected) | google | off."""
    mode = (os.environ.get("TRIAGE_GMAIL") or "fake").strip().lower()
    if mode == "fake":
        return FakeGmail(connect_all=True)
    if mode == "google":
        client_config = None
        if os.environ.get("TRIAGE_OAUTH_CLIENT"):
            try:
                client_config = load_oauth_client_config()
            except Exception as exc:  # noqa: BLE001 - stored tokens normally carry the client id/secret
                log.warning("OAuth client config unavailable: %s", exc)
        return GoogleGmail(get_token_vault(), client_config=client_config)
    if mode not in ("off", "none", "disabled"):
        log.warning("unknown TRIAGE_GMAIL=%r; Gmail drafting disabled", mode)
    return None
