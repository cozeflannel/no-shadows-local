"""The sources own alerts read, and how each hands over what is new.

    table        a table of posts (Settings, Temp check, sources), read by its own read in its own BigQuery location
    brandwatch   a Brandwatch query, read through Brandwatch's API as Brandwatch adds mentions to it
    chat         the Chat space other tools post their alerts in, read as the QA chatbot's account

Every read gives rows of one shape: one (what makes a row one post), platform, author, text, url, posted, followers,
eng, shares, replies, language, seen (when it reached the source). A read starts after where the last one stopped
(`seen`, then `one`), so a load of many rows with one arrival time is worked through read by read and none is skipped.
Nothing is ever written to a source.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING, Any
from urllib.parse import quote

if TYPE_CHECKING:
    from ..context import AgentContext

BRANDWATCH = "brandwatch_api"
OTHER_ALERTS = "other_alerts"
CHAT_PLATFORM = "google_chat"
# Networks where Brandwatch's "potential audience" is the author's followers (ProactiveWatch.gs PW_BW_SOCIAL_)
BW_SOCIAL = ("x", "bluesky", "instagram", "facebook", "threads", "tiktok", "youtube", "linkedin")
_LINK = re.compile(r"https?://[^\s<>|)\]]+")
COLUMNS = "CAST(one AS STRING) AS one, platform, author, text, url, posted, followers, eng, shares, replies, language, seen"


@dataclass
class Source:
    key: str              # what its cursor and its row on the Sources table are kept under
    kind: str             # table | brandwatch | chat
    system: str           # posts.source_system, and what a rule's sources name
    label: str
    where: str
    location: str = ""    # BigQuery location (tables)
    table: Any = None     # the table's settings (TempCheckSource)
    query: str = ""       # Brandwatch query id
    space: str = ""       # spaces/...
    by_link: bool = True  # a post is known by its link across sources (False: by its row id, for comments under one post)


def listing(ctx: "AgentContext") -> list[Source]:
    """Every source set under Settings, Own alerts, in the order it is read."""
    from .. import mirror

    cfg = ctx.config.platform
    own = cfg.own_alerts
    home = cfg.bigquery.location
    by_key = {s.key: s for s in cfg.temp_check.sources if s.table}
    out = []
    for key in own.sources:
        src = by_key.get(key)
        if src is None:
            continue
        location = src.location or home
        out.append(Source(key=key, kind="table", system=key, label=src.label or key, where=f"{src.table} ({location or 'default location'})",
                          location=location, table=src, by_link=src.dedupe_by == "url"))
    for query in own.brandwatch_queries:
        query = str(query).strip()
        if query:
            out.append(Source(key=f"{BRANDWATCH}:{query}", kind="brandwatch", system=BRANDWATCH, label=f"Brandwatch query {query}", query=query,
                              where=f"Brandwatch's API: project {cfg.temp_check.brandwatch_project_id or 'not set'}, query {query}"))
    if own.other_alerts_space.strip():
        try:
            space = mirror.space_ref(own.other_alerts_space)
        except ValueError:
            space = ""
        out.append(Source(key=OTHER_ALERTS, kind="chat", system=OTHER_ALERTS, label="Other alerts space", space=space, by_link=False,
                          where=f"Google Chat: {space or 'the space set is not a Chat space'}"))
    return out


def window(own: Any, cursor: dict[str, Any] | None, now: datetime) -> tuple[datetime, str]:
    """Where a read starts: (after this arrival time, and after this row at that time)."""
    if not cursor or not cursor.get("at"):
        return now - timedelta(minutes=own.first_read_minutes), ""
    at = datetime.fromisoformat(cursor["at"])
    if cursor.get("more"):  # a backlog is being worked through: carry on exactly where it stopped
        return at, str(cursor.get("after") or "")
    return max(at - timedelta(minutes=own.lag_minutes), now - timedelta(minutes=own.max_read_minutes)), ""


def next_cursor(rows: list[dict[str, Any]], cap: int, now: datetime) -> dict[str, Any]:
    """Where the next read starts: after the last row when the read was full, else from now."""
    if rows and len(rows) >= cap and rows[-1].get("seen"):
        return {"at": str(rows[-1]["seen"]), "after": str(rows[-1].get("one") or ""), "more": True,
                "same": len({str(r.get("seen")) for r in rows}) == 1}  # the whole read arrived at one instant
    return {"at": now.isoformat(), "after": "", "more": False, "same": False}


# -- tables ------------------------------------------------------------------------------------------------------------
def table_sql(src: Any, own: Any) -> str:
    """One table's new rows: its own read, the rows that arrived after the last one handed over, oldest first."""
    from ..tempcheck import read_of

    gates = ["(seen > @since OR (seen = @since AND CAST(one AS STRING) > @after)) AND seen < @until",
             "(posted IS NULL OR posted >= @posted_since)", "one IS NOT NULL AND TRIM(IFNULL(text, '')) != ''"]
    gives_language = ("language" in src.has) if src.read_sql.strip() else bool(src.language_column)
    if own.english_only and gives_language:
        gates.append("LOWER(IFNULL(language, 'en')) LIKE 'en%'")
    return (f"SELECT {COLUMNS}\nFROM (\n{read_of(src)}\n)\nWHERE " + "\n  AND ".join(gates) +
            "\nQUALIFY ROW_NUMBER() OVER (PARTITION BY one ORDER BY seen DESC) = 1\nORDER BY seen, one\nLIMIT @cap")


