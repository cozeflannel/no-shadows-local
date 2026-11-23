"""Post velocity & 7-day trajectory API routes (`/api/velocity`).

Works both on the dedicated Post velocity page and inline inside Review feed, Cases, Stories, Early Detection and
Temp check (`POST /api/velocity/lookup` batches all visible cases/URLs in one call). On-demand checks by an analyst
always work even while the background polling switch `velocity_tracking` is OFF.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from triage_agent import velocity
from triage_agent.context import AgentContext

from .auth import User, get_ctx, require_admin, require_analyst, require_viewer

router = APIRouter(prefix="/api/velocity", tags=["velocity"])


class TrackIn(BaseModel):
    url: str = ""
    case_id: str = ""
    poll: bool = True
    watch: bool = False


class WatchIn(BaseModel):
    watch: bool = True


class LookupIn(BaseModel):
    case_ids: list[str] = Field(default_factory=list)
    urls: list[str] = Field(default_factory=list)


class LegacyImportIn(BaseModel):
    dry_run: bool = True
    payload: dict[str, Any] | None = None


@router.get("")
def get_velocity(
    sort: str = Query("peak"),
    tier: str = Query(""),
    platform: str = Query(""),
    q: str = Query(""),
    watched: bool = Query(False),
    ctx: AgentContext = Depends(get_ctx),
    user: User = Depends(require_viewer),
) -> dict[str, Any]:
    return {
        **velocity.list_posts(ctx, sort=sort, tier=tier, platform=platform, q=q, watched_only=watched, viewer=user.email),
        "can_edit": user.role in ("analyst", "im", "lead", "admin"),
        "is_admin": user.role == "admin",
    }


@router.post("/lookup")
def batch_lookup(
    body: LookupIn,
    ctx: AgentContext = Depends(get_ctx),
    user: User = Depends(require_viewer),
) -> dict[str, Any]:
    return velocity.lookup_batch(ctx, case_ids=body.case_ids, urls=body.urls, viewer=user.email)


@router.post("/track")
def track_post(
    body: TrackIn,
    ctx: AgentContext = Depends(get_ctx),
    user: User = Depends(require_analyst),
) -> dict[str, Any]:
    try:
        post = velocity.track_post(ctx, url=body.url, case_id=body.case_id, actor=user.email, poll=body.poll, watch=body.watch)
    except ValueError as exc:
        raise HTTPException(422, {"error": str(exc), "code": "invalid_post_url"}) from exc
    return {"post": post}


@router.get("/compare")
def compare_posts(
    keys: str = Query(..., description="Comma-separated velocity post keys (2 to 6)."),
    window: int = Query(168),
    ctx: AgentContext = Depends(get_ctx),
    user: User = Depends(require_viewer),
) -> dict[str, Any]:
    parsed = [k.strip() for k in keys.split(",") if k.strip()]
    if len(parsed) < 2:
        raise HTTPException(422, {"error": "Pick at least two posts to compare side by side.", "code": "too_few_posts"})
    return velocity.compare_posts(ctx, parsed, window_hours=window, viewer=user.email)


@router.get("/posts/{post_key}")
def post_detail(
    post_key: str,
    ctx: AgentContext = Depends(get_ctx),
    user: User = Depends(require_viewer),
) -> dict[str, Any]:
    try:
        return velocity.get_detail(ctx, post_key, viewer=user.email)
    except KeyError as exc:
        raise HTTPException(404, {"error": "That post is not being tracked.", "code": "not_found"}) from exc


@router.post("/posts/{post_key}/refresh")
def refresh_post(
    post_key: str,
    ctx: AgentContext = Depends(get_ctx),
    user: User = Depends(require_analyst),
) -> dict[str, Any]:
    doc = ctx.store.get_doc(velocity.POSTS, post_key)
    if not doc:
        raise HTTPException(404, {"error": "That post is not being tracked.", "code": "not_found"})
    velocity.poll_one(ctx, doc, force=True, emit_alerts=False)
    return velocity.get_detail(ctx, post_key, viewer=user.email)


@router.post("/refresh")
def refresh_all(
    ctx: AgentContext = Depends(get_ctx),
    user: User = Depends(require_analyst),
) -> dict[str, Any]:
    return velocity.refresh_due(ctx, force_all=True, max_posts=16, emit_alerts=False)


@router.post("/posts/{post_key}/watch")
def watch_post(
    post_key: str,
    body: WatchIn,
    ctx: AgentContext = Depends(get_ctx),
    user: User = Depends(require_analyst),
) -> dict[str, Any]:
    try:
        return {"post": velocity.set_watch(ctx, post_key, actor=user.email, watch=body.watch)}
    except KeyError as exc:
        raise HTTPException(404, {"error": "That post is not being tracked.", "code": "not_found"}) from exc


@router.delete("/posts/{post_key}")
def remove_post(
    post_key: str,
    ctx: AgentContext = Depends(get_ctx),
    user: User = Depends(require_analyst),
) -> dict[str, Any]:
    try:
        velocity.delete_post(ctx, post_key, actor=user.email)
    except KeyError as exc:
        raise HTTPException(404, {"error": "That post is not being tracked.", "code": "not_found"}) from exc
    return {"ok": True}


@router.post("/import-legacy")
def import_legacy(
    body: LegacyImportIn,
    ctx: AgentContext = Depends(get_ctx),
    user: User = Depends(require_admin),
) -> dict[str, Any]:
    try:
        if body.payload is not None:
            return velocity.import_legacy_payload(ctx, body.payload, dry_run=body.dry_run, actor=user.email)
        return velocity.import_legacy_gcs(ctx, dry_run=body.dry_run, actor=user.email)
    except PermissionError as exc:
        raise HTTPException(403, {"error": str(exc), "code": "storage_denied"}) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, {"error": str(exc)[:300], "code": "import_failed"}) from exc
