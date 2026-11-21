"""Single entry point for every operation.

Callers:
  * Workspace Studio custom steps -> Agent Engine `query(op=..., payload=...)`
  * Agent Console backend          -> handle(...) with context.deliver="outbox"
  * jobs (Cloud Run)               -> handle(...) with context.deliver="outbox"
  * tests / evals / local simulator

Handlers register with @operation("<name>") and return ChatOutputs (or a
(ChatOutputs, data) tuple). This module turns them into an OperationResponse
whose `outputs` always contains every key in STUDIO_OUTPUT_KEYS, so Studio
flows can rely on the has_* flags existing even on errors.

Delivery rules applied here (handlers never need to care):
  * deliver="outbox": every chat output is queued (doorbell rings) and
    `outputs` only carries ids/verdict/summary.
  * deliver="return" with context.targets set: outputs for targets the calling
    flow has no post step for are queued instead of being dropped.
  * stealth (config burson_feedback.silent_in_burson_space, or the
    TRIAGE_STEALTH_BURSON env override set by the deploy scripts): burson_text is
    never emitted; it is appended to clean_text with a "[STEALTH …]" label.

Retry policy: a failure in one of the ENTRY_OPS (a Studio delivery) is reported
`retryable=true` unless the payload itself is invalid. Nothing is cached on
failure and the idempotency claim is released, so Studio's retry is safe, and a
transient Firestore/BigQuery/Gemini error can't silently drop an alert.
"""

import importlib
import logging
import os
import traceback
from typing import Any, Callable

from pydantic import BaseModel, ValidationError

from .context import AgentContext, build_context
from .events import EventType
from .models import ChatOutputs, OperationRequest, OperationResponse, RequestContext

log = logging.getLogger(__name__)

HandlerResult = ChatOutputs | tuple[ChatOutputs, dict[str, Any]]
Handler = Callable[[AgentContext, dict[str, Any], RequestContext], HandlerResult]

_REGISTRY: dict[str, Handler] = {}

# Modules that register handlers (imported lazily on first dispatch).
HANDLER_MODULES = ["triage_agent.handlers"]

# Studio deliveries: exactly-once (idempotency.py) and retryable on any non-payload failure.
ENTRY_OPS = frozenset({"triage_message", "record_reaction", "converse", "ingest_email"})


# Operations whose payload is something said or done in Chat (or the agent inbox): recorded for Chat tracking.
TRACKED_INBOUND_OPS = frozenset({"triage_message", "record_reaction", "start_escalation", "converse", "ingest_email"})
# Housekeeping operations: audited only when they did something or failed.
QUIET_OPS = frozenset({"health", "drain_outbox", "run_followups", "ingest_inhouse", "run_forecast", "run_watches", "refresh_knowledge"})


def _surface_of(flow: str | None) -> str:
    flow = (flow or "").lower()
    if flow == "console":
        return "console"
    if flow == "chat_agent":
        return "chat_agent"
    if flow in ("job", "jobs", "scheduler"):
        return "job"
    if flow == "pubsub":
        return "pubsub"
    return "chat" if flow else "agent"


class RetryableError(RuntimeError):
    """Transient failure (e.g. Gemini 429). Studio retries the step up to 5 times."""


class UserFacingError(RuntimeError):
    """Expected failure with a message safe to show in chat (e.g. unknown case id)."""


def operation(name: str) -> Callable[[Handler], Handler]:
    def decorator(fn: Handler) -> Handler:
        _REGISTRY[name] = fn
        return fn

    return decorator


def registered_operations() -> list[str]:
    _load_handlers()
    return sorted(_REGISTRY)


def _load_handlers() -> None:
    for module in HANDLER_MODULES:
        try:
            importlib.import_module(module)
        except ModuleNotFoundError as exc:
            if exc.name != module:  # a real missing dependency inside the module
                raise


# ---------------------------------------------------------------------------
# Delivery helpers
# ---------------------------------------------------------------------------


def enqueue_outputs(ctx: AgentContext, outputs: ChatOutputs, source: str, targets: set[str] | None = None) -> list[str]:
    """Queue chat outputs as OutboxItems (all targets, or only `targets`). reply_text is never queued."""
    queued = []
    case_id = outputs.case_id or None
    esc_id = outputs.escalation_id or None
    for target, text in outputs.target_texts().items():
        if targets is None or target in targets:
            queued.append(ctx.enqueue(target, text, case_id=case_id, escalation_id=esc_id, source=source).outbox_id)
    if outputs.dm_text.strip() and outputs.dm_recipients and (targets is None or "dm" in targets):
        queued.append(
            ctx.enqueue("dm", outputs.dm_text, recipients=outputs.dm_recipients, case_id=case_id,
                        escalation_id=esc_id, source=source).outbox_id
        )
    return queued


def _strip_targets(outputs: ChatOutputs, targets: set[str]) -> ChatOutputs:
    out = outputs.model_copy(deep=True)
    for target in targets:
        if target == "dm":
            out.dm_text, out.dm_recipients = "", []
        elif target == "reply":
            out.reply_text = ""
        else:
            out.set_target(target, "")
    return out


