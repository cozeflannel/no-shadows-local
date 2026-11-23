"""Google Workspace User-OAuth clients: Chat, Gmail, Sheets, Drive, Docs, and People."""

from __future__ import annotations

import base64
import hashlib
import logging
import re
import time
from datetime import UTC, datetime
from typing import Any

from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

from .config import CampaignsConfig
from .logging_utils import log_event, strip_emojis
from .store import CampaignStore

logger = logging.getLogger(__name__)

CAMPAIGN_CLIENT_ID_PREFIX = "client-scmp-"
OTHER_OWN_PREFIXES = ("client-bqa-", "client-zrlo-", "client-zrly-", "client-zmir-")
PROCESSED_GMAIL_LABEL = "slrr-cmp-processed"
GMAIL_CAMPAIGN_QUERY = f'"SLRR-CMP-" -label:{PROCESSED_GMAIL_LABEL}'
CHROME_ALERTS_GMAIL_QUERY = 'subject:("Chrome Alerts") -"SLRR-CMP-" is:unread'
MAX_CHAT_TEXT_CHARS = 3950
MAX_SHEET_CELL_CHARS = 48000


class WorkspaceApiError(RuntimeError):
    """Raised when a Google Workspace API call fails or violates the space allowlist."""

    def __init__(self, message: str, *, service_name: str, status_code: int = 0) -> None:
        super().__init__(message)
        self.service_name = service_name
        self.status_code = status_code


_FORMULA_START = ("=", "+", "-", "@", "\t", "\r")
_PLAIN_NUMBER = re.compile(r"[-+]?\d+(?:\.\d+)?")


def _sanitize_cell(value: Any) -> str:
    """Cell text for a USER_ENTERED write: no emojis, capped, and never read as a formula.

    The rows come from alert emails and public posts (author, link, snippet), so text that starts like a
    formula gets a leading apostrophe, which Sheets keeps as plain text. A plain number stays a number.
    """
    text = strip_emojis(str(value if value is not None else ""))
    if len(text) > MAX_SHEET_CELL_CHARS:
        text = text[: MAX_SHEET_CELL_CHARS - 15] + " [truncated]"
    if text.startswith(_FORMULA_START) and not _PLAIN_NUMBER.fullmatch(text):
        return "'" + text
    return text


def _build_client_message_id(seed: str) -> str:
    digest = hashlib.sha256(seed.encode("utf-8")).hexdigest()[:24]
    return f"{CAMPAIGN_CLIENT_ID_PREFIX}{digest}"


def _extract_mime_bodies(payload: dict[str, Any]) -> tuple[str, str]:
    """Recursively extract (html_body, plain_body) from a Gmail message payload."""
    mime_type = str(payload.get("mimeType") or "").lower()
    body_data = str((payload.get("body") or {}).get("data") or "")
    decoded = ""
    if body_data:
        padded = body_data + "=" * (-len(body_data) % 4)
        decoded = base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8", errors="replace")

    if mime_type == "text/html" and decoded:
        return decoded, ""
    if mime_type == "text/plain" and decoded:
        return "", decoded

    html_parts: list[str] = []
    text_parts: list[str] = []
    for part in payload.get("parts") or []:
        if isinstance(part, dict):
            sub_html, sub_text = _extract_mime_bodies(part)
            if sub_html:
                html_parts.append(sub_html)
            if sub_text:
                text_parts.append(sub_text)
    return "\n".join(html_parts), "\n".join(text_parts)


