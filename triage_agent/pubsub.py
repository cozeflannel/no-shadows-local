"""Outbound actions through Pub/Sub: publish, deliver exactly once, retry, dead-letter, replay.

Flow (switch `platform.flags.pubsub_delivery` ON and an outbound topic set):

    ctx.enqueue()  ->  publish OutboundAction to the outbound topic
    Pub/Sub push   ->  worker /pubsub/outbound  ->  deliver()  (claims the idempotency key; posts through the QA
                       chatbot's Chat sign-in when "Post queued messages in Chat" is ON, else rings the doorbell)
    N failures     ->  Pub/Sub moves it to the dead-letter topic
    Pub/Sub push   ->  worker /pubsub/dead-letter  ->  record_dead_letter()  (shown in the Console; replay / discard)

With the switch OFF the doorbell is rung directly, as before. The local backend has no Pub/Sub: LocalBus runs the
same deliver() / dead-letter path in-process, so retries, idempotency and dead letters behave the same there.

Pub/Sub is called over REST with the service's own credentials (no extra client library).
"""

from __future__ import annotations

import base64
import json
import logging
import os
import uuid
from datetime import datetime
from typing import TYPE_CHECKING, Any, Literal, Protocol

from pydantic import BaseModel, Field

from .events import PlatformEvent
from .models import OutboxItem

if TYPE_CHECKING:  # pragma: no cover
    from .context import AgentContext

log = logging.getLogger(__name__)

API = "https://pubsub.googleapis.com/v1"
OUTBOUND = "outbound"  # collection: one doc per action (state + attempts)
DEAD = "dead_letters"
ActionKind = Literal["outbox.deliver", "notify.dm", "temp_check.deliver", "forecast.notify"]


class OutboundAction(BaseModel):
    action_id: str
    kind: ActionKind
    idempotency_key: str
    payload: dict[str, Any] = Field(default_factory=dict)
    case_id: str | None = None
    escalation_id: str | None = None
    actor: str = "agent"
    created_at: datetime
    env: str = "dev"


class OutboundState(BaseModel):
    action: OutboundAction
    status: Literal["published", "delivered", "failed", "dead_lettered", "discarded"] = "published"
    attempts: int = 0
    last_error: str = ""
    message_id: str = ""
    delivered_at: datetime | None = None
    updated_at: datetime | None = None
    transport: str = ""


class Publisher(Protocol):
    name: str

    def publish(self, topic: str, data: dict[str, Any], attributes: dict[str, str] | None = None) -> str: ...


def project_id(ctx: "AgentContext") -> str:
    cfg = ctx.config.platform
    return (cfg.pubsub.project or cfg.gcp.project or os.environ.get("TRIAGE_PROJECT_ID")
            or os.environ.get("GOOGLE_CLOUD_PROJECT") or "")


class _Rest:
    def __init__(self) -> None:
        self._session: Any = None

    def session(self) -> Any:
        if self._session is None:
            import google.auth
            from google.auth.transport.requests import AuthorizedSession

            creds, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/pubsub"])
            self._session = AuthorizedSession(creds)
        return self._session

    def call(self, method: str, path: str, body: dict[str, Any] | None = None, ok: tuple[int, ...] = (200,)) -> dict[str, Any]:
        resp = self.session().request(method, f"{API}/{path}", json=body, timeout=30)
        if resp.status_code not in ok:
            raise RuntimeError(f"Pub/Sub {method} {path}: {resp.status_code} {resp.text[:300]}")
        return resp.json() if resp.content else {}


class PubSubPublisher:
    """Google Cloud Pub/Sub over REST."""

    name = "pubsub"

    def __init__(self, project: str):
        if not project:
            raise RuntimeError("No project for Pub/Sub: set Settings → Delivery → Project")
        self.project = project
        self.rest = _Rest()

    def publish(self, topic: str, data: dict[str, Any], attributes: dict[str, str] | None = None) -> str:
        body = {"messages": [{"data": base64.b64encode(json.dumps(data, default=str).encode()).decode(),
                              "attributes": attributes or {}}]}
        out = self.rest.call("POST", f"projects/{self.project}/topics/{topic}:publish", body)
        return str((out.get("messageIds") or [""])[0])