def stealth_enabled(ctx: AgentContext) -> bool:
    """Burson receives nothing: config `burson_feedback.silent_in_burson_space` or the TRIAGE_STEALTH_BURSON env override."""
    if ctx.config.burson_feedback.silent_in_burson_space:
        return True
    return os.environ.get("TRIAGE_STEALTH_BURSON", "").strip().lower() in ("1", "true", "yes")


def _stealth_burson(ctx: AgentContext, outputs: ChatOutputs) -> ChatOutputs:
    """In stealth mode never emit burson_text; append it to clean_text with a label so IMs still see it."""
    if not outputs.burson_text.strip() or not stealth_enabled(ctx):
        return outputs
    out = outputs.model_copy(deep=True)
    redir = f"[STEALTH — would post to Burson] {out.burson_text.strip()}"
    out.clean_text = "\n\n".join(t for t in (out.clean_text.strip(), redir) if t)
    out.burson_text = ""
    return out


def _finalize(ctx: AgentContext, req: OperationRequest, outputs: ChatOutputs, data: dict) -> tuple[ChatOutputs, dict]:
    rc = req.context
    outputs = _stealth_burson(ctx, outputs)
    from . import safety

    outputs, held = safety.guard_outputs(ctx, outputs, op=req.op, actor=rc.invoked_by or "agent")
    if held:
        data = {**data, "held_outputs": held}
    if rc.deliver == "outbox":
        queued = enqueue_outputs(ctx, outputs, source=req.op)
        data = {**data, "queued_outbox_ids": queued, "reply_text": outputs.reply_text}
        outputs = ChatOutputs(
            case_id=outputs.case_id, escalation_id=outputs.escalation_id, verdict=outputs.verdict, summary=outputs.summary
        )
        return outputs, data
    if rc.targets is not None:
        allowed = {t.strip().lower() for t in rc.targets if t.strip()}
        produced = set(outputs.target_texts()) | ({"dm"} if outputs.dm_text.strip() and outputs.dm_recipients else set())
        unsupported = produced - allowed
        if unsupported:
            queued = enqueue_outputs(ctx, outputs, source=req.op, targets=unsupported)
            data = {**data, "rerouted_to_outbox": sorted(unsupported), "queued_outbox_ids": queued}
            outputs = _strip_targets(outputs, unsupported)
        if outputs.reply_text.strip() and "reply" not in allowed:
            data = {**data, "dropped_reply_text": outputs.reply_text}
            outputs = _strip_targets(outputs, {"reply"})
    return outputs, data


# ---------------------------------------------------------------------------
# Dispatcher
# ---------------------------------------------------------------------------


def dispatch(op: str, payload: dict[str, Any], ctx: AgentContext, rc: RequestContext | None = None) -> tuple[ChatOutputs, dict]:
    """Run one handler and return its raw (ChatOutputs, data): no outbox, rerouting or stealth.

    For nested calls (e.g. converse running review_decision); the outer handle() finalizes delivery
    once. Exceptions (UserFacingError included) propagate to the caller.
    """
    _load_handlers()
    handler = _REGISTRY.get(op)
    if handler is None:
        raise UserFacingError(f"Operation not implemented: {op}")
    result = handler(ctx, payload or {}, rc or RequestContext())
    return result if isinstance(result, tuple) else (result, {})


