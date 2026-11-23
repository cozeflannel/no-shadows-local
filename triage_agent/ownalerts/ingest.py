"""One read of every source: what is new is cleaned of personal details and staged for BigQuery.

For each post that is not already kept: its text goes through the patterns and Cloud DLP (scrub), its author becomes a
salted hash, and whether the author is a KOF is looked up (kof). The post is staged with nothing that names a person;
its link, and a KOF's name, go to the vault, which no model reads. The vault is written first, so a staged post always
has its link there.

Each source runs on its own: one that fails is noted with the reason, its cursor stays where it was (so the same rows
are read again) and the others carry on.
"""

from __future__ import annotations

import hashlib
import re
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any

from . import kof, schema, scrub, sources

if TYPE_CHECKING:
    from ..context import AgentContext

ROWS = 500  # rows in one insert
_PLACEHOLDER = re.compile(r"\[[A-Z_]+\]")
_WORD = re.compile(r"[^\W_]")


class NotReady(RuntimeError):
    """A setting agent alerts cannot run without is missing."""


def _sha(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def _handle(author: Any) -> str:
    return str(author or "").strip().lower().lstrip("@")


def post_id(source: sources.Source, row: dict[str, Any]) -> str:
    """A post's id: by its link when the source knows a post by its link (so one post seen through two sources is one
    post), else by the source and the row's own id."""
    from ..tempcheck import post_key

    link = post_key(str(row.get("url") or "")) if source.by_link else ""
    return _sha(f"post:{link}" if link else f"post:{source.system}:{row.get('one')}")


def _int(value: Any) -> int | None:
    try:
        n = float(value)
    except (TypeError, ValueError):
        return None
    return round(n) if n >= 0 else None


def _held(ctx: "AgentContext", gw: Any, ids: list[str], now: datetime) -> set[str]:
    """Which of these posts are already kept, or staged and waiting."""
    own = ctx.config.platform.own_alerts
    posts, staging = schema.table(ctx, "posts"), schema.table(ctx, "posts_staging")
    days = max(7, -(-own.posted_within_hours // 24) + 1)
    rows = gw.query(f"SELECT post_id FROM `{posts}` WHERE ingested_at >= @keep_since AND post_id IN UNNEST(@ids)\nUNION DISTINCT\n"
                    f"SELECT post_id FROM `{staging}` WHERE ingested_at >= @staged_since AND post_id IN UNNEST(@ids)",
                    {"keep_since": now - timedelta(days=days), "staged_since": now - timedelta(days=1), "ids": ids},
                    location=ctx.config.platform.bigquery.location or None, labels=schema.LABELS)
    return {r["post_id"] for r in rows}


def _read(ctx: "AgentContext", gw: Any, source: sources.Source, cursor: dict[str, Any] | None, now: datetime) -> tuple[list[dict[str, Any]], int]:
    own = ctx.config.platform.own_alerts
    since, after = sources.window(own, cursor, now)
    if source.kind == "table":
        return sources.read_table(ctx, gw, source, since, after, now), 0
    if source.kind == "brandwatch":
        if cursor and cursor.get("more") and cursor.get("same"):
            since += timedelta(milliseconds=1)  # a full page that was all added at one instant: step past it, or it comes back for ever
        return sources.read_brandwatch(ctx, source, since, now)
    return sources.read_space(ctx, source, since), 0


def _stage(ctx: "AgentContext", gw: Any, source: sources.Source, rows: list[dict[str, Any]], salt: str, index: dict[str, dict[str, str]],
           taken: set[str], now: datetime) -> int:
    """Cleans and stages one source's new posts. Returns how many were kept."""
    fresh: dict[str, dict[str, Any]] = {}
    for row in rows:
        if not str(row.get("text") or "").strip():
            continue
        pid = post_id(source, row)
        if pid not in taken and pid not in fresh:
            fresh[pid] = row
    if not fresh:
        return 0
    held = _held(ctx, gw, list(fresh), now)
    todo = [(pid, row) for pid, row in fresh.items() if pid not in held]
    if not todo:
        return 0
    cleaned = scrub.clean_all(ctx, [row["text"] for _, row in todo])
    at = now.isoformat()
    staged, vault = [], []
    for (pid, row), text in zip(todo, cleaned, strict=True):
        if not _WORD.search(_PLACEHOLDER.sub("", text)):  # nothing but what was taken out
            continue
        handle = _handle(row.get("author"))
        entry = kof.match(index, handle)
        platform = str(row.get("platform") or "").strip().lower()
        staged.append({
            "ingested_at": at, "post_id": pid, "source_system": source.system, "published_at": row.get("posted") or None,
            "platform": "x" if platform == "twitter" else platform, "author_hash": _sha(f"{salt}:{handle or 'anon'}"),
            "author_followers": _int(row.get("followers")), "is_kof": entry is not None, "kof_tier": entry["tier"] if entry else "NON_KOF",
            "sanitized_snippet": text, "views": None, "likes": None, "comments": _int(row.get("replies")), "shares": _int(row.get("shares")),
            "engagement_total": _int(row.get("eng")),
        })
        vault.append({"post_id": pid, "ingested_at": at, "is_kof": entry is not None, "kof_display_label": kof.label(entry, handle) if entry else None,
                      "post_url": str(row.get("url") or "")[:2000]})
    for name, batch in (("author_vault_30d", vault), ("posts_staging", staged)):
        for i in range(0, len(batch), ROWS):
            gw.insert_rows(schema.table(ctx, name), batch[i:i + ROWS])
    taken.update(r["post_id"] for r in staged)
    return len(staged)


def run(ctx: "AgentContext", state: dict[str, Any], now: datetime) -> dict[str, Any]:
    """Reads every source and stages what is new. `state` keeps each source's cursor and what its last read found."""
    from .. import bq_admin, secret_admin

    own = ctx.config.platform.own_alerts
    if not own.hash_salt_secret.strip():
        raise NotReady("Set the secret that holds the salt an author's handle is hashed with (Settings, Agent alerts). Nothing is read without it.")
    try:
        salt = secret_admin.read(ctx, own.hash_salt_secret.strip()).strip()
    except Exception as exc:
        raise NotReady(f"The salt secret could not be read: {exc}") from exc
    if not salt:
        raise NotReady("The salt secret is empty. Nothing is read without a salt.")
    gw = bq_admin.get_gateway(ctx)
    index = kof.lookup(ctx)
    cursors, entries = state.setdefault("cursors", {}), state.setdefault("sources", {})
    listed = sources.listing(ctx)
    taken: set[str] = set()
    out: dict[str, Any] = {"staged": 0, "read": 0, "failing": [], "waiting": []}
    for source in listed:
        entry: dict[str, Any] = {"label": source.label, "kind": source.kind, "where": source.where, "at": now.isoformat(), "error": ""}
        try:
            rows, left_out = _read(ctx, gw, source, cursors.get(source.key), now)
            with_words = [r for r in rows if str(r.get("text") or "").strip()]
            kept = _stage(ctx, gw, source, with_words, salt, index, taken, now)
            cursors[source.key] = sources.next_cursor(rows, own.posts_per_read, now)
            entry.update(status="live", read=len(with_words) + left_out, kept=kept, skipped=left_out, more=bool(cursors[source.key]["more"]))
            out["staged"] += kept
            out["read"] += len(with_words) + left_out
        except Exception as exc:  # noqa: BLE001 - noted on the source; its cursor stays, so the same rows are read again
            waiting = bq_admin.no_access(exc)  # its owners have not let this account in yet: skipped, and not a failure
            entry.update(status="waiting" if waiting else "failing", error=str(exc)[:400])
            out["waiting" if waiting else "failing"].append(source.key)
        entries[source.key] = entry
    for key in [k for k in entries if k not in {s.key for s in listed}]:
        del entries[key]  # a source taken out of Settings leaves the table
    return out