class LocalBus:
    """In-process transport for the local backend: the same handler, retries and dead-letter rule as Pub/Sub."""

    name = "local"

    def __init__(self, ctx_getter: Any):
        self._ctx = ctx_getter

    def publish(self, topic: str, data: dict[str, Any], attributes: dict[str, str] | None = None) -> str:
        ctx = self._ctx()
        message_id = f"local-{uuid.uuid4().hex[:12]}"
        attempts = max(1, ctx.config.platform.pubsub.max_delivery_attempts)
        action = OutboundAction.model_validate(data)
        for attempt in range(1, attempts + 1):
            try:
                deliver(ctx, action, delivery_attempt=attempt, message_id=message_id)
                return message_id
            except Exception as exc:  # noqa: BLE001 - retried up to the limit, then dead-lettered
                log.warning("local delivery attempt %s/%s failed for %s: %s", attempt, attempts, action.action_id, exc)
        record_dead_letter(ctx, action, delivery_attempt=attempts, message_id=message_id)
        return message_id


def get_publisher(ctx: "AgentContext") -> Publisher:
    if os.environ.get("TRIAGE_BACKEND", "local") == "gcp":
        return PubSubPublisher(project_id(ctx))
    return LocalBus(lambda: ctx)


# -- publish ---------------------------------------------------------------------------------------------------
def enabled(ctx: "AgentContext") -> bool:
    ps = ctx.config.platform
    return bool(ps.flags.pubsub_delivery and ps.pubsub.outbound_topic)


def _save_state(ctx: "AgentContext", state: OutboundState) -> None:
    state.updated_at = ctx.now()
    ctx.store.put_doc(OUTBOUND, state.action.action_id, state.model_dump(mode="json"))


def publish(ctx: "AgentContext", kind: ActionKind, payload: dict[str, Any], *, idempotency_key: str,
            case_id: str | None = None, escalation_id: str | None = None, actor: str = "agent") -> OutboundState:
    """Publish one outbound action. Raises when the topic can't be reached (the caller falls back or retries)."""
    action = OutboundAction(action_id=f"OUT-{uuid.uuid4().hex[:14]}", kind=kind, idempotency_key=idempotency_key,
                            payload=payload, case_id=case_id, escalation_id=escalation_id, actor=actor,
                            created_at=ctx.now(), env=ctx.config.env)
    publisher = ctx.publisher or get_publisher(ctx)
    state = OutboundState(action=action, transport=publisher.name)
    _save_state(ctx, state)
    message_id = publisher.publish(ctx.config.platform.pubsub.outbound_topic, action.model_dump(mode="json"),
                                   {"kind": kind, "idempotency_key": idempotency_key, "env": ctx.config.env})
    current = get_state(ctx, action.action_id) or state  # the local bus delivers before publish returns
    current.message_id = message_id
    _save_state(ctx, current)
    ctx.emit(PlatformEvent.OUTBOUND_PUBLISHED, actor=actor, case_id=case_id, escalation_id=escalation_id,
             payload={"action_id": action.action_id, "kind": kind, "message_id": message_id, "transport": publisher.name})
    return current


def publish_outbox_item(ctx: "AgentContext", item: OutboxItem) -> OutboundState:
    return publish(ctx, "outbox.deliver", {"outbox_id": item.outbox_id, "target": item.target},
                   idempotency_key=f"outbox:{item.outbox_id}", case_id=item.case_id, escalation_id=item.escalation_id)