def read_table(ctx: "AgentContext", gw: Any, source: Source, since: datetime, after: str, now: datetime) -> list[dict[str, Any]]:
    from .schema import LABELS

    own = ctx.config.platform.own_alerts
    params = {"since": since, "after": after, "until": now, "t_from": since, "t_to": now,
              "posted_since": now - timedelta(hours=own.posted_within_hours), "cap": own.posts_per_read}
    return gw.query(table_sql(source.table, own), params, location=source.location or None, max_rows=own.posts_per_read, labels=LABELS)


# -- Brandwatch's API --------------------------------------------------------------------------------------------------
def _stamp(at: datetime) -> str:
    at = at.astimezone(timezone.utc) if at.tzinfo else at
    return quote(at.strftime("%Y-%m-%dT%H:%M:%S.") + f"{at.microsecond // 1000:03d}Z", safe="")


def _count(value: Any) -> int:
    try:
        n = float(value)
    except (TypeError, ValueError):
        return 0
    return round(n) if n > 0 else 0


def _bw_platform(mention: dict[str, Any]) -> str:
    kind = str(mention.get("pageType") or mention.get("contentSource") or "").strip().lower()
    for lead, name in (("facebook", "facebook"), ("instagram", "instagram"), ("linkedin", "linkedin")):
        if kind.startswith(lead):
            return name
    return "x" if kind == "twitter" else kind


def read_brandwatch(ctx: "AgentContext", source: Source, since: datetime, now: datetime) -> tuple[list[dict[str, Any]], int]:
    """A query's mentions added since the last read, oldest added first: (rows, how many were left out). An X post
    comes from Brandwatch without its words; they are looked up in X's public embed data, and one X will not show is
    left out."""
    from .. import tempcheck, xposts

    own = ctx.config.platform.own_alerts
    bw = tempcheck.Brandwatch(ctx)
    path = (f"/projects/{bw.project}/data/mentions?queryId={quote(source.query, safe='')}"
            f"&startDate={_stamp(now - timedelta(hours=own.posted_within_hours))}&endDate={_stamp(now)}&sinceAdded={_stamp(since)}"
            f"&orderBy=added&orderDirection=asc&pageSize={own.posts_per_read}&page=0&xthreadEntryType=share")
    if own.english_only:
        path += "&language=en"
    body = bw.get(path)
    raw = [m for m in (body or {}).get("results") or [] if m]
    posts = tempcheck.parse_mentions(body)
    x_ids = [p["id"] for p in posts if p.get("x") and p.get("id")]
    found = xposts.lookup(x_ids) if x_ids else {}
    rows: list[dict[str, Any]] = []
    left_out = 0
    for mention, post in zip(raw, posts, strict=True):
        added = tempcheck._bw_time(mention.get("added")) or now
        full = tempcheck.post_with_text(post, found)
        if full is None:
            left_out += 1
            rows.append({"seen": added.isoformat(), "one": post.get("key") or "", "text": ""})
            continue
        platform = _bw_platform(mention)
        followers = (_count(mention.get("twitterFollowers")) or _count(mention.get("blueskyFollowers")) or _count(mention.get("instagramFollowerCount"))
                     or _count(mention.get("youtubeSubscriberCount")) or (_count(mention.get("potentialAudience")) if platform in BW_SOCIAL else 0))
        if post.get("x"):
            eng = (int(full["likes"]) + int(full.get("replies") or 0)) if "likes" in full else None
            shares, replies = None, (int(full["replies"]) if "replies" in full else None)
        else:
            counted = _count(mention.get("likes")) + _count(mention.get("comments")) + _count(mention.get("shares"))
            eng = counted or _count(mention.get("engagementScore")) or None
            shares, replies = _count(mention.get("shares")) or None, _count(mention.get("comments")) or None
        rows.append({"one": full.get("key") or "", "platform": platform, "author": full.get("author") or "", "text": full.get("text") or "",
                     "url": full.get("url") or "", "posted": full.get("at"), "followers": followers or None, "eng": eng, "shares": shares,
                     "replies": replies, "language": str(mention.get("language") or "").lower(), "seen": added.isoformat()})
    return rows, left_out


# -- the Other alerts space ----------------------------------------------------------------------------------------------
def read_space(ctx: "AgentContext", source: Source, since: datetime) -> list[dict[str, Any]]:
    """The alerts other tools posted after the last read, oldest first. A reply, an empty message and anything the
    QA chatbot posted itself are not alerts."""
    from .. import chatapi

    if not source.space:
        raise ValueError("The Other alerts space set under Settings, Own alerts is not a Chat space (a link or an id).")
    rows = []
    for m in chatapi.client_for(ctx).list_messages(source.space, since):
        text = str(m.get("text") or m.get("card_text") or "").strip()
        if not text or m.get("reply") or chatapi.OWN_ID.match(str(m.get("client_id") or "")):
            continue
        link = _LINK.search(text)
        at = m["create_time"].isoformat()
        rows.append({"one": m["name"], "platform": CHAT_PLATFORM, "author": "", "text": text, "url": link.group(0) if link else "", "posted": at,
                     "followers": None, "eng": None, "shares": None, "replies": None, "language": "", "seen": at})
    return rows[: ctx.config.platform.own_alerts.posts_per_read]
