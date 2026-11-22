"""Agent Console API + static frontend (docs/CONTRACTS.md §17).

Run locally:
    TRIAGE_LOCAL_DB=.local/demo.db TRIAGE_LLM=fake .venv/bin/python -m uvicorn console.backend.app:app --reload

The built frontend (console/frontend/dist) is served at "/" with an SPA fallback; every
API route lives under /api.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from triage_agent import __version__ as agent_version
from triage_agent.config import switch_title
from triage_agent.context import AgentContext
from triage_agent.events import EventType, PlatformEvent
from triage_agent.metrics import KPI_DEFINITIONS
from triage_agent.models import CaseStatus
from triage_agent.operations import registered_operations
from triage_agent.render import FIELD_LABELS

from . import (
    chat_signin, connections, gmail_oauth, help_content, live, routes_admin, routes_cases, routes_insight, routes_learning, routes_metrics, routes_rosters, routes_routing,
    routes_settings, routes_work,
)
from .audit_mw import audit_requests
from .auth import User, current_user, get_ctx, require_viewer
from .state import ConsoleState

log = logging.getLogger(__name__)

DEFAULT_DIST = Path(__file__).resolve().parent.parent / "frontend" / "dist"


def _dist_dir() -> Path:
    return Path(os.environ.get("TRIAGE_CONSOLE_DIST") or DEFAULT_DIST).resolve()


def _error_body(detail: Any, status: int) -> dict[str, Any]:
    if isinstance(detail, dict):
        body = dict(detail)
        body.setdefault("error", "Request failed")
        body.setdefault("code", str(status))
        return body
    return {"error": str(detail) if detail else "Request failed", "code": str(status)}


def create_app(ctx: AgentContext | None = None, state: ConsoleState | None = None) -> FastAPI:
    """App factory. Tests pass a ready AgentContext; uvicorn builds one from env on first request."""
    app = FastAPI(title="SLRR Triage Agent Console", version=agent_version, docs_url="/api/docs", openapi_url="/api/openapi.json", redoc_url=None)
    app.state.console = state or ConsoleState(ctx=ctx)
    app.add_middleware(GZipMiddleware, minimum_size=2048)  # list endpoints return a few hundred KB of JSON
    app.middleware("http")(audit_requests)  # every change made through the Console is recorded

    @app.exception_handler(StarletteHTTPException)
    async def http_error(request: Request, exc: StarletteHTTPException) -> JSONResponse:
        return JSONResponse(_error_body(exc.detail, exc.status_code), status_code=exc.status_code, headers=getattr(exc, "headers", None))

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
        errors = [{"loc": [x for x in e.get("loc", ()) if x != "body"], "msg": e.get("msg", "invalid"), "type": e.get("type", "")}
                  for e in exc.errors()]
        first = errors[0] if errors else {"loc": [], "msg": "invalid request"}
        where = ".".join(str(x) for x in first["loc"])
        return JSONResponse({"error": f"Invalid request: {where + ': ' if where else ''}{first['msg']}", "code": "validation_error", "errors": errors},
                            status_code=422)

    # -- identity + metadata --------------------------------------------------
    @app.get("/api/health", tags=["meta"])
    def health() -> dict[str, Any]:
        """Unauthenticated liveness probe (Cloud Run); no data beyond versions."""
        return {"ok": True, "version": agent_version}

    @app.get("/api/me", tags=["meta"])
    def me(ctx: AgentContext = Depends(get_ctx), user: User = Depends(current_user)) -> dict[str, Any]:
        cfg = ctx.config
        return {
            **user.as_dict(),
            "env": cfg.env,
            "config_version": ctx.config_version,
            "timezone": cfg.timezone,
            "agent": cfg.agent.model_dump(mode="json"),
            "dev_mode": user.via == "dev",
            "flags": cfg.platform.flags.model_dump(),
        }

    @app.get("/api/meta", tags=["meta"])
    def meta(ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_viewer)) -> dict[str, Any]:
        cfg = ctx.config
        try:
            ops = registered_operations()
        except Exception:  # noqa: BLE001
            log.warning("operation registry failed to load", exc_info=True)
            ops = []
        return {
            "env": cfg.env,
            "timezone": cfg.timezone,
            "case_id_prefix": cfg.case_id_prefix,
            "escalation_id_prefix": cfg.escalation_id_prefix,
            "event_types": sorted([*EventType.all(), *PlatformEvent.all()]),
            "flags": cfg.platform.flags.model_dump(),
            "switch_names": {name: switch_title(name) for name in type(cfg.platform.flags).model_fields},
            "notifications": {"enabled": cfg.platform.flags.alert_popups, "event_types": cfg.platform.notifications.popup_event_types,
                              "sources": cfg.platform.notifications.popup_sources, "seconds": cfg.platform.notifications.popup_seconds,
                              "max_on_screen": cfg.platform.notifications.max_on_screen},
            "spaces": [{"key": s.key, "name": s.display_name, "configured": bool(s.space_id or s.url)} for s in cfg.spaces],
            "statuses": [s.value for s in CaseStatus],
            "sources": ["burson_chat", "inhouse", "watchdog", "manual"],
            "tracks": ["URGENT", "HIGH_ENGAGEMENT"],
            "priorities": ["P0", "P1", "P2"],
            "kpi_groups": routes_metrics.KPI_GROUPS,
            "kpi_definitions": routes_metrics.kpi_definitions(),
            "actions": [a.model_dump(mode="json") for a in cfg.actions],
            "fields": [
                {"name": f.name, "label": FIELD_LABELS.get(f.name, f.name.replace("_", " ").title()), "type": f.type,
                 "allowed": f.allowed, "correctable": f.correctable, "required": f.required, "description": f.description}
                for f in cfg.alert_template.fields
            ],
            "field_labels": FIELD_LABELS,
            "exposure_tags": [{"name": t.name, "priority": t.priority, "category": t.category} for t in cfg.collection.exposure_tags],
            "sensitive_topics": [t.name for t in cfg.collection.sensitive_topics],
            "products": [p.name for p in cfg.distribution.products if not p.deprecated],
            "platform_tiers": [t.model_dump(mode="json") for t in cfg.collection.platform_tiers],
            "operations": ops,
            "rosters": [{"name": k, **v} for k, v in routes_rosters.ROSTERS.items()],
            "kpi_count": len(KPI_DEFINITIONS),
        }

    @app.get("/api/help", tags=["meta"])
    def help_topics(user: User = Depends(require_viewer)) -> dict[str, Any]:
        """Help pages: how to use each page and setting."""
        return {"topics": help_content.topics()}

    for module in (routes_metrics, routes_cases, routes_rosters, routes_admin, routes_settings, routes_learning, gmail_oauth, live,
                   routes_work, routes_insight, connections, chat_signin, routes_routing):
        app.include_router(module.router)

    # -- static frontend (SPA) -------------------------------------------------
    @app.get("/{full_path:path}", include_in_schema=False)
    def spa(full_path: str) -> Any:
        if full_path == "api" or full_path.startswith("api/"):
            raise HTTPException(404, {"error": f"Unknown API route /{full_path}", "code": "not_found"})
        dist = _dist_dir()
        if full_path:
            candidate = (dist / full_path).resolve()
            if candidate.is_file() and dist in candidate.parents:
                cache = "public, max-age=31536000, immutable" if "/assets/" in f"/{full_path}" else "no-cache"
                return FileResponse(candidate, headers={"Cache-Control": cache})
            if full_path.startswith("assets/"):
                raise HTTPException(404, {"error": f"Unknown asset /{full_path} (reload the page)", "code": "not_found"})
        index = dist / "index.html"
        if index.is_file():
            return FileResponse(index, headers={"Cache-Control": "no-cache"})
        return HTMLResponse(
            "<!doctype html><title>Agent Console</title><body style='font-family:sans-serif;padding:2rem'>"
            "<h1>Agent Console API is running</h1><p>The frontend isn't built yet: run "
            "<code>npm install &amp;&amp; npm run build</code> in <code>console/frontend</code>, or use the Vite dev server "
            "(<code>npm run dev</code>). API docs: <a href='/api/docs'>/api/docs</a>.</p></body>",
            status_code=200,
        )

    return app


app = create_app()