class WorkspaceClients:
    """User-authenticated Google Chat, Gmail, Sheets, Drive, Docs, and People API wrapper."""

    def __init__(self, cfg: CampaignsConfig, store: CampaignStore, creds: Credentials) -> None:
        self._cfg = cfg
        self._store = store
        self._chat = build("chat", "v1", credentials=creds, cache_discovery=False)
        self._gmail = build("gmail", "v1", credentials=creds, cache_discovery=False)
        self._sheets = build("sheets", "v4", credentials=creds, cache_discovery=False)
        self._drive = build("drive", "v3", credentials=creds, cache_discovery=False)
        self._docs = build("docs", "v1", credentials=creds, cache_discovery=False)
        self._people = build("people", "v1", credentials=creds, cache_discovery=False)
        self._ephemeral_allowed_spaces: set[str] = set()
        self._caller_email_cache: str = ""
        self._caller_user_cache: str = ""

    def _execute_with_backoff(self, service_name: str, operation: str, request_obj: Any) -> Any:
        delay = 1.5
        for attempt in range(4):
            try:
                return request_obj.execute()
            except HttpError as exc:
                status = int(getattr(exc.resp, "status", 0) or 0)
                detail = exc.content.decode("utf-8", errors="replace")[:500] if exc.content else str(exc)
                if status == 404 and "Google Chat app not found" in detail:
                    log_event(
                        logger,
                        logging.ERROR,
                        "chat_app_not_found",
                        operation=operation,
                        detail=detail,
                    )
                    raise WorkspaceApiError(
                        "Google Chat API returned 404 'Google Chat app not found'; "
                        "OAuth client is in the wrong GCP project",
                        service_name="chat",
                        status_code=404,
                    ) from exc
                if status in (429, 500, 502, 503, 504) and attempt < 3:
                    log_event(
                        logger,
                        logging.WARNING,
                        "workspace_api_backoff",
                        service_name=service_name,
                        operation=operation,
                        status_code=status,
                        delay_seconds=delay,
                    )
                    time.sleep(delay)
                    delay *= 2.0
                    continue
                log_event(
                    logger,
                    logging.ERROR,
                    "workspace_api_error",
                    service_name=service_name,
                    operation=operation,
                    status_code=status,
                    detail=detail,
                )
                raise WorkspaceApiError(
                    f"{service_name}.{operation} failed (HTTP {status}): {detail}",
                    service_name=service_name,
                    status_code=status,
                ) from exc
        raise WorkspaceApiError(f"{service_name}.{operation} exhausted retries", service_name=service_name)

    def _assert_write_allowed(self, space: str, thread_name: str | None) -> None:
        """Enforce the Space Allowlist guardrail before any Chat write."""
        if space == self._cfg.forbidden_burson_space:
            raise WorkspaceApiError(
                f"Write to forbidden live Burson space {space} is strictly blocked",
                service_name="chat",
            )
        if space in self._ephemeral_allowed_spaces:
            return
        if self._cfg.is_allowed_alerts_space(space):
            if not thread_name or not self._store.is_owned_thread(space, thread_name):
                raise WorkspaceApiError(
                    f"Write in alerts space {space} requires an owned thread; got {thread_name!r}",
                    service_name="chat",
                )
            return
        if self._store.is_created_space(space):
            return
        raise WorkspaceApiError(
            f"Space {space} is neither an owned alerts-space thread nor a created campaign space",
            service_name="chat",
        )

    def get_mailbox_email(self) -> str:
        """Return the authenticated Gmail user's email address."""
        if self._caller_email_cache:
            return self._caller_email_cache
        profile = self._execute_with_backoff(
            "gmail",
            "users.getProfile",
            self._gmail.users().getProfile(userId="me"),
        )
        email = str((profile or {}).get("emailAddress") or "").strip().lower()
        if not email:
            raise WorkspaceApiError("Gmail profile did not return emailAddress", service_name="gmail")
        self._caller_email_cache = email
        return email

    def resolve_email_to_chat_user(self, email: str) -> str:
        """Resolve a Google Workspace email to users/<id> via People API directory lookup."""
        target = email.strip().lower()
        if not target or "@" not in target:
            raise WorkspaceApiError(f"Invalid email address for lookup: {email!r}", service_name="people")
        resp = self._execute_with_backoff(
            "people",
            "people.searchDirectoryPeople",
            self._people.people().searchDirectoryPeople(
                query=target,
                readMask="emailAddresses,metadata",
                sources=["DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE"],
                pageSize=20,
            ),
        )
        for person in (resp or {}).get("people") or []:
            if not isinstance(person, dict):
                continue
            emails = [
                str(e.get("value") or "").strip().lower()
                for e in (person.get("emailAddresses") or [])
                if isinstance(e, dict)
            ]
            if target not in emails:
                continue
            res_name = str(person.get("resourceName") or "")
            if res_name.startswith("people/"):
                person_id = res_name.split("/", 1)[1]
                if person_id:
                    return f"users/{person_id}"
            for src in (person.get("metadata") or {}).get("sources") or []:
                if isinstance(src, dict) and src.get("id"):
                    return f"users/{src['id']}"
        raise WorkspaceApiError(
            f"Could not resolve directory user ID for email {target}",
            service_name="people",
        )

    def get_caller_user_name(self) -> str:
        """Return the Chat user resource name (users/...) of the authenticated OAuth user."""
        if not self._caller_user_cache:
            email = self.get_mailbox_email()
            self._caller_user_cache = self.resolve_email_to_chat_user(email)
        return self._caller_user_cache

    def setup_space(
        self,
        *,
        display_name: str,
        external_user_allowed: bool,
        member_user_names: list[str],
        ephemeral: bool = False,
    ) -> dict[str, Any]:
        """Create a Google Chat space via spaces.setup and read back the applied Space settings."""
        clean_title = strip_emojis(display_name)[:120]
        caller_user = self.get_caller_user_name()
        memberships: list[dict[str, Any]] = []
        seen_users: set[str] = {caller_user}
        for user_name in member_user_names:
            u = user_name.strip()
            if not u or not u.startswith("users/") or u in seen_users:
                continue
            seen_users.add(u)
            memberships.append({"member": {"name": u, "type": "HUMAN"}})

        body: dict[str, Any] = {
            "space": {
                "spaceType": "SPACE",
                "displayName": clean_title,
                "externalUserAllowed": external_user_allowed,
            },
        }
        if memberships:
            body["memberships"] = memberships

        created = self._execute_with_backoff(
            "chat",
            "spaces.setup",
            self._chat.spaces().setup(body=body),
        )
        space_name = str((created or {}).get("name") or "")
        if not space_name.startswith("spaces/"):
            raise WorkspaceApiError("spaces.setup did not return a valid space name", service_name="chat")
        if ephemeral:
            self._ephemeral_allowed_spaces.add(space_name)
        space_info = self.get_space(space_name)
        if space_info.get("spaceHistoryState") != "HISTORY_ON":
            try:
                self._execute_with_backoff(
                    "chat",
                    "spaces.patch.history",
                    self._chat.spaces().patch(
                        name=space_name,
                        updateMask="spaceHistoryState",
                        body={"spaceHistoryState": "HISTORY_ON"},
                    ),
                )
            except WorkspaceApiError as exc:
                if exc.status_code not in (400, 403):
                    raise
                log_event(
                    logger,
                    logging.WARNING,
                    "space_history_state_policy_locked",
                    space_name=space_name,
                    status_code=exc.status_code,
                    detail=str(exc)[:240],
                )
            space_info = self.get_space(space_name)
        return space_info

    def get_space(self, space_name: str) -> dict[str, Any]:
        """GET v1/{name=spaces/*} including spaceUri, externalUserAllowed, and spaceHistoryState."""
        data = self._execute_with_backoff(
            "chat",
            "spaces.get",
            self._chat.spaces().get(name=space_name),
        )
        return data if isinstance(data, dict) else {}

    def patch_space_display_name(self, space_name: str, display_name: str) -> dict[str, Any]:
        """Patch displayName alone on a created campaign space."""
        self._assert_write_allowed(space_name, None)
        clean_title = strip_emojis(display_name)[:120]
        data = self._execute_with_backoff(
            "chat",
            "spaces.patch",
            self._chat.spaces().patch(
                name=space_name,
                updateMask="displayName",
                body={"displayName": clean_title},
            ),
        )
        return data if isinstance(data, dict) else {}

    def delete_space(self, space_name: str) -> None:
        """Delete a test or preflight Chat space created by slrr-campaigns."""
        self._assert_write_allowed(space_name, None)
        self._execute_with_backoff(
            "chat",
            "spaces.delete",
            self._chat.spaces().delete(name=space_name),
        )
        self._ephemeral_allowed_spaces.discard(space_name)

    def post_message(
        self,
        space: str,
        text: str,
        *,
        thread_name: str | None = None,
        idempotency_key: str = "",
    ) -> dict[str, Any]:
        """Post a plain-text, emoji-free Chat message and record its created resource name."""
        self._assert_write_allowed(space, thread_name)
        clean_text = strip_emojis(text)
        if len(clean_text) > MAX_CHAT_TEXT_CHARS:
            clean_text = clean_text[: MAX_CHAT_TEXT_CHARS - 16] + "\n[truncated]"
        seed = idempotency_key or f"{space}|{thread_name or ''}|{time.time_ns()}|{clean_text[:80]}"
        client_msg_id = _build_client_message_id(seed)

        body: dict[str, Any] = {"text": clean_text}
        kwargs: dict[str, Any] = {
            "parent": space,
            "messageId": client_msg_id,
            "body": body,
        }
        if thread_name:
            body["thread"] = {"name": thread_name}
            kwargs["messageReplyOption"] = "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD"

        created = self._execute_with_backoff(
            "chat",
            "spaces.messages.create",
            self._chat.spaces().messages().create(**kwargs),
        )
        msg_name = str((created or {}).get("name") or "")
        returned_thread = str(((created or {}).get("thread") or {}).get("name") or thread_name or "")
        if msg_name:
            self._store.record_created_message(msg_name, space, returned_thread)
        return created if isinstance(created, dict) else {}

    def get_message(self, message_name: str) -> dict[str, Any]:
        """Read a single Chat message by resource name."""
        data = self._execute_with_backoff(
            "chat",
            "spaces.messages.get",
            self._chat.spaces().messages().get(name=message_name),
        )
        return data if isinstance(data, dict) else {}

    def is_own_or_bot_message(self, msg: dict[str, Any]) -> bool:
        """Return True if msg was sent by a bot, slrr-campaigns, or SLRR Triage Chat Agent."""
        sender = msg.get("sender") or {}
        if str(sender.get("type") or "") == "BOT":
            return True
        client_id = str(msg.get("clientAssignedMessageId") or "")
        if client_id.startswith(CAMPAIGN_CLIENT_ID_PREFIX) or client_id.startswith(OTHER_OWN_PREFIXES):
            return True
        msg_name = str(msg.get("name") or "")
        return bool(msg_name and self._store.is_created_message(msg_name))

    def list_human_messages(
        self,
        space: str,
        *,
        thread_name: str | None = None,
        since_iso: str = "",
        page_size: int = 100,
    ) -> list[dict[str, Any]]:
        """List chronological human input messages in an owned thread or created space."""
        filters: list[str] = []
        if thread_name:
            filters.append(f'thread.name = "{thread_name}"')
        if since_iso:
            filters.append(f'createTime > "{since_iso}"')
        filter_expr = " AND ".join(filters)

        collected: list[dict[str, Any]] = []
        page_token: str | None = None
        while True:
            kwargs: dict[str, Any] = {"parent": space, "pageSize": page_size}
            if filter_expr:
                kwargs["filter"] = filter_expr
            if page_token:
                kwargs["pageToken"] = page_token
            resp = self._execute_with_backoff(
                "chat",
                "spaces.messages.list",
                self._chat.spaces().messages().list(**kwargs),
            )
            batch = (resp or {}).get("messages") or []
            for item in batch:
                if not isinstance(item, dict):
                    continue
                if self.is_own_or_bot_message(item):
                    continue
                collected.append(item)
            page_token = (resp or {}).get("nextPageToken")
            if not page_token:
                break

        collected.sort(key=lambda m: str(m.get("createTime") or ""))
        return collected

    def list_recent_space_messages(self, space: str, *, page_size: int = 25) -> list[dict[str, Any]]:
        """Read recent messages in a space (used by preflight and live tests)."""
        resp = self._execute_with_backoff(
            "chat",
            "spaces.messages.list",
            self._chat.spaces()
            .messages()
            .list(
                parent=space,
                pageSize=page_size,
                orderBy="createTime desc",
            ),
        )
        msgs = (resp or {}).get("messages") or []
        return [m for m in msgs if isinstance(m, dict)]

    def get_thread_root_text(self, space: str, thread_name: str) -> str:
        """Read the earliest message in thread_name (including BOT or mirrored alert roots)."""
        resp = self._execute_with_backoff(
            "chat",
            "spaces.messages.list",
            self._chat.spaces()
            .messages()
            .list(
                parent=space,
                filter=f'thread.name = "{thread_name}"',
                pageSize=10,
            ),
        )
        msgs = [m for m in ((resp or {}).get("messages") or []) if isinstance(m, dict)]
        msgs.sort(key=lambda m: str(m.get("createTime") or ""))
        return str(msgs[0].get("text") or "") if msgs else ""

    def ensure_gmail_label(self, label_name: str = PROCESSED_GMAIL_LABEL) -> str:
        """Return Gmail label ID for label_name, creating it if absent."""
        resp = self._execute_with_backoff(
            "gmail",
            "users.labels.list",
            self._gmail.users().labels().list(userId="me"),
        )
        for lbl in (resp or {}).get("labels") or []:
            if isinstance(lbl, dict) and str(lbl.get("name") or "").lower() == label_name.lower():
                return str(lbl["id"])
        created = self._execute_with_backoff(
            "gmail",
            "users.labels.create",
            self._gmail.users()
            .labels()
            .create(
                userId="me",
                body={
                    "name": label_name,
                    "labelListVisibility": "labelShow",
                    "messageListVisibility": "show",
                },
            ),
        )
        return str((created or {}).get("id") or "")

    def search_gmail_message_ids(self, query: str, *, max_results: int = 50) -> list[str]:
        """List Gmail message IDs matching query."""
        resp = self._execute_with_backoff(
            "gmail",
            "users.messages.list",
            self._gmail.users().messages().list(userId="me", q=query, maxResults=max_results),
        )
        return [
            str(m["id"]) for m in ((resp or {}).get("messages") or []) if isinstance(m, dict) and m.get("id")
        ]

    def get_gmail_message(self, message_id: str) -> dict[str, str]:
        """Fetch full Gmail message subject, HTML body, plain body, and received UTC ISO timestamp."""
        msg = self._execute_with_backoff(
            "gmail",
            "users.messages.get",
            self._gmail.users().messages().get(userId="me", id=message_id, format="full"),
        )
        payload = (msg or {}).get("payload") or {}
        subject = ""
        for hdr in payload.get("headers") or []:
            if isinstance(hdr, dict) and str(hdr.get("name") or "").lower() == "subject":
                subject = str(hdr.get("value") or "")
                break
        html_body, text_body = _extract_mime_bodies(payload)
        internal_ms = int((msg or {}).get("internalDate") or 0)
        received_iso = (
            datetime.fromtimestamp(internal_ms / 1000.0, tz=UTC).isoformat()
            if internal_ms > 0
            else datetime.now(UTC).isoformat()
        )
        return {
            "id": message_id,
            "subject": subject,
            "html_body": html_body,
            "text_body": text_body,
            "received_iso": received_iso,
        }

    def mark_gmail_processed(self, message_id: str, label_id: str) -> None:
        """Apply the processed label and mark the Gmail message read."""
        self._execute_with_backoff(
            "gmail",
            "users.messages.modify",
            self._gmail.users()
            .messages()
            .modify(
                userId="me",
                id=message_id,
                body={"addLabelIds": [label_id], "removeLabelIds": ["UNREAD"]},
            ),
        )

    def ensure_drive_folder(self, folder_name: str) -> str:
        """Find or create a Google Drive folder by exact name."""
        escaped = folder_name.replace("'", "\\'")
        q = f"name = '{escaped}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false"
        resp = self._execute_with_backoff(
            "drive",
            "files.list",
            self._drive.files().list(q=q, fields="files(id, name)", pageSize=5),
        )
        files = (resp or {}).get("files") or []
        if files and isinstance(files[0], dict) and files[0].get("id"):
            return str(files[0]["id"])
        created = self._execute_with_backoff(
            "drive",
            "files.create",
            self._drive.files().create(
                body={"name": strip_emojis(folder_name), "mimeType": "application/vnd.google-apps.folder"},
                fields="id",
            ),
        )
        return str((created or {}).get("id") or "")

    def move_file_to_folder(self, file_id: str, folder_id: str) -> None:
        """Place a Drive file inside folder_id."""
        meta = self._execute_with_backoff(
            "drive",
            "files.get",
            self._drive.files().get(fileId=file_id, fields="parents"),
        )
        parents = ",".join((meta or {}).get("parents") or [])
        kwargs: dict[str, Any] = {"fileId": file_id, "addParents": folder_id, "fields": "id, parents"}
        if parents:
            kwargs["removeParents"] = parents
        self._execute_with_backoff(
            "drive",
            "files.update",
            self._drive.files().update(**kwargs),
        )

    def find_file_in_folder(self, folder_id: str, name: str, mime_type: str) -> str:
        """Find an existing non-trashed file in folder_id by exact name and MIME type."""
        escaped = name.replace("'", "\\'")
        q = (
            f"'{folder_id}' in parents and name = '{escaped}' "
            f"and mimeType = '{mime_type}' and trashed = false"
        )
        resp = self._execute_with_backoff(
            "drive",
            "files.list",
            self._drive.files().list(q=q, fields="files(id, name)", pageSize=5),
        )
        files = (resp or {}).get("files") or []
        if files and isinstance(files[0], dict) and files[0].get("id"):
            return str(files[0]["id"])
        return ""

    def delete_drive_file(self, file_id: str) -> None:
        """Permanently delete a Drive file created by tests or preflight."""
        self._execute_with_backoff(
            "drive",
            "files.delete",
            self._drive.files().delete(fileId=file_id),
        )

    def drive_file_exists(self, file_id: str) -> bool:
        """Verify whether a Drive file still exists and is not trashed."""
        try:
            meta = self._drive.files().get(fileId=file_id, fields="id,trashed").execute()
            return bool(meta and not meta.get("trashed"))
        except HttpError as exc:
            if int(getattr(exc.resp, "status", 0) or 0) == 404:
                return False
            raise

    def create_spreadsheet(
        self,
        *,
        title: str,
        folder_id: str,
        sheet_titles: list[str],
    ) -> tuple[str, str, dict[str, int]]:
        """Idempotently find or create a Google Sheet in folder_id and return (id, url, sheet_ids)."""
        clean_title = strip_emojis(title)
        existing_id = self.find_file_in_folder(
            folder_id,
            clean_title,
            "application/vnd.google-apps.spreadsheet",
        )
        if existing_id:
            meta = self.get_spreadsheet_metadata(existing_id)
            url = str(meta.get("spreadsheetUrl") or f"https://docs.google.com/spreadsheets/d/{existing_id}")
            tab_ids = {
                str((s.get("properties") or {}).get("title") or ""): int(
                    (s.get("properties") or {}).get("sheetId") or 0,
                )
                for s in (meta.get("sheets") or [])
                if isinstance(s, dict)
            }
            return existing_id, url, tab_ids

        sheets_body = [{"properties": {"title": strip_emojis(t)}} for t in sheet_titles]
        created = self._execute_with_backoff(
            "sheets",
            "spreadsheets.create",
            self._sheets.spreadsheets().create(
                body={"properties": {"title": clean_title}, "sheets": sheets_body},
            ),
        )
        spreadsheet_id = str((created or {}).get("spreadsheetId") or "")
        url = str(
            (created or {}).get("spreadsheetUrl")
            or f"https://docs.google.com/spreadsheets/d/{spreadsheet_id}",
        )
        self.move_file_to_folder(spreadsheet_id, folder_id)
        tab_ids = {
            str((s.get("properties") or {}).get("title") or ""): int(
                (s.get("properties") or {}).get("sheetId") or 0,
            )
            for s in ((created or {}).get("sheets") or [])
            if isinstance(s, dict)
        }
        return spreadsheet_id, url, tab_ids

    def get_spreadsheet_metadata(self, spreadsheet_id: str) -> dict[str, Any]:
        """Fetch spreadsheet properties, sheets, and protected ranges."""
        data = self._execute_with_backoff(
            "sheets",
            "spreadsheets.get",
            self._sheets.spreadsheets().get(spreadsheetId=spreadsheet_id),
        )
        return data if isinstance(data, dict) else {}

    def batch_update_spreadsheet(self, spreadsheet_id: str, requests: list[dict[str, Any]]) -> None:
        """Apply structural Sheets batchUpdate requests."""
        if not requests:
            return
        self._execute_with_backoff(
            "sheets",
            "spreadsheets.batchUpdate",
            self._sheets.spreadsheets().batchUpdate(
                spreadsheetId=spreadsheet_id,
                body={"requests": requests},
            ),
        )

    def read_sheet_values(self, spreadsheet_id: str, range_a1: str) -> list[list[str]]:
        """Read cell values as strings from range_a1."""
        resp = self._execute_with_backoff(
            "sheets",
            "spreadsheets.values.get",
            self._sheets.spreadsheets()
            .values()
            .get(
                spreadsheetId=spreadsheet_id,
                range=range_a1,
            ),
        )
        raw_rows = (resp or {}).get("values") or []
        return [[str(c) for c in row] for row in raw_rows if isinstance(row, list)]

    def write_sheet_values(
        self,
        spreadsheet_id: str,
        range_a1: str,
        values: list[list[Any]],
    ) -> None:
        """Write emoji-sanitized cell values to range_a1."""
        sanitized = [[_sanitize_cell(cell) for cell in row] for row in values]
        self._execute_with_backoff(
            "sheets",
            "spreadsheets.values.update",
            self._sheets.spreadsheets()
            .values()
            .update(
                spreadsheetId=spreadsheet_id,
                range=range_a1,
                valueInputOption="USER_ENTERED",
                body={"values": sanitized},
            ),
        )

    def append_sheet_rows(
        self,
        spreadsheet_id: str,
        range_a1: str,
        rows: list[list[Any]],
    ) -> None:
        """Append emoji-sanitized rows to a sheet tab."""
        if not rows:
            return
        sanitized = [[_sanitize_cell(cell) for cell in row] for row in rows]
        self._execute_with_backoff(
            "sheets",
            "spreadsheets.values.append",
            self._sheets.spreadsheets()
            .values()
            .append(
                spreadsheetId=spreadsheet_id,
                range=range_a1,
                valueInputOption="USER_ENTERED",
                insertDataOption="INSERT_ROWS",
                body={"values": sanitized},
            ),
        )

    def create_report_doc(self, *, title: str, folder_id: str, content: str) -> tuple[str, str]:
        """Create a Google Doc in folder_id, populate its full text, and return (doc_id, url)."""
        clean_title = strip_emojis(title)
        clean_body = re.sub(r"\r\n?", "\n", strip_emojis(content))
        created = self._execute_with_backoff(
            "docs",
            "documents.create",
            self._docs.documents().create(body={"title": clean_title}),
        )
        doc_id = str((created or {}).get("documentId") or "")
        if clean_body:
            self._execute_with_backoff(
                "docs",
                "documents.batchUpdate",
                self._docs.documents().batchUpdate(
                    documentId=doc_id,
                    body={"requests": [{"insertText": {"location": {"index": 1}, "text": clean_body}}]},
                ),
            )
        self.move_file_to_folder(doc_id, folder_id)
        return doc_id, f"https://docs.google.com/document/d/{doc_id}/edit"

    def read_doc_text(self, doc_id: str) -> str:
        """Read concatenated plain text from a Google Doc."""
        doc = self._execute_with_backoff(
            "docs",
            "documents.get",
            self._docs.documents().get(documentId=doc_id),
        )
        chunks: list[str] = []
        for elem in ((doc or {}).get("body") or {}).get("content") or []:
            para = (elem or {}).get("paragraph")
            if not isinstance(para, dict):
                continue
            for run in para.get("elements") or []:
                txt = str(((run or {}).get("textRun") or {}).get("content") or "")
                if txt:
                    chunks.append(txt)
        return "".join(chunks)
