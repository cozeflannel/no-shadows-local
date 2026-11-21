"""Worker service: Pub/Sub push deliveries and scheduled jobs.

A second Cloud Run service from the Console's image, without IAP. Every request must carry a Google-signed
identity token: Pub/Sub pushes sign as the push service account set in Settings → Delivery, Cloud Scheduler signs
as the scheduler's service account. Anything else is refused.

    POST /pubsub/outbound       one outbound action (delivered once; a failure makes Pub/Sub retry)
    POST /pubsub/dead-letter    an action Pub/Sub gave up on (recorded for the Console)
    POST /jobs/{name}           followups | inhouse | knowledge | forecast | watches | temp-checks | maintenance
"""

from __future__ import annotations

import logging
import os
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Request

from triage_agent import pubsub, telemetry
from triage_agent.context import AgentContext, build_context
from triage_agent.operations import handle

log = logging.getLogger(__name__)

JOB_OPS: dict[str, tuple[str, dict[str, Any]]] = {
    "followups": ("run_followups", {}),
    "inhouse": ("ingest_inhouse", {}),
    "knowledge": ("refresh_knowledge", {}),
    "forecast": ("run_forecast", {}),
    "watches": ("run_watches", {}),
}

app = FastAPI(title="Triage Agent worker", docs_url=None, redoc_url=None, openapi_url=None)
_state: dict[str, AgentContext] = {}


def get_ctx() -> AgentContext:
    ctx = _state.get("ctx")
    if ctx is None:
        ctx = _state["ctx"] = build_context()
    ctx.maybe_reload()
    return ctx


def verify_caller(request: Request, ctx: AgentContext = Depends(get_ctx)) -> str:
    """The service account behind the request's identity token. Local backend: no token is needed."""
    if os.environ.get("TRIAGE_BACKEND", "local") != "gcp" and not os.environ.get("K_SERVICE"):
        return "local"
    header = request.headers.get("Authorization", "")
    if not header.lower().startswith("bearer "):
        raise HTTPException(401, {"error": "A signed identity token is required.", "code": "unauthenticated"})
    from google.auth.transport import requests as ga_requests
    from google.oauth2 import id_token

    ps = ctx.config.platform.pubsub
    audience = ps.push_audience or ps.worker_url.rstrip("/") or None
    try:
        claims = id_token.verify_oauth2_token(header.split(" ", 1)[1], ga_requests.Request(), audience=audience)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(401, {"error": f"Invalid identity token: {exc}", "code": "unauthenticated"}) from exc
    email = str(claims.get("email") or "").lower()
    allowed = {e.strip().lower() for e in (ps.push_service_account, os.environ.get("TRIAGE_SCHEDULER_SA", "")) if e.strip()}
    if not claims.get("email_verified") or not allowed or email not in allowed:
        raise HTTPException(403, {"error": "This identity may not call the worker.", "code": "forbidden"})
    return email


@app.get("/health")
def health() -> dict[str, Any]:
    return {"ok": True}


@app.post("/pubsub/outbound")
async def outbound(request: Request, caller: str = Depends(verify_caller), ctx: AgentContext = Depends(get_ctx)) -> dict[str, Any]:
    body = await request.json()
    try:
        action, attempt, message_id = pubsub.decode_push(body)
    except Exception as exc:  # noqa: BLE001 - a message that can't be read is acknowledged so it isn't redelivered forever
        log.error("unreadable push message: %s", exc)
        ctx.audit(actor="pubsub", action="outbound.unreadable", surface="pubsub", target_type="outbound", status="error",
                  summary=f"A push message could not be read: {exc}"[:300])
        return {"ok": False, "acknowledged": True}
    with telemetry.span("pubsub.outbound", kind=action.kind, attempt=attempt):
        try:
            state = pubsub.deliver(ctx, action, delivery_attempt=attempt, message_id=message_id)
        except Exception as exc:  # noqa: BLE001 - non-2xx: Pub/Sub retries, then dead-letters
            raise HTTPException(500, {"error": str(exc)[:300], "code": "delivery_failed"}) from exc
    return {"ok": True, "status": state.status}


@app.post("/pubsub/dead-letter")
async def dead_letter(request: Request, caller: str = Depends(verify_caller), ctx: AgentContext = Depends(get_ctx)) -> dict[str, Any]:
    body = await request.json()
    try:
        action, attempt, message_id = pubsub.decode_push(body)
    except Exception as exc:  # noqa: BLE001
        log.error("unreadable dead letter: %s", exc)
        return {"ok": False, "acknowledged": True}
    pubsub.record_dead_letter(ctx, action, delivery_attempt=attempt, message_id=message_id)
    return {"ok": True}


def run_job(ctx: AgentContext, name: str) -> dict[str, Any]:
    """One scheduled job by name. Used by the worker's /jobs route and by `python -m jobs.run_job`."""
    from triage_agent import tempcheck, workforce

    if name in JOB_OPS:
        op, payload = JOB_OPS[name]
        resp = handle({"op": op, "payload": payload, "context": {"deliver": "outbox", "flow": "job", "invoked_by": f"job:{name}"}}, ctx)
        out: dict[str, Any] = {"ok": resp.ok and not (resp.data or {}).get("failed_steps"), "op": op,
                               "summary": resp.outputs.get("summary"), "error": resp.error, "data": resp.data}
        if name == "forecast" and resp.ok:
            out["gap_alerts"] = workforce.check_gap_alerts(ctx)
        return out
    if name == "temp-checks":
        return {"ok": True, **tempcheck.auto_run(ctx)}
    if name == "maintenance":
        results = {n: run_job(ctx, n) for n in ("knowledge", "watches", "temp-checks", "forecast")}
        return {"ok": all(r.get("ok", True) for r in results.values()), "jobs": results}
    raise KeyError(name)


JOB_NAMES = sorted([*JOB_OPS, "temp-checks", "maintenance"])


@app.post("/jobs/{name}")
def job(name: str, caller: str = Depends(verify_caller), ctx: AgentContext = Depends(get_ctx)) -> dict[str, Any]:
    try:
        with telemetry.span("job", job=name):
            result = run_job(ctx, name)
    except KeyError as exc:
        raise HTTPException(404, {"error": f"Unknown job '{name}'. Jobs: {', '.join(JOB_NAMES)}", "code": "not_found"}) from exc
    if not result.get("ok", True):
        raise HTTPException(500, {"error": result.get("error") or "the job reported a failure", "code": "job_failed", "result": result})
    return result
