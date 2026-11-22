"""Dependency bundle passed to every agent module (config, state, events, LLM, clock, gateways)."""

import logging
import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Callable

from .config import AgentConfig, load_config
from .events import EventLogger, EventType, build_event_logger, make_event, note_write
from .llm import LLMClient, get_llm
from .models import AgentEvent, OnCallResolution, OutboxItem, Roster, utcnow
from .store import Store, get_store

log = logging.getLogger(__name__)

ROSTER_IM = "slrr_im"  # Incident Manager shifts (primary: reviews, SLA nudges, drafts)
ROSTER_BURSON = "burson"  # Burson on-call (NEEDS_BURSON bounces only)


@dataclass
class AgentContext:
    config: AgentConfig
    store: Store
    events: EventLogger
    llm: LLMClient
    now: Callable[[], datetime] = utcnow
    gmail: Any = None  # GmailGateway (triage_agent.escalation.gmail); None => drafting disabled
    doorbell: Any = None  # outbox.Doorbell; None => queued items wait for the next drain
    sonar: Any = None  # SonarLookup gateway (BigQuery); None => no ground-truth lookups
    publisher: Any = None  # pubsub.Publisher; None => built on first publish
    bq: Any = None  # bq_admin.BigQueryGateway; None => built on first use
    secrets: Any = None  # secret_admin.SecretGateway; None => built on first use
    _config_version: str | None = None
    _overrides_seen: Any = None
    _overrides_checked: float = 0.0

    # -- config ----------------------------------------------------------------
    @property
    def config_version(self) -> str:
        if self._config_version is None:
            self._config_version = self.config.config_version()
        return self._config_version

    def reload_config(self) -> None:
        self.config = load_config(self.store)
        self._config_version = None
        from . import telemetry

        telemetry.apply(self.config)
        invalidate = getattr(self.llm, "invalidate", None)
        if callable(invalidate):
            invalidate()

    def maybe_reload(self, ttl_s: float = 5.0) -> bool:
        """Read settings live: reload when the saved settings changed since last looked (at most every `ttl_s`)."""
        import time

        now = time.monotonic()
        if now - self._overrides_checked < ttl_s:
            return False
        self._overrides_checked = now
        try:
            current = self.store.get_config_overrides() or {}
        except Exception:  # noqa: BLE001 - keep the settings in hand
            log.warning("could not read saved settings", exc_info=True)
            return False
        if self._overrides_seen is None:
            self._overrides_seen = current
            return False
        if current != self._overrides_seen:
            self._overrides_seen = current
            self.reload_config()
            return True
        return False

    def flag(self, name: str) -> bool:
        """A Console switch (Settings → Switches). Unknown names are OFF."""
        return self.config.platform.flag(name)

    def audit(self, **fields: Any) -> Any:
        from . import audit

        return audit.record(self, **fields)

    # -- events ----------------------------------------------------------------
    def emit(self, event_type: str, **fields: Any) -> AgentEvent:
        event = make_event(
            event_type,
            env=self.config.env,
            config_version=self.config_version,
            event_ts=self.now(),
            **fields,
        )
        self.events.log(event)
        note_write()
        return event

    # -- rosters ---------------------------------------------------------------
    def roster(self, name: str = ROSTER_BURSON) -> Roster:
        """Current roster by name; seeds the store from config.seed_rosters on first use."""
        roster = self.store.get_roster(name)
        if roster is None:
            seed = self.config.seed_rosters.get(name)
            roster = seed.model_copy(deep=True) if seed else Roster()
            self.store.save_roster(roster, actor="seed", name=name)
        return roster

    def on_call(self, name: str = ROSTER_BURSON, at: datetime | None = None) -> OnCallResolution:
        from .oncall.roster import resolve_on_call  # local import: oncall imports models only

        return resolve_on_call(self.roster(name), at or self.now())

    def im_on_shift(self, at: datetime | None = None) -> OnCallResolution:
        """Incident Manager on shift (follow-the-sun roster)."""
        return self.on_call(ROSTER_IM, at)

    def burson_on_call(self, at: datetime | None = None) -> OnCallResolution:
        return self.on_call(ROSTER_BURSON, at)

    # -- outbox ----------------------------------------------------------------
    def enqueue(self, target: str, text: str, *, recipients: list[str] | None = None,
                case_id: str | None = None, escalation_id: str | None = None, source: str = "agent",
                direct: bool = False) -> OutboxItem:
        """Queue a post, then have it delivered.

        With "Post queued messages in Chat" ON the minute run posts it through the QA chatbot's Chat sign-in, and
        no flow is rung (the handover doc stays a flow's work). Otherwise, with Pub/Sub delivery ON the item is
        published (retries, dead letters); without it, or when the publish fails, the doorbell is rung directly
        (best effort; run_followups re-rings). `direct` skips Pub/Sub: used by the delivery worker itself."""
        item = OutboxItem(
            outbox_id=f"OBX-{uuid.uuid4().hex[:12]}",
            target=target,  # type: ignore[arg-type]
            text=text,
            recipients=recipients or [],
            case_id=case_id,
            escalation_id=escalation_id,
            source=source,
            created_at=self.now(),
            env=self.config.env,
        )
        self.store.add_outbox(item)
        from . import chatdelivery, chatlog, pubsub

        chatlog.record_queued(self, item)
        if chatdelivery.takes(self, item.target):
            return item
        if not direct and pubsub.enabled(self):
            try:
                pubsub.publish_outbox_item(self, item)
                return item
            except Exception as exc:  # noqa: BLE001 - fall back to the direct doorbell so the post is not stuck
                log.warning("publish failed for %s, ringing the doorbell directly: %s", item.outbox_id, exc)
                try:
                    self.emit(EventType.ERROR, payload={"op": "publish", "error": str(exc), "outbox_id": item.outbox_id})
                except Exception:  # noqa: BLE001
                    pass
        if self.doorbell is not None:
            try:
                self.doorbell.ring(item)
            except Exception as exc:  # noqa: BLE001 - item stays queued; run_followups re-rings
                log.warning("doorbell failed for %s: %s", item.outbox_id, exc)
                try:
                    self.emit(EventType.ERROR, payload={"op": "doorbell", "error": str(exc), "outbox_id": item.outbox_id})
                except Exception:  # noqa: BLE001
                    pass
        return item