def get_state(ctx: "AgentContext", action_id: str) -> OutboundState | None:
    row = ctx.store.get_doc(OUTBOUND, action_id)
    return OutboundState.model_validate(row) if row else None


# -- deliver ---------------------------------------------------------------------------------------------------
def _run(ctx: "AgentContext", action: OutboundAction) -> str:
    """Carry out one action. Returns a short note; raises to be retried."""
    if action.kind == "outbox.deliver":
        outbox_id = str(action.payload.get("outbox_id") or "")
        items = [i for i in ctx.store.list_outbox(undelivered_only=True, limit=1000) if i.outbox_id == outbox_id]
        if not items:
            return "already delivered"
        from . import chatdelivery

        if chatdelivery.takes(ctx, items[0].target):  # posted right here through the QA chatbot's Chat sign-in: no flow is rung
            return chatdelivery.post_now(ctx, items[0])
        if ctx.doorbell is None:
            raise RuntimeError("no doorbell is configured: Settings → Outbox")
        ctx.doorbell.ring(items[0])
        return "doorbell rung"
    if action.kind in ("notify.dm", "temp_check.deliver", "forecast.notify"):
        text = str(action.payload.get("text") or "")
        target = str(action.payload.get("target") or "dm")
        recipients = [r for r in action.payload.get("recipients") or [] if r]
        if not text:
            return "nothing to send"
        item = ctx.enqueue(target, text, recipients=recipients, case_id=action.case_id, escalation_id=action.escalation_id,
                           source=action.kind, direct=True)
        return f"queued {item.outbox_id}"
    raise ValueError(f"unknown outbound action kind: {action.kind}")


def deliver(ctx: "AgentContext", action: OutboundAction, *, delivery_attempt: int = 1, message_id: str = "") -> OutboundState:
    """Deliver once. A second delivery of the same idempotency key is acknowledged without acting."""
    from . import safety

    state = get_state(ctx, action.action_id) or OutboundState(action=action)
    state.attempts = max(state.attempts, delivery_attempt)
    state.message_id = message_id or state.message_id
    done_key = f"done:{action.idempotency_key}"
    if ctx.store.get_doc(OUTBOUND, done_key) is not None or state.status in ("delivered", "discarded"):
        if state.status != "discarded":
            state.status = "delivered"
        _save_state(ctx, state)
        return state
    try:
        if ctx.config.platform.safety.block_on_failed_check:
            failed = safety.blocking_failures(ctx)
            if failed:
                raise RuntimeError("held by a failed safety check: " + "; ".join(c.title for c in failed[:3]))
        note = _run(ctx, action)
    except Exception as exc:
        state.status, state.last_error = "failed", str(exc)[:500]
        _save_state(ctx, state)
        ctx.emit(PlatformEvent.OUTBOUND_FAILED, actor=action.actor, case_id=action.case_id, escalation_id=action.escalation_id,
                 payload={"action_id": action.action_id, "kind": action.kind, "attempt": delivery_attempt, "error": state.last_error})
        raise
    ctx.store.put_doc(OUTBOUND, done_key, {"action_id": action.action_id, "at": ctx.now().isoformat()})
    state.status, state.last_error, state.delivered_at = "delivered", "", ctx.now()
    _save_state(ctx, state)
    ctx.emit(PlatformEvent.OUTBOUND_DELIVERED, actor=action.actor, case_id=action.case_id, escalation_id=action.escalation_id,
             payload={"action_id": action.action_id, "kind": action.kind, "attempt": delivery_attempt, "note": note})
    return state


