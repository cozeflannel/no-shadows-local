"""Audit every change made through the Console API.

Each request that can change something (anything but GET / HEAD / OPTIONS under /api) is recorded with who made it,
which route, and how it ended. Routes that describe their own change in more detail (settings, secrets, BigQuery,
operations) add their own entry as well; this one is the floor, so nothing done in the Console goes unrecorded.
"""

from __future__ import annotations

import logging
import time
from typing import Any, Awaitable, Callable

from fastapi import Request, Response

from triage_agent import audit, telemetry

from .auth import request_identity

log = logging.getLogger(__name__)
SKIP = ("/api/pubsub/", "/api/chat-webhook")


async def audit_requests(request: Request, call_next: Callable[[Request], Awaitable[Response]]) -> Response:
    path = request.url.path
    mutating = request.method not in ("GET", "HEAD", "OPTIONS") and path.startswith("/api/") and not path.startswith(SKIP)
    started = time.monotonic()
    with telemetry.span(f"http {request.method}", path=path, method=request.method) as info:
        response = await call_next(request)
        info["status"] = response.status_code
    if not mutating:
        return response
    try:
        actor: Any = None
        try:
            actor, _ = request_identity(request)
        except Exception:  # noqa: BLE001 - an unauthenticated attempt is still recorded
            actor = None
        route = request.scope.get("route")
        template = getattr(route, "path", path)
        status = "ok" if response.status_code < 400 else ("denied" if response.status_code in (401, 403) else "error")
        ctx = request.app.state.console.ctx
        audit.record(
            ctx, actor=actor or "unauthenticated", action=f"api.{request.method.lower()} {template}", surface="console",
            target_type="api", target_id=path[:200], status=status,
            summary=f"{request.method} {path} → {response.status_code}",
            detail={"params": dict(request.path_params), "ms": int((time.monotonic() - started) * 1000)})
    except Exception:  # noqa: BLE001 - never fail the request over its audit entry
        log.exception("could not audit %s %s", request.method, path)
    return response