def build_context(**overrides: Any) -> AgentContext:
    """Build from environment (see docs/CONTRACTS.md#environment). Overrides win."""
    from . import telemetry
    from .prompts import ManagedLLM
    from .safety import SafeGmail

    store = overrides.pop("store", None) or get_store()
    config = overrides.pop("config", None) or load_config(store)
    telemetry.apply(config)
    events = overrides.pop("events", None) or build_event_logger(store, config)
    llm = overrides.pop("llm", None) or get_llm(location=config.models.location, project=config.platform.gcp.project or None)
    holder: dict[str, AgentContext] = {}
    if not isinstance(llm, ManagedLLM):
        llm = ManagedLLM(llm, lambda: holder.get("ctx"))  # prompt versions from the Console + usage records
    ctx = AgentContext(config=config, store=store, events=events, llm=llm, **overrides)
    holder["ctx"] = ctx
    if ctx.gmail is None:
        ctx.gmail = _optional_gateway("triage_agent.escalation.gmail", "get_gmail_gateway", ctx)
    if ctx.gmail is not None and not isinstance(ctx.gmail, SafeGmail):
        ctx.gmail = SafeGmail(ctx.gmail, lambda: ctx)  # Testing recipients + the recipient allow-list on every draft
    if ctx.sonar is None:
        ctx.sonar = _optional_gateway("triage_agent.qa.sonar", "get_sonar_lookup", ctx)
    if ctx.doorbell is None:
        from .outbox import get_doorbell

        try:
            ctx.doorbell = get_doorbell(config, ctx.gmail)
        except Exception as exc:  # noqa: BLE001 - no doorbell => items wait for re-rings
            log.warning("doorbell unavailable: %s", exc)
    return ctx


def _optional_gateway(module: str, factory: str, ctx: AgentContext) -> Any:
    """Gateways live in workstream modules; missing modules (early builds/tests) => None."""
    import importlib

    try:
        mod = importlib.import_module(module)
    except ModuleNotFoundError as exc:
        parts = module.split(".")
        if exc.name not in {".".join(parts[:i]) for i in range(2, len(parts) + 1)}:
            raise
        return None
    return getattr(mod, factory)(ctx.config)
