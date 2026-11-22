"""Outbox delivery without the Chat API.

Posts that don't originate in a Studio run (jobs, Console actions, email
follow-ups, outputs for targets the calling flow can't post to) are stored as
OutboxItems. The agent then "rings a doorbell" so a Studio flow starts and
delivers them through its own "Post in a space" / "Send a message" / "Add to a
doc" steps:

  * sheet: append a row to the Agent Outbox Sheet -> "When a sheet changes"
  * email: send a short email to the Triage Agent account -> "When I get an email"
  * none:  nothing (tests, or while flows are being set up)

The Outbox flow calls op `drain_outbox`, which atomically claims a batch:
one clean-space alert per run (so each alert is its own message and emoji
reactions map to exactly one case), up to N items for other targets
(aggregated into one message), and DMs for a single recipient set.
Every enqueue rings once, so N queued alerts -> N flow runs -> N drains.
run_followups re-rings for items that are still undelivered after a while.
"""

import logging
from datetime import timedelta
from typing import TYPE_CHECKING, Any, Callable, Protocol, get_args

from .models import ChatOutputs, OutboxItem, OutboxTarget

if TYPE_CHECKING:  # pragma: no cover
    from .config import AgentConfig
    from .context import AgentContext

log = logging.getLogger(__name__)

MAX_CHARS = 3500


class Doorbell(Protocol):
    def ring(self, item: OutboxItem) -> None: ...


class NoopDoorbell:
    """Records rings (tests) and does nothing else."""

    def __init__(self) -> None:
        self.rings: list[str] = []

    def ring(self, item: OutboxItem) -> None:
        self.rings.append(item.outbox_id)


class SheetDoorbell:
    """Appends [created_at, outbox_id, target, env] to the Agent Outbox Sheet (Sheets API, ADC).

    The runtime service account needs edit access to the sheet. The Studio
    Outbox flow uses the "When a sheet changes" starter on that tab.
    """

    def __init__(self, sheet_id: str, tab: str = "outbox"):
        from googleapiclient.discovery import build  # lazy import
        import google.auth

        creds, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/spreadsheets"])
        self.sheet_id, self.tab = sheet_id, tab
        self.api = build("sheets", "v4", credentials=creds, cache_discovery=False)

    def ring(self, item: OutboxItem) -> None:
        self.api.spreadsheets().values().append(
            spreadsheetId=self.sheet_id,
            range=f"{self.tab}!A:D",
            valueInputOption="RAW",
            insertDataOption="INSERT_ROWS",
            body={"values": [[item.created_at.isoformat(), item.outbox_id, item.target, item.env]]},
        ).execute()


class EmailDoorbell:
    """Sends a short email to the Triage Agent account (Studio "When I get an email" starter).

    `send(subject, body)` is provided by the Gmail gateway using the agent
    account's own OAuth token (gmail.send scope), so no flow is involved and the
    starter's "ignore messages sent by flows" default doesn't apply.
    """

    def __init__(self, send: Callable[[str, str], Any], subject: str):
        self.send, self.subject = send, subject

    def ring(self, item: OutboxItem) -> None:
        self.send(f"{self.subject} {item.outbox_id}", f"{item.target} {item.outbox_id} {item.created_at.isoformat()}")


def get_doorbell(config: "AgentConfig", gmail: Any = None) -> Doorbell:
    kind = config.outbox.doorbell
    if kind == "sheet" and config.outbox.sheet_id:
        return SheetDoorbell(config.outbox.sheet_id, config.outbox.sheet_tab)
    if kind == "email" and gmail is not None and hasattr(gmail, "send_as_agent"):
        agent_email = config.agent.email
        return EmailDoorbell(lambda s, b: gmail.send_as_agent(agent_email, [agent_email], s, b), config.outbox.email_subject)
    return NoopDoorbell()


# ---------------------------------------------------------------------------
# Draining
# ---------------------------------------------------------------------------


def outputs_from_items(items: list[OutboxItem]) -> ChatOutputs:
    """Aggregate claimed items into one ChatOutputs (texts per target joined, oldest first)."""
    out = ChatOutputs()
    by_target: dict[str, list[OutboxItem]] = {}
    for item in sorted(items, key=lambda i: i.created_at):
        by_target.setdefault(item.target, []).append(item)
    for target, group in by_target.items():
        text = "\n\n".join(i.text.strip() for i in group if i.text.strip())
        if len(text) > MAX_CHARS:
            text = text[: MAX_CHARS - 1] + "…"
        if target == "dm":
            out.dm_text = text
            out.dm_recipients = list(dict.fromkeys(r for i in group for r in i.recipients))
        else:
            out.set_target(target, text)
    case_ids = list(dict.fromkeys(i.case_id for i in items if i.case_id))
    esc_ids = list(dict.fromkeys(i.escalation_id for i in items if i.escalation_id))
    out.case_id = case_ids[0] if len(case_ids) == 1 else ""
    out.escalation_id = esc_ids[0] if len(esc_ids) == 1 else ""
    out.summary = f"delivered {len(items)} queued item(s): " + ", ".join(
        f"{t}×{len(g)}" for t, g in by_target.items()
    ) if items else "outbox empty"
    return out


def drain(ctx: "AgentContext", claimed_by: str = "drain_outbox") -> tuple[ChatOutputs, dict]:
    from . import chatdelivery

    cfg = ctx.config.outbox
    per_target = {"clean": cfg.clean_items_per_drain}
    per_target.update({t: 0 for t in get_args(OutboxTarget) if chatdelivery.takes(ctx, t)})  # posted by the minute run, not by a flow
    items = ctx.store.claim_outbox(per_target, cfg.max_items_per_target, claimed_by, max_chars=MAX_CHARS)
    remaining = len(ctx.store.list_outbox(undelivered_only=True, limit=1000))
    if items:
        from . import chatlog

        chatlog.mark_delivered(ctx, items)
    return outputs_from_items(items), {
        "delivered_ids": [i.outbox_id for i in items],
        "remaining": remaining,
    }


def rering_stale(ctx: "AgentContext", older_than_min: int = 3, max_rings: int = 20) -> int:
    """Re-ring the doorbell for items still undelivered after `older_than_min` (lost rings)."""
    from . import chatdelivery

    if ctx.doorbell is None:
        return 0
    cutoff = ctx.now() - timedelta(minutes=older_than_min)
    stale = [i for i in ctx.store.list_outbox(undelivered_only=True, limit=500) if i.created_at <= cutoff and not chatdelivery.takes(ctx, i.target)]
    rung = 0
    for item in stale[:max_rings]:
        try:
            ctx.doorbell.ring(item)
            rung += 1
        except Exception:  # noqa: BLE001
            log.exception("doorbell re-ring failed for %s", item.outbox_id)
    return rung