def record_dead_letter(ctx: "AgentContext", action: OutboundAction, *, delivery_attempt: int = 0, message_id: str = "") -> OutboundState:
    from . import audit

    state = get_state(ctx, action.action_id) or OutboundState(action=action)
    state.status = "dead_lettered"
    state.attempts = max(state.attempts, delivery_attempt)
    _save_state(ctx, state)
    ctx.store.put_doc(DEAD, action.action_id, {**state.model_dump(mode="json"), "dead_lettered_at": ctx.now().isoformat(),
                                               "message_id": message_id, "resolved": False})
    ctx.emit(PlatformEvent.OUTBOUND_DEAD_LETTERED, actor=action.actor, case_id=action.case_id, escalation_id=action.escalation_id,
             payload={"action_id": action.action_id, "kind": action.kind, "attempts": state.attempts, "error": state.last_error})
    audit.record(ctx, actor="agent", action="outbound.dead_letter", surface="pubsub", target_type="outbound",
                 target_id=action.action_id, summary=f"{action.kind} dead-lettered after {state.attempts} attempts: {state.last_error}"[:400],
                 status="error", case_id=action.case_id, escalation_id=action.escalation_id)
    return state


def decode_push(body: dict[str, Any]) -> tuple[OutboundAction, int, str]:
    """(action, delivery attempt, message id) from a Pub/Sub push request body."""
    message = body.get("message") or {}
    raw = base64.b64decode(message.get("data") or "").decode("utf-8")
    action = OutboundAction.model_validate_json(raw)
    return action, int(body.get("deliveryAttempt") or 1), str(message.get("messageId") or "")


def list_dead_letters(ctx: "AgentContext", include_resolved: bool = False, limit: int = 200) -> list[dict[str, Any]]:
    rows = ctx.store.list_docs(DEAD, where=None if include_resolved else {"resolved": False}, limit=limit)
    return rows


def replay(ctx: "AgentContext", action_id: str, actor: str) -> OutboundState:
    """Publish a dead-lettered action again under a fresh action id (same idempotency key)."""
    from . import audit

    row = ctx.store.get_doc(DEAD, action_id)
    if row is None:
        raise KeyError(action_id)
    old = OutboundAction.model_validate(row["action"])
    ctx.store.delete_doc(OUTBOUND, f"done:{old.idempotency_key}")
    state = publish(ctx, old.kind, old.payload, idempotency_key=old.idempotency_key, case_id=old.case_id,
                    escalation_id=old.escalation_id, actor=actor)
    row.update({"resolved": True, "resolution": "replayed", "resolved_by": actor, "resolved_at": ctx.now().isoformat(),
                "replayed_as": state.action.action_id})
    ctx.store.put_doc(DEAD, action_id, row)
    ctx.emit(PlatformEvent.OUTBOUND_REPLAYED, actor=actor, case_id=old.case_id, payload={"action_id": action_id, "as": state.action.action_id})
    audit.record(ctx, actor=actor, action="outbound.replay", surface="console", target_type="outbound", target_id=action_id,
                 summary=f"Replayed {old.kind} as {state.action.action_id}", case_id=old.case_id)
    return state


def discard(ctx: "AgentContext", action_id: str, actor: str, reason: str = "") -> None:
    from . import audit

    row = ctx.store.get_doc(DEAD, action_id)
    if row is None:
        raise KeyError(action_id)
    row.update({"resolved": True, "resolution": "discarded", "resolved_by": actor, "resolved_at": ctx.now().isoformat(),
                "reason": reason[:300]})
    ctx.store.put_doc(DEAD, action_id, row)
    state = get_state(ctx, action_id)
    if state:
        state.status = "discarded"
        _save_state(ctx, state)
    audit.record(ctx, actor=actor, action="outbound.discard", surface="console", target_type="outbound", target_id=action_id,
                 summary=f"Discarded a dead letter. {reason}"[:300])


