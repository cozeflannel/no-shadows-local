"""Campaigns in the Console: see every Brandwatch alert campaign and ask the campaigns service to change one.

The campaigns service (slrr_campaigns) owns its state in Firestore and applies every change through one mutation
path (apply_campaign_mutation: Registry sheet edits and Chat commands). The Console adds a third way in: it writes a
change request to `campaign_console_requests`; the service applies it on its next tick under the campaign's lease
and writes the result back. The Console never touches Brandwatch, the campaign's space or its sheet itself.

Local backend: the same collections in the local store.
"""

from __future__ import annotations

import logging
import os
import uuid
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any

from .events import PlatformEvent

if TYPE_CHECKING:  # pragma: no cover
    from .context import AgentContext

log = logging.getLogger(__name__)

CAMPAIGNS = "campaigns"
REQUESTS = "campaign_console_requests"
# What a request may change: the campaign's editable settings (the Registry tab's editable columns) and one action.
EDITABLE = ("space_display_name", "end_time", "threshold", "sentiment", "platforms", "post_types", "daily_cap",
            "also_post_in_alerts_space", "action")
ACTIONS = ("shut down now",)


class _Docs:
    """The two collections, in the campaigns service's Firestore database (GCP) or the local store."""

    def __init__(self, ctx: "AgentContext"):
        self.ctx = ctx
        self.db: Any = None
        if os.environ.get("TRIAGE_BACKEND", "local") == "gcp":
            cfg = ctx.config.platform
            if not cfg.campaigns.firestore_database:
                raise RuntimeError("Set the campaigns database first (Settings → Campaigns → Firestore database).")
            from google.cloud import firestore

            project = (cfg.campaigns.firestore_project or cfg.gcp.project or os.environ.get("TRIAGE_PROJECT_ID")
                       or os.environ.get("GOOGLE_CLOUD_PROJECT") or None)
            self.db = firestore.Client(project=project, database=cfg.campaigns.firestore_database)

    def list(self, collection: str, limit: int = 500) -> list[dict[str, Any]]:
        if self.db is None:
            return self.ctx.store.list_docs(collection, limit=limit)
        return [d.to_dict() or {} for d in self.db.collection(collection).limit(limit).stream()]

    def get(self, collection: str, doc_id: str) -> dict[str, Any] | None:
        if self.db is None:
            return self.ctx.store.get_doc(collection, doc_id)
        snap = self.db.collection(collection).document(doc_id).get()
        return snap.to_dict() if snap.exists else None

    def put(self, collection: str, doc_id: str, data: dict[str, Any]) -> None:
        if self.db is None:
            self.ctx.store.put_doc(collection, doc_id, data)
        else:
            self.db.collection(collection).document(doc_id).set(data)


def list_campaigns(ctx: "AgentContext") -> list[dict[str, Any]]:
    rows = _Docs(ctx).list(CAMPAIGNS)
    rows.sort(key=lambda c: str(c.get("created_at_utc") or ""), reverse=True)
    return rows


def get_campaign(ctx: "AgentContext", campaign_id: str) -> dict[str, Any] | None:
    return _Docs(ctx).get(CAMPAIGNS, campaign_id)


def list_requests(ctx: "AgentContext", campaign_id: str | None = None) -> list[dict[str, Any]]:
    rows = [r for r in _Docs(ctx).list(REQUESTS) if not campaign_id or r.get("campaign_id") == campaign_id]
    rows.sort(key=lambda r: str(r.get("requested_at") or ""), reverse=True)
    return rows


def request_change(ctx: "AgentContext", *, campaign_id: str, changes: dict[str, Any], actor: str) -> dict[str, Any]:
    """Ask the campaigns service to change a campaign. Applied on its next tick; the result is written back."""
    from . import audit

    if not ctx.flag("campaigns"):
        raise PermissionError("Changing campaigns from the Console is switched off (Feature flags → campaigns).")
    docs = _Docs(ctx)
    campaign = docs.get(CAMPAIGNS, campaign_id)
    if campaign is None:
        raise KeyError(campaign_id)
    if str(campaign.get("status") or "").lower() == "closed":
        raise ValueError("This campaign is closed.")
    clean = {k: str(v).strip() for k, v in changes.items() if k in EDITABLE and str(v).strip() != ""}
    unknown = sorted(set(changes) - set(EDITABLE))
    if unknown:
        raise ValueError(f"These can't be changed here: {', '.join(unknown)}.")
    if "action" in clean and clean["action"].lower() not in ACTIONS:
        raise ValueError(f"The only action is: {', '.join(ACTIONS)}.")
    if not clean:
        raise ValueError("Nothing to change.")
    request = {"request_id": f"CR-{uuid.uuid4().hex[:12]}", "campaign_id": campaign_id, "changes": clean, "requested_by": actor,
               "requested_at": datetime.now(timezone.utc).isoformat(), "status": "pending", "result": ""}
    docs.put(REQUESTS, request["request_id"], request)
    ctx.emit(PlatformEvent.CAMPAIGN_SAVED, actor=actor, space="console",
             payload={"campaign_id": campaign_id, "request_id": request["request_id"], "changes": sorted(clean)})
    audit.record(ctx, actor=actor, action="campaign.request_change", surface="console", target_type="campaign", target_id=campaign_id,
                 summary=f"Asked to change {campaign_id}: {', '.join(f'{k}={v}' for k, v in clean.items())}"[:400])
    return request
