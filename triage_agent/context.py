"""Dependency bundle passed to every agent module (config, state, events, LLM, clock, gateways)."""

import logging
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Callable

from .config import AgentConfig, load_config
from .events import EventLogger, EventType, get_event_logger, make_event
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
    extras: dict[str, Any] = field(default_factory=dict)
    _config_version: str | None = None

    # -- config ----------------------------------------------------------------
    @property
    def config_version(self) -> str:
        if self._config_version is None:
            self._config_version = self.config.config_version()
        return self._config_version

    def reload_config(self) -> None:
        self.config = load_config(self.store)
        self._config_version = None

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
                case_id: str | None = None, escalation_id: str | None = None, source: str = "agent") -> OutboxItem:
        """Queue a post for the Studio Outbox flow and ring the doorbell (best effort)."""
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
    store = overrides.pop("store", None) or get_store()
    config = overrides.pop("config", None) or load_config(store)
    events = overrides.pop("events", None) or get_event_logger()
    llm = overrides.pop("llm", None) or get_llm(location=config.models.location)
    ctx = AgentContext(config=config, store=store, events=events, llm=llm, **overrides)
    if ctx.gmail is None:
        ctx.gmail = _optional_gateway("triage_agent.escalation.gmail", "get_gmail_gateway", ctx)
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