def handle(request: OperationRequest | dict[str, Any], ctx: AgentContext | None = None) -> OperationResponse:
    req = request if isinstance(request, OperationRequest) else OperationRequest.model_validate(request)
    ctx = ctx or build_context()
    _load_handlers()
    if req.op not in _REGISTRY:
        return OperationResponse(ok=False, op=req.op, outputs=ChatOutputs().to_studio(), error=f"Operation not implemented: {req.op}")

    from . import chatlog, telemetry

    inbound, inbound_new = (None, False)
    if req.op in TRACKED_INBOUND_OPS:
        inbound, inbound_new = chatlog.record_inbound(ctx, req.op, req.payload, req.context)

    def _track(outputs: ChatOutputs, data: dict, status: str = "ok") -> None:
        """Chat tracking and the audit entry for one finished operation (never raises)."""
        try:
            chatlog.link_inbound(ctx, inbound, outputs.case_id or None, outputs.escalation_id or None)
            if req.context.deliver != "outbox" and req.op != "drain_outbox" and (inbound is None or inbound_new):
                chatlog.record_outputs(ctx, req.op, outputs, req.context, inbound)
            quiet = req.op in QUIET_OPS and status == "ok" and not (
                outputs.target_texts() or outputs.dm_text.strip() or outputs.reply_text.strip() or data.get("queued_outbox_ids"))
            if not quiet and (inbound is None or inbound_new):
                ctx.audit(actor=req.context.invoked_by or "agent", action=f"op.{req.op}", surface=_surface_of(req.context.flow),
                          target_type="case" if outputs.case_id else ("escalation" if outputs.escalation_id else "operation"),
                          target_id=outputs.case_id or outputs.escalation_id or req.op,
                          summary=(outputs.summary or data.get("user_error") or req.op)[:400], status=status,
                          case_id=outputs.case_id or None, escalation_id=outputs.escalation_id or None,
                          detail={"flow": req.context.flow, "verdict": outputs.verdict or None,
                                  "held": data.get("held_outputs") or None, "queued": len(data.get("queued_outbox_ids") or [])})
        except Exception:  # noqa: BLE001
            log.warning("tracking failed for %s", req.op, exc_info=True)

    try:
        with telemetry.span(f"op.{req.op}", op=req.op, flow=req.context.flow or ""):
            outputs, data = dispatch(req.op, req.payload, ctx, req.context)
            outputs, data = _finalize(ctx, req, outputs, data)
        _track(outputs, data)
        return OperationResponse(ok=True, op=req.op, outputs=outputs.to_studio(), data=data)
    except UserFacingError as exc:
        outputs = ChatOutputs(reply_text=f"{ctx.config.agent.message_prefix} {exc}", summary=str(exc))
        outputs, data = _finalize(ctx, req, outputs, {"user_error": str(exc)})
        _track(outputs, data, status="denied")
        return OperationResponse(ok=True, op=req.op, outputs=outputs.to_studio(), data=data)
    except Exception as exc:  # noqa: BLE001 - always answer Studio with a well-formed response
        retryable = is_retryable(req.op, exc)
        log.exception("operation %s failed (retryable=%s)", req.op, retryable)
        try:
            ctx.audit(actor=req.context.invoked_by or "agent", action=f"op.{req.op}", surface=_surface_of(req.context.flow),
                      target_type="operation", target_id=req.op, summary=f"{type(exc).__name__}: {exc}"[:400], status="error",
                      detail={"flow": req.context.flow, "retryable": retryable})
        except Exception:  # noqa: BLE001
            pass
        try:
            ctx.emit(
                EventType.ERROR,
                actor=req.context.invoked_by or "agent",
                payload={"op": req.op, "error": str(exc), "error_type": type(exc).__name__, "retryable": retryable,
                         "trace": traceback.format_exc()[-2000:]},
            )
        except Exception:  # noqa: BLE001
            pass
        return OperationResponse(
            ok=False, op=req.op, outputs=ChatOutputs().to_studio(), error=str(exc), retryable=retryable
        )


def is_retryable(op: str, exc: BaseException) -> bool:
    """Studio retries a step (up to 5 times) when we say so.

    RetryableError is always retryable. For the entry operations any other failure is too,
    except an invalid payload (ValidationError), which would fail the same way every time:
    the idempotency claim is released and nothing is cached on failure, so a retry is safe,
    and the alternative (a dropped alert) is the worst outcome this system can have.
    """
    if isinstance(exc, RetryableError):
        return True
    if op not in ENTRY_OPS:
        return False
    return not isinstance(exc, ValidationError)


# ---------------------------------------------------------------------------
# Foundation operations
# ---------------------------------------------------------------------------


@operation("health")
def _health(ctx: AgentContext, payload: dict[str, Any], rc: RequestContext) -> HandlerResult:
    data: dict[str, Any] = {
        "operations": sorted(_REGISTRY),
        "config_version": ctx.config_version,
        "placeholder_template": ctx.config.alert_template.is_placeholder,
        "doorbell": ctx.config.outbox.doorbell,
        "gmail": ctx.gmail is not None,
        "models": {"triage": ctx.config.models.triage, "location": ctx.config.models.location},
    }
    if payload.get("probe_llm"):  # opt-in: one tiny Gemini call (catches retired or mislocated models)
        data["llm_probe"] = _probe_llm(ctx)
    ok = data.get("llm_probe", {}).get("ok", True)
    return ChatOutputs(summary=f"{'ok' if ok else 'degraded'} env={ctx.config.env} config={ctx.config_version}"), data


class _Probe(BaseModel):
    ok: bool


def _probe_llm(ctx: AgentContext) -> dict[str, Any]:
    import time

    t0 = time.monotonic()
    try:
        ctx.llm.generate_json(model=ctx.config.models.triage, system="Health check.", prompt='Return {"ok": true}.',
                              schema=_Probe, temperature=0.0, purpose="health.probe")
        return {"ok": True, "model": ctx.config.models.triage, "latency_ms": int((time.monotonic() - t0) * 1000)}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "model": ctx.config.models.triage, "error": str(exc)[:300]}


@operation("drain_outbox")
def _drain_outbox(ctx: AgentContext, payload: dict[str, Any], rc: RequestContext) -> HandlerResult:
    """Studio Outbox flow (doorbell starter): deliver one batch of queued posts."""
    from .outbox import drain

    outputs, data = drain(ctx, claimed_by=rc.run_id or rc.flow or "drain_outbox")
    if data["delivered_ids"]:
        ctx.emit(
            EventType.OUTBOX_DELIVERED,
            actor=rc.invoked_by or "agent",
            payload={"count": len(data["delivered_ids"]), "targets": sorted(outputs.target_texts()), "remaining": data["remaining"]},
        )
    return outputs, data