# -- provisioning (topics, subscriptions, dead-letter policy) ------------------------------------------------------
def describe(ctx: "AgentContext") -> dict[str, Any]:
    """What exists in Pub/Sub for the configured names. Local backend: the in-process bus."""
    ps = ctx.config.platform.pubsub
    out: dict[str, Any] = {"enabled": enabled(ctx), "transport": "local" if os.environ.get("TRIAGE_BACKEND", "local") != "gcp" else "pubsub",
                           "project": project_id(ctx), "resources": []}
    if out["transport"] == "local":
        return out
    rest = _Rest()
    project = out["project"]
    for kind, name in (("topic", ps.outbound_topic), ("topic", ps.dead_letter_topic),
                       ("subscription", ps.outbound_subscription), ("subscription", ps.dead_letter_subscription)):
        if not name:
            continue
        path = f"projects/{project}/{kind}s/{name}"
        try:
            info = rest.call("GET", path)
            out["resources"].append({"kind": kind, "name": name, "exists": True,
                                     "detail": {k: info.get(k) for k in ("pushConfig", "deadLetterPolicy", "ackDeadlineSeconds", "retryPolicy") if k in info}})
        except Exception as exc:  # noqa: BLE001
            out["resources"].append({"kind": kind, "name": name, "exists": False, "error": str(exc)[:200]})
    return out


def provision(ctx: "AgentContext") -> list[dict[str, Any]]:
    """Create the topics and push subscriptions named in Settings, with the dead-letter and retry policy."""
    ps = ctx.config.platform.pubsub
    project = project_id(ctx)
    if os.environ.get("TRIAGE_BACKEND", "local") != "gcp":
        return [{"step": "local", "ok": True, "detail": "The local backend delivers in-process; nothing to create."}]
    missing = [label for label, v in (("Outbound topic", ps.outbound_topic), ("Dead-letter topic", ps.dead_letter_topic),
                                      ("Outbound subscription", ps.outbound_subscription),
                                      ("Dead-letter subscription", ps.dead_letter_subscription),
                                      ("Worker URL", ps.worker_url), ("Push service account", ps.push_service_account)) if not v]
    if missing:
        raise ValueError("Set these first in Settings → Delivery: " + ", ".join(missing))
    rest = _Rest()
    steps: list[dict[str, Any]] = []

    def ensure(label: str, method: str, path: str, body: dict[str, Any]) -> None:
        try:
            rest.call(method, path, body, ok=(200, 409))
            steps.append({"step": label, "ok": True})
        except Exception as exc:  # noqa: BLE001
            steps.append({"step": label, "ok": False, "detail": str(exc)[:300]})

    base = ps.worker_url.rstrip("/")
    audience = ps.push_audience or base
    oidc = {"serviceAccountEmail": ps.push_service_account, "audience": audience}
    ensure(f"topic {ps.outbound_topic}", "PUT", f"projects/{project}/topics/{ps.outbound_topic}", {})
    ensure(f"topic {ps.dead_letter_topic}", "PUT", f"projects/{project}/topics/{ps.dead_letter_topic}", {})
    ensure(f"subscription {ps.outbound_subscription}", "PUT", f"projects/{project}/subscriptions/{ps.outbound_subscription}", {
        "topic": f"projects/{project}/topics/{ps.outbound_topic}",
        "ackDeadlineSeconds": ps.ack_deadline_s,
        "pushConfig": {"pushEndpoint": f"{base}/pubsub/outbound", "oidcToken": oidc},
        "deadLetterPolicy": {"deadLetterTopic": f"projects/{project}/topics/{ps.dead_letter_topic}",
                             "maxDeliveryAttempts": ps.max_delivery_attempts},
        "retryPolicy": {"minimumBackoff": f"{ps.min_backoff_s}s", "maximumBackoff": f"{ps.max_backoff_s}s"},
    })
    ensure(f"subscription {ps.dead_letter_subscription}", "PUT", f"projects/{project}/subscriptions/{ps.dead_letter_subscription}", {
        "topic": f"projects/{project}/topics/{ps.dead_letter_topic}",
        "ackDeadlineSeconds": ps.ack_deadline_s,
        "pushConfig": {"pushEndpoint": f"{base}/pubsub/dead-letter", "oidcToken": oidc},
    })
    return steps
