"""A raised alert, as it is posted in Chat.

The review never sees a link or a name. After it has decided, the post's link and, for a KOF, the name shown are
read back from the vault and put on the alert. The alert is queued like every other post of the agent's: it goes out
through the QA chatbot's Chat sign-in (and through Pub/Sub when that delivery is ON). It is never queued for the
source space.
"""

from __future__ import annotations

from datetime import timedelta
from typing import TYPE_CHECKING, Any

from ..events import PlatformEvent
from ..models import SPACE_TARGETS
from . import POST_SWITCH, schema

if TYPE_CHECKING:
    from ..context import AgentContext

MAX_CHARS = 3900


def vault(ctx: "AgentContext", gw: Any, docs: list[dict[str, Any]]) -> None:
    """Puts each decision's links, and a KOF's name, on its record, from the vault."""
    if not docs:
        return
    own = ctx.config.platform.own_alerts
    posts = [d["target_id"] for d in docs if d["item_type"] != "STORY"]
    stories = [d["target_id"] for d in docs if d["item_type"] == "STORY"]
    v, p = schema.table(ctx, "author_vault_30d"), schema.table(ctx, "posts")
    rows = gw.query(
        f"SELECT 'SINGLE_POST' AS kind, v.post_id AS target, v.is_kof, v.kof_display_label, v.post_url, v.ingested_at AS seen_at\n"
        f"FROM `{v}` v\nWHERE v.ingested_at >= @since AND v.post_id IN UNNEST(@posts)\nUNION ALL\n"
        f"SELECT 'STORY' AS kind, p.story_id AS target, v.is_kof, v.kof_display_label, v.post_url, p.ingested_at AS seen_at\n"
        f"FROM `{p}` p JOIN `{v}` v ON v.post_id = p.post_id AND v.ingested_at >= @since\n"
        f"WHERE p.ingested_at >= @since AND p.story_id IN UNNEST(@stories)\nORDER BY seen_at DESC",
        {"since": ctx.now() - timedelta(days=own.keep_days), "posts": posts or [""], "stories": stories or [""]},
        location=ctx.config.platform.bigquery.location or None, max_rows=5000, labels=schema.LABELS)
    for doc in docs:
        kind = "STORY" if doc["item_type"] == "STORY" else "SINGLE_POST"
        mine = [r for r in rows if r.get("kind") == kind and r.get("target") == doc["target_id"]]
        links: list[str] = []
        for r in mine:
            url = str(r.get("post_url") or "")
            if url and url not in links:
                links.append(url)
        doc["links"] = links[: own.links_shown]
        names: list[str] = []  # a story can hold more than one KOF's post; each is named once
        for r in mine:
            if r.get("is_kof") and r.get("kof_display_label") and str(r["kof_display_label"]) not in names:
                names.append(str(r["kof_display_label"]))
        doc["kof"] = ", ".join(names)


def _mode(doc: dict[str, Any]) -> str:
    rule = doc.get("rule") or ""
    named = f"{rule} ({doc['section']})" if rule and doc.get("section") else rule
    trigger = doc.get("trigger")
    if trigger == "MET_IN_CODE":
        return f"*Mandatory rule*: {named}" if rule else "*Raised by another tool*: posted in the Other alerts space"
    if trigger == "FOLLOWUP_SURGE":
        return "*Follow-up*: a story already raised is growing again"
    if doc.get("item_type") == "STORY":
        return "*Found by review*: no rule covers it"
    return f"*Rule*: {named}"


def _author(doc: dict[str, Any], story: bool) -> str:
    """Only a KOF is ever named. Everyone else's details were removed before the post was kept."""
    kof = doc.get("kof") or ""
    if story:
        return f"*KOF in the story*: {kof}" if kof else "*Authors*: none on the KOF list (details removed)"
    return f"*Author*: KOF, {kof}" if kof else "*Author*: not on the KOF list (details removed)"


def text_of(doc: dict[str, Any], prefix: str, console_url: str) -> str:
    """The alert's words: severity and path, why it was looked at, the cleaned evidence, the reason, the author, the
    links, and the two verdict links when the Console's address is known."""
    story = doc.get("item_type") == "STORY"
    lines = [" ".join(x for x in (prefix, f"*Own alert* · {doc['severity']} · {doc['path']}") if x), _mode(doc)]
    if story and doc.get("velocity"):
        lines.append(doc["velocity"])
    lines += [doc.get("evidence") or "", f"*Why*: {doc.get('rationale') or ''}", _author(doc, story)]
    links = doc.get("links") or []
    if story:
        lines += [f"• <{url}|post {n + 1}>" for n, url in enumerate(links)]
    elif links:
        lines.append(f"<{links[0]}|Open the post>")
    if console_url:
        base = f"{console_url.rstrip('/')}/own-alerts?decision={doc['id']}&verdict="
        lines.append(f"<{base}TRUE_POSITIVE|Confirm> · <{base}FALSE_POSITIVE|False positive>")
    return "\n".join(lines)[:MAX_CHARS]


def post(ctx: "AgentContext", doc: dict[str, Any]) -> bool:
    """Queues one raised alert for Chat. False, with the reason on the record when there is one, when it is not posted."""
    from .. import mirror

    cfg = ctx.config.platform
    target = cfg.own_alerts.post_target.strip()
    if not cfg.flag(POST_SWITCH) or not target:
        return False
    if target == "burson" or mirror.is_source_target(ctx, target):
        doc["note"] = "Not posted: own alerts are never posted in the source space. Choose another space under Settings, Own alerts."
        return False
    if target not in SPACE_TARGETS or ctx.config.space(target) is None:
        doc["note"] = f"Not posted: {target} is not one of the agent's spaces (Integrations, Google Chat)."
        return False
    item = ctx.enqueue(target, text_of(doc, ctx.config.agent.message_prefix, cfg.gcp.console_url), source="own_alerts")
    doc.update(outbox_id=item.outbox_id, posted_to=target)
    ctx.emit(PlatformEvent.OWN_RAISED, actor="agent", space="system", payload={"decision_id": doc["id"], "outbox_id": item.outbox_id, "target": target})
    return True
