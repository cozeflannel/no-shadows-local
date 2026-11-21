"""Firestore Native state store, distributed leases, cursors, and Brandwatch rate-limit ledger."""

from __future__ import annotations

import hashlib
import json
import logging
import time
from datetime import UTC, datetime
from typing import Any

from google.api_core.exceptions import GoogleAPICallError
from google.cloud import firestore

from .config import CampaignsConfig
from .logging_utils import log_event
from .models import CampaignRecord, ConversationState, ThreadOwnershipRecord

logger = logging.getLogger(__name__)

BW_WINDOW_SECONDS = 600.0
DEFAULT_BW_CLIENT_LIMIT = 30
CACHE_TTL_SECONDS = 86400.0
# Bytes of cached items per Firestore document. Firestore refuses a document over 1 MiB; the Brandwatch
# query list (120 queries in one part, 1.97 MB) was refused live. JSON size is a bit over Firestore's count.
FIRESTORE_DOC_BUDGET_BYTES = 700_000


def _doc_key(raw: str) -> str:
    """Deterministic URL-safe Firestore document ID from an arbitrary resource name."""
    cleaned = raw.strip().replace("/", "__")
    if len(cleaned) <= 120 and cleaned:
        return cleaned
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _json_size(value: Any) -> int:
    """UTF-8 bytes of value as JSON: about what Firestore counts toward its 1 MiB document limit."""
    return len(json.dumps(value, default=str, ensure_ascii=False).encode("utf-8"))


def _chunks_by_size(items: list[Any], budget: int = FIRESTORE_DOC_BUDGET_BYTES) -> list[list[Any]]:
    """Consecutive runs of items, each about budget bytes at most (a bigger item is a run of its own)."""
    chunks: list[list[Any]] = []
    current: list[Any] = []
    size = 0
    for item in items:
        n = _json_size(item) + 16
        if current and size + n > budget:
            chunks.append(current)
            current, size = [], 0
        current.append(item)
        size += n
    if current:
        chunks.append(current)
    return chunks


class StoreError(RuntimeError):
    """Raised when a Firestore read or write fails."""

    def __init__(self, message: str, *, operation: str) -> None:
        super().__init__(message)
        self.operation = operation


class CampaignStore:
    """Operational store backed by Firestore Native database slrr-social-alerts."""

    def __init__(self, cfg: CampaignsConfig) -> None:
        self._cfg = cfg
        self._db = firestore.Client(project=cfg.gcp_project_id, database=cfg.firestore_database)

    def acquire_lease(self, scope: str, resource_id: str, owner_id: str, ttl_s: float = 110.0) -> bool:
        """Atomically acquire a per-thread or per-campaign lease if unheld or expired."""
        doc_ref = self._db.collection("campaign_leases").document(_doc_key(f"{scope}:{resource_id}"))
        now = time.time()

        @firestore.transactional
        def _txn(transaction: firestore.Transaction) -> bool:
            snap = doc_ref.get(transaction=transaction)
            if snap.exists:
                data = snap.to_dict() or {}
                expires_at = float(data.get("expires_at") or 0.0)
                holder = str(data.get("owner_id") or "")
                if expires_at > now and holder != owner_id:
                    return False
            transaction.set(
                doc_ref,
                {
                    "scope": scope,
                    "resource_id": resource_id,
                    "owner_id": owner_id,
                    "acquired_at": now,
                    "expires_at": now + ttl_s,
                },
            )
            return True

        try:
            txn_result: bool = _txn(self._db.transaction())
            return txn_result
        except GoogleAPICallError as exc:
            log_event(
                logger,
                logging.ERROR,
                "firestore_lease_acquire_failed",
                scope=scope,
                resource_id=resource_id,
                error_type=type(exc).__name__,
            )
            raise StoreError(
                f"Failed to acquire lease for {scope}:{resource_id}: {exc}", operation="lease"
            ) from exc

    def release_lease(self, scope: str, resource_id: str, owner_id: str) -> None:
        """Release a previously acquired lease if still owned by owner_id."""
        doc_ref = self._db.collection("campaign_leases").document(_doc_key(f"{scope}:{resource_id}"))
        try:
            snap = doc_ref.get()
            if snap.exists and str((snap.to_dict() or {}).get("owner_id") or "") == owner_id:
                doc_ref.delete()
        except GoogleAPICallError as exc:
            log_event(
                logger,
                logging.WARNING,
                "firestore_lease_release_failed",
                scope=scope,
                resource_id=resource_id,
                error_type=type(exc).__name__,
            )

    def next_campaign_id(self) -> str:
        """Allocate the next sequential campaign ID (e.g. C1001)."""
        doc_ref = self._db.collection("campaign_sequences").document("campaign_id")

        @firestore.transactional
        def _txn(transaction: firestore.Transaction) -> int:
            snap = doc_ref.get(transaction=transaction)
            current = int((snap.to_dict() or {}).get("value") or 1000) if snap.exists else 1000
            nxt = current + 1
            transaction.set(doc_ref, {"value": nxt, "updated_at": datetime.now(UTC).isoformat()})
            return nxt

        try:
            seq: int = _txn(self._db.transaction())
            return f"C{seq}"
        except GoogleAPICallError as exc:
            log_event(logger, logging.ERROR, "firestore_sequence_failed", error_type=type(exc).__name__)
            raise StoreError(f"Failed to allocate campaign ID: {exc}", operation="next_campaign_id") from exc

    def list_owned_threads(self) -> list[ThreadOwnershipRecord]:
        """List all thread ownership records in the configured alerts space."""
        try:
            snaps = (
                self._db.collection("thread_ownership")
                .where(filter=firestore.FieldFilter("space", "==", self._cfg.alerts_space))
                .stream()
            )
            out: list[ThreadOwnershipRecord] = []
            for snap in snaps:
                data = snap.to_dict() or {}
                out.append(ThreadOwnershipRecord.model_validate(data))
            return out
        except GoogleAPICallError as exc:
            log_event(
                logger, logging.ERROR, "firestore_list_owned_threads_failed", error_type=type(exc).__name__
            )
            raise StoreError(f"Failed to list owned threads: {exc}", operation="list_owned_threads") from exc

    def save_owned_thread(self, record: ThreadOwnershipRecord) -> None:
        """Persist or update a thread ownership record."""
        doc_ref = self._db.collection("thread_ownership").document(_doc_key(record.thread))
        try:
            doc_ref.set(record.model_dump())
        except GoogleAPICallError as exc:
            log_event(
                logger,
                logging.ERROR,
                "firestore_save_owned_thread_failed",
                thread=record.thread,
                error_type=type(exc).__name__,
            )
            raise StoreError(
                f"Failed to save thread ownership: {exc}", operation="save_owned_thread"
            ) from exc

    def is_owned_thread(self, space: str, thread: str) -> bool:
        """Verify that (space, thread) is registered as an owned thread."""
        if space != self._cfg.alerts_space:
            return False
        doc_ref = self._db.collection("thread_ownership").document(_doc_key(thread))
        try:
            snap = doc_ref.get()
            if not snap.exists:
                return False
            data = snap.to_dict() or {}
            return str(data.get("space") or "") == space and str(data.get("thread") or "") == thread
        except GoogleAPICallError as exc:
            raise StoreError(
                f"Failed to verify thread ownership: {exc}", operation="is_owned_thread"
            ) from exc

    def get_conversation(self, thread: str) -> ConversationState | None:
        """Load conversation state for an owned thread."""
        doc_ref = self._db.collection("campaign_conversations").document(_doc_key(thread))
        try:
            snap = doc_ref.get()
            if not snap.exists:
                return None
            return ConversationState.model_validate(snap.to_dict() or {})
        except GoogleAPICallError as exc:
            raise StoreError(
                f"Failed to load conversation for {thread}: {exc}", operation="get_conversation"
            ) from exc

    def save_conversation(self, state: ConversationState) -> None:
        """Persist conversation state for an owned thread."""
        doc_ref = self._db.collection("campaign_conversations").document(_doc_key(state.thread))
        try:
            doc_ref.set(state.model_dump())
        except GoogleAPICallError as exc:
            raise StoreError(
                f"Failed to save conversation for {state.thread}: {exc}",
                operation="save_conversation",
            ) from exc

    def record_created_message(self, message_name: str, space: str, thread: str) -> None:
        """Store the resource name of a message created by slrr-campaigns."""
        doc_ref = self._db.collection("campaign_created_messages").document(_doc_key(message_name))
        try:
            doc_ref.set(
                {
                    "message_name": message_name,
                    "space": space,
                    "thread": thread,
                    "created_at": datetime.now(UTC).isoformat(),
                },
            )
        except GoogleAPICallError as exc:
            raise StoreError(
                f"Failed to record created message {message_name}: {exc}",
                operation="record_created_message",
            ) from exc

    def is_created_message(self, message_name: str) -> bool:
        """Return True if message_name was created by slrr-campaigns."""
        doc_ref = self._db.collection("campaign_created_messages").document(_doc_key(message_name))
        try:
            return bool(doc_ref.get().exists)
        except GoogleAPICallError as exc:
            raise StoreError(
                f"Failed to check created message {message_name}: {exc}",
                operation="is_created_message",
            ) from exc

    def get_cursor(self, cursor_key: str) -> str:
        """Return ISO timestamp cursor for a thread or campaign space, or empty string."""
        doc_ref = self._db.collection("campaign_cursors").document(_doc_key(cursor_key))
        try:
            snap = doc_ref.get()
            if not snap.exists:
                return ""
            return str((snap.to_dict() or {}).get("cursor") or "")
        except GoogleAPICallError as exc:
            raise StoreError(f"Failed to read cursor {cursor_key}: {exc}", operation="get_cursor") from exc

    def set_cursor(self, cursor_key: str, cursor_iso: str) -> None:
        """Advance ISO timestamp cursor for a thread or campaign space."""
        doc_ref = self._db.collection("campaign_cursors").document(_doc_key(cursor_key))
        try:
            doc_ref.set({"cursor": cursor_iso, "updated_at": datetime.now(UTC).isoformat()})
        except GoogleAPICallError as exc:
            raise StoreError(f"Failed to write cursor {cursor_key}: {exc}", operation="set_cursor") from exc

    def save_campaign(self, campaign: CampaignRecord) -> None:
        """Save canonical CampaignRecord."""
        doc_ref = self._db.collection("campaigns").document(campaign.campaign_id)
        try:
            doc_ref.set(campaign.model_dump())
        except GoogleAPICallError as exc:
            raise StoreError(
                f"Failed to save campaign {campaign.campaign_id}: {exc}",
                operation="save_campaign",
            ) from exc

    def get_campaign(self, campaign_id: str) -> CampaignRecord | None:
        """Fetch a single CampaignRecord by campaign_id."""
        doc_ref = self._db.collection("campaigns").document(campaign_id)
        try:
            snap = doc_ref.get()
            if not snap.exists:
                return None
            return CampaignRecord.model_validate(snap.to_dict() or {})
        except GoogleAPICallError as exc:
            raise StoreError(
                f"Failed to get campaign {campaign_id}: {exc}", operation="get_campaign"
            ) from exc

    def list_campaigns(self) -> list[CampaignRecord]:
        """Return all stored campaigns sorted by campaign_id."""
        try:
            snaps = self._db.collection("campaigns").stream()
            items = [CampaignRecord.model_validate(s.to_dict() or {}) for s in snaps]
            items.sort(key=lambda c: c.campaign_id)
            return items
        except GoogleAPICallError as exc:
            raise StoreError(f"Failed to list campaigns: {exc}", operation="list_campaigns") from exc

    def list_console_requests(self) -> list[dict[str, Any]]:
        """Return change requests written by the Agent Console that are still pending, oldest first."""
        try:
            snaps = self._db.collection("campaign_console_requests").where("status", "==", "pending").stream()
            items = [s.to_dict() or {} for s in snaps]
            items.sort(key=lambda r: str(r.get("requested_at") or ""))
            return items
        except GoogleAPICallError as exc:
            raise StoreError(
                f"Failed to list console requests: {exc}", operation="list_console_requests"
            ) from exc

    def finish_console_request(self, request_id: str, *, status: str, result: str) -> None:
        """Record the outcome of one Agent Console change request."""
        try:
            self._db.collection("campaign_console_requests").document(request_id).set(
                {"status": status, "result": result, "finished_at": datetime.now(UTC).isoformat()},
                merge=True,
            )
        except GoogleAPICallError as exc:
            raise StoreError(
                f"Failed to finish console request {request_id}: {exc}",
                operation="finish_console_request",
            ) from exc

    def is_created_space(self, space_name: str) -> bool:
        """Verify that space_name belongs to a campaign provisioned by slrr-campaigns."""
        try:
            snaps = (
                self._db.collection("campaigns")
                .where(filter=firestore.FieldFilter("space_name", "==", space_name))
                .limit(1)
                .stream()
            )
            return any(True for _ in snaps)
        except GoogleAPICallError as exc:
            raise StoreError(
                f"Failed to verify campaign space {space_name}: {exc}",
                operation="is_created_space",
            ) from exc

    def mark_mention_seen(self, campaign_id: str, normalized_url: str) -> bool:
        """Atomically record normalized_url for campaign_id; returns True only on first sighting."""
        doc_ref = self._db.collection("campaign_seen_mentions").document(
            _doc_key(f"{campaign_id}:{normalized_url}"),
        )

        @firestore.transactional
        def _txn(transaction: firestore.Transaction) -> bool:
            snap = doc_ref.get(transaction=transaction)
            if snap.exists:
                return False
            transaction.set(
                doc_ref,
                {
                    "campaign_id": campaign_id,
                    "normalized_url": normalized_url,
                    "first_seen_at": datetime.now(UTC).isoformat(),
                },
            )
            return True

        try:
            created: bool = _txn(self._db.transaction())
            return created
        except GoogleAPICallError as exc:
            raise StoreError(
                f"Failed to dedupe mention {normalized_url} for {campaign_id}: {exc}",
                operation="mark_mention_seen",
            ) from exc

    def get_registry_snapshot(self, campaign_id: str) -> dict[str, str] | None:
        """Read the last-applied editable registry values for campaign_id."""
        doc_ref = self._db.collection("campaign_registry_snapshots").document(campaign_id)
        try:
            snap = doc_ref.get()
            if not snap.exists:
                return None
            raw = (snap.to_dict() or {}).get("editable") or {}
            if not isinstance(raw, dict):
                return None
            return {str(k): str(v) for k, v in raw.items()}
        except GoogleAPICallError as exc:
            raise StoreError(
                f"Failed to read registry snapshot for {campaign_id}: {exc}",
                operation="get_registry_snapshot",
            ) from exc

    def save_registry_snapshot(self, campaign_id: str, editable: dict[str, str]) -> None:
        """Persist the last-applied editable registry values for campaign_id."""
        doc_ref = self._db.collection("campaign_registry_snapshots").document(campaign_id)
        try:
            doc_ref.set({"editable": editable, "updated_at": datetime.now(UTC).isoformat()})
        except GoogleAPICallError as exc:
            raise StoreError(
                f"Failed to save registry snapshot for {campaign_id}: {exc}",
                operation="save_registry_snapshot",
            ) from exc

    def reserve_brandwatch_slot(self) -> float:
        """Reserve one Brandwatch call slot using <= 50% of the client's rolling 10-minute limit.

        Returns 0.0 if a slot was reserved immediately, or the positive wait_seconds until
        the window frees.
        """
        doc_ref = self._db.collection("brandwatch_rate_limit").document("client_ledger")
        now = time.time()

        @firestore.transactional
        def _txn(transaction: firestore.Transaction) -> float:
            snap = doc_ref.get(transaction=transaction)
            data = snap.to_dict() or {} if snap.exists else {}
            client_limit = int(data.get("client_limit") or DEFAULT_BW_CLIENT_LIMIT)
            budget = max(1, client_limit // 2)
            blocked_until = float(data.get("blocked_until") or 0.0)
            if blocked_until > now:
                return blocked_until - now

            raw_ts = data.get("call_timestamps") or []
            recent = sorted(float(t) for t in raw_ts if now - float(t) < BW_WINDOW_SECONDS)
            header_used = int(data.get("header_used") or 0)
            header_recorded_at = float(data.get("header_recorded_at") or 0.0)

            if len(recent) >= budget:
                return max(1.0, (recent[0] + BW_WINDOW_SECONDS) - now)

            recent.append(now)
            transaction.set(
                doc_ref,
                {
                    "client_limit": client_limit,
                    "call_timestamps": recent,
                    "header_used": header_used,
                    "header_recorded_at": header_recorded_at,
                    "blocked_until": blocked_until,
                    "updated_at": now,
                },
            )
            return 0.0

        try:
            wait_seconds: float = _txn(self._db.transaction())
            return wait_seconds
        except GoogleAPICallError as exc:
            raise StoreError(
                f"Failed to reserve Brandwatch rate-limit slot: {exc}",
                operation="reserve_brandwatch_slot",
            ) from exc

    def update_brandwatch_rate_headers(
        self,
        *,
        client_limit: int | None,
        client_used: int | None,
        retry_after_seconds: float = 0.0,
    ) -> None:
        """Record x-rate-limit / x-rate-limit-used headers and any 429 cooldown window."""
        doc_ref = self._db.collection("brandwatch_rate_limit").document("client_ledger")
        now = time.time()

        @firestore.transactional
        def _txn(transaction: firestore.Transaction) -> None:
            snap = doc_ref.get(transaction=transaction)
            data = snap.to_dict() or {} if snap.exists else {}
            new_limit = (
                client_limit
                if client_limit and client_limit > 0
                else int(
                    data.get("client_limit") or DEFAULT_BW_CLIENT_LIMIT,
                )
            )
            new_used = (
                client_used
                if client_used is not None and client_used >= 0
                else int(
                    data.get("header_used") or 0,
                )
            )
            blocked_until = float(data.get("blocked_until") or 0.0)
            if retry_after_seconds > 0:
                blocked_until = max(blocked_until, now + retry_after_seconds)
            elif client_used is not None and new_used >= max(1, new_limit - 5):
                blocked_until = max(blocked_until, now + 15.0)
            raw_ts = data.get("call_timestamps") or []
            recent = [float(t) for t in raw_ts if now - float(t) < BW_WINDOW_SECONDS]
            transaction.set(
                doc_ref,
                {
                    "client_limit": new_limit,
                    "call_timestamps": recent,
                    "header_used": new_used,
                    "header_recorded_at": now,
                    "blocked_until": blocked_until,
                    "updated_at": now,
                },
            )

        try:
            _txn(self._db.transaction())
        except GoogleAPICallError as exc:
            log_event(
                logger,
                logging.WARNING,
                "brandwatch_rate_header_save_failed",
                error_type=type(exc).__name__,
            )

    def get_bw_cache(self, cache_key: str, max_age_s: float = CACHE_TTL_SECONDS) -> Any | None:
        """Read a cached Brandwatch metadata payload if younger than max_age_s."""
        base_id = _doc_key(cache_key)
        doc_ref = self._db.collection("brandwatch_cache").document(base_id)
        try:
            snap = doc_ref.get()
            if not snap.exists:
                return None
            data = snap.to_dict() or {}
            cached_at = float(data.get("cached_at") or 0.0)
            if time.time() - cached_at > max_age_s:
                return None
            chunk_count = int(data.get("chunk_count") or 0)
            if chunk_count > 0:
                combined: list[Any] = []
                for idx in range(chunk_count):
                    c_snap = self._db.collection("brandwatch_cache").document(f"{base_id}__p{idx}").get()
                    if not c_snap.exists:
                        return None
                    c_items = (c_snap.to_dict() or {}).get("items")
                    if not isinstance(c_items, list):
                        return None
                    combined.extend(c_items)
                return combined
            return data.get("payload")
        except GoogleAPICallError as exc:
            raise StoreError(
                f"Failed to read Brandwatch cache {cache_key}: {exc}", operation="get_bw_cache"
            ) from exc

    def set_bw_cache(self, cache_key: str, payload: Any) -> None:
        """Write a Brandwatch metadata payload into the 24-hour Firestore cache.

        A list too big for one document is written in parts of about FIRESTORE_DOC_BUDGET_BYTES each,
        then the entry naming them (removed first, so no read ever mixes old and new parts). The cache
        only saves Brandwatch calls: a write Firestore refuses leaves no entry (the next read fetches
        again) and the caller, which has the payload already, goes on.
        """
        base_id = _doc_key(cache_key)
        coll = self._db.collection("brandwatch_cache")
        doc_ref = coll.document(base_id)
        now_ts = time.time()
        now_iso = datetime.now(UTC).isoformat()
        try:
            prev_snap = doc_ref.get()
            prev_chunks = int((prev_snap.to_dict() or {}).get("chunk_count") or 0) if prev_snap.exists else 0
            if isinstance(payload, list) and _json_size(payload) > FIRESTORE_DOC_BUDGET_BYTES:
                chunks = _chunks_by_size(payload)
                doc_ref.delete()
                for idx, chunk in enumerate(chunks):
                    part = {"cache_key": cache_key, "part": idx, "items": chunk}
                    coll.document(f"{base_id}__p{idx}").set(part)
                doc_ref.set(
                    {
                        "cache_key": cache_key,
                        "cached_at": now_ts,
                        "updated_at_iso": now_iso,
                        "chunk_count": len(chunks),
                    },
                )
                for stale_idx in range(len(chunks), prev_chunks):
                    coll.document(f"{base_id}__p{stale_idx}").delete()
            else:
                doc_ref.set(
                    {
                        "cache_key": cache_key,
                        "cached_at": now_ts,
                        "updated_at_iso": now_iso,
                        "chunk_count": 0,
                        "payload": payload,
                    },
                )
                for stale_idx in range(prev_chunks):
                    coll.document(f"{base_id}__p{stale_idx}").delete()
        except GoogleAPICallError as exc:
            log_event(
                logger,
                logging.WARNING,
                "brandwatch_cache_write_failed",
                cache_key=cache_key,
                error_type=type(exc).__name__,
                error_message=str(exc)[:300],
            )
            try:
                doc_ref.delete()
            except GoogleAPICallError as del_exc:
                log_event(
                    logger,
                    logging.WARNING,
                    "brandwatch_cache_entry_left",
                    cache_key=cache_key,
                    error_type=type(del_exc).__name__,
                )

    def delete_test_documents(self, *, message_names: list[str]) -> None:
        """Clean up created-message records generated during live tests."""
        for name in message_names:
            doc_ref = self._db.collection("campaign_created_messages").document(_doc_key(name))
            try:
                doc_ref.delete()
            except GoogleAPICallError as exc:
                log_event(
                    logger, logging.WARNING, "cleanup_message_doc_failed", error_type=type(exc).__name__
                )
