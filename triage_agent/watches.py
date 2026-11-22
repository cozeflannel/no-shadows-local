"""Watches: spot an issue before it is alerted on (the chat bot's Proactive watch, run from the Console).

A watch is a yes/no question, a rubric for scoring impact 1-10, topics, a bar and, optionally, the networks it
applies to. Every look, each source (a post table from Settings → Temp check → sources, named in
Settings → Campaigns → watch_sources) hands over what is new since its last look; Gemini inside BigQuery answers
each watch's question for each post (AI.IF), scores the matches (AI.SCORE) and picks a topic (AI.CLASSIFY). Posts at
a watch's bar, and near misses, are kept as detections with a rating column for people; the scorecard sets them
against the alerts that came in. Nothing is posted unless a target is set; nothing is written to BigQuery.

Each source runs on its own: one that fails is noted and the others carry on.
"""

from __future__ import annotations

import logging
import re
import statistics
import uuid
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any, Literal

from pydantic import BaseModel, Field

from .config import switch_off
from .events import PlatformEvent

if TYPE_CHECKING:  # pragma: no cover
    from .context import AgentContext

log = logging.getLogger(__name__)

WATCHES = "watches"
DETECTIONS = "watch_detections"
SOURCES_STATE = "watch_sources"
ENGLISH_RULE = "Rule: Return TRUE only if the post text itself is in English (return FALSE for non-English posts)."


class Watch(BaseModel):
    watch_id: str
    name: str
    enabled: bool = False  # a new watch starts OFF
    question: str  # what to look for: a yes/no question for Gemini
    rubric: str = ""  # how to score impact 1-10
    topics: list[str] = Field(default_factory=list)
    flag_at_score: float | None = None  # blank = the default bar
    networks: list[str] = Field(default_factory=list)  # blank = all
    status: str = ""  # written by the agent
    created_by: str = ""
    updated_by: str = ""
    updated_at: datetime | None = None


class Detection(BaseModel):
    detection_id: str
    watch_id: str
    watch: str
    seen_at: datetime
    score: float
    bar: float
    at_bar: bool
    topic: str = ""
    post_url: str
    source: str
    platform: str = ""
    author: str = ""
    followers: int | None = None
    engagement: float | None = None
    posted_at: datetime | None = None
    summary: str = ""
    rating: Literal["", "Useful", "Noise"] = ""
    rated_by: str = ""
    case_id: str | None = None  # the alert on the same post, once there is one
    lead_minutes: float | None = None  # how long before that alert the watch saw it
    posted_to: str = ""


def clean_topic(value: str) -> str:
    """A topic as it goes in the query: one line, no quotes or backslashes, capped."""
    return re.sub(r"\s+", " ", re.sub(r"['\"\\`]", "", str(value or ""))).strip()[:60]


def list_watches(ctx: "AgentContext") -> list[Watch]:
    out = [Watch.model_validate(r) for r in ctx.store.list_docs(WATCHES, limit=200)]
    out.sort(key=lambda w: w.name.lower())
    return out


def save_watch(ctx: "AgentContext", actor: str, data: dict[str, Any]) -> Watch:
    from . import audit

    if not ctx.flag("watches"):
        raise PermissionError(switch_off("Changing watches", "watches"))
    existing = ctx.store.get_doc(WATCHES, str(data.get("watch_id") or ""))
    watch = Watch.model_validate({**(existing or {}), **data, "watch_id": (existing or {}).get("watch_id") or f"W-{uuid.uuid4().hex[:8]}",
                                  "created_by": (existing or {}).get("created_by") or actor, "updated_by": actor, "updated_at": ctx.now()})
    watch.name, watch.question = watch.name.strip(), watch.question.strip()
    if not watch.name or not watch.question:
        raise ValueError("A watch needs a name and a yes/no question.")
    watch.topics = [t for t in dict.fromkeys(clean_topic(t) for t in watch.topics) if t][:20]
    watch.networks = [n.strip().lower() for n in watch.networks if n.strip()]
    limit = ctx.config.platform.campaigns.watch_max_enabled
    others_on = [w for w in list_watches(ctx) if w.enabled and w.watch_id != watch.watch_id]
    if watch.enabled and len(others_on) >= limit:
        raise ValueError(f"At most {limit} watches can be ON at once. Turn one OFF first.")
    ctx.store.put_doc(WATCHES, watch.watch_id, watch.model_dump(mode="json"))
    ctx.emit(PlatformEvent.WATCH_SAVED, actor=actor, payload={"watch_id": watch.watch_id, "name": watch.name, "enabled": watch.enabled})
    audit.record(ctx, actor=actor, action="watch.save", surface="console", target_type="watch", target_id=watch.watch_id,
                 summary=f"{'Updated' if existing else 'Added'} watch “{watch.name}” ({'ON' if watch.enabled else 'OFF'})")
    return watch


def delete_watch(ctx: "AgentContext", actor: str, watch_id: str) -> bool:
    from . import audit

    row = ctx.store.get_doc(WATCHES, watch_id)
    if row is None:
        return False
    ctx.store.delete_doc(WATCHES, watch_id)
    audit.record(ctx, actor=actor, action="watch.delete", surface="console", target_type="watch", target_id=watch_id,
                 summary=f"Removed watch “{row.get('name')}”")
    return True


def look_sql(src: Any, watches: list[Watch], cfg: Any) -> tuple[str, dict[str, Any]]:
    """One look at one source: the new posts, each watch's question, the matches' scores and topics."""
    from .bq_admin import check_table_id
    from .tempcheck import _ident, read_of

    if src.read_sql.strip():  # a table with its own read: the rows that arrived since the last look, in the shape the read gives
        new_posts = (
            "new_posts AS (\n"
            "  SELECT platform, author, IFNULL(text, '') AS txt, url AS post_url, posted, SAFE_CAST(followers AS INT64) AS followers,\n"
            "    SAFE_CAST(eng AS FLOAT64) AS eng\n"
            f"  FROM (\n    {read_of(src)}\n  )\n  WHERE seen >= @since AND seen < @until\n"
            "  QUALIFY ROW_NUMBER() OVER (PARTITION BY one ORDER BY seen DESC) = 1\n),\n")
    else:
        if not src.time_column or not src.text_columns or not src.url_column:
            raise ValueError("The source needs a time column, a text column and a link column (Settings → Temp check → sources).")
        table = check_table_id(src.table)
        t = _ident(src.time_column, "time column")
        text = " , ' ', ".join(f"IFNULL(CAST({_ident(c, 'text column')} AS STRING), '')" for c in src.text_columns)
        platform = (f"LOWER(CAST({_ident(src.platform_column, 'platform column')} AS STRING))" if src.platform_column
                    else (f"'{src.platform_value.lower()}'" if re.fullmatch(r"[\w -]+", src.platform_value or "") else "''"))
        followers = f"SAFE_CAST({_ident(src.followers_column, 'followers column')} AS INT64)" if src.followers_column else "CAST(NULL AS INT64)"
        eng = f"SAFE_CAST(({src.engagement_expr}) AS FLOAT64)" if src.engagement_expr.strip() else "CAST(NULL AS FLOAT64)"
        author = f"CAST({_ident(src.author_column, 'author column')} AS STRING)" if src.author_column else "CAST(NULL AS STRING)"
        extra = f" AND ({src.filter_sql})" if src.filter_sql.strip() else ""
        new_posts = (
            "new_posts AS (\n"
            f"  SELECT IF({platform} = 'twitter', 'x', {platform}) AS platform, {author} AS author, CONCAT({text}) AS txt,\n"
            f"    CAST({_ident(src.url_column, 'url column')} AS STRING) AS post_url, {t} AS posted, {followers} AS followers, {eng} AS eng\n"
            f"  FROM `{table}`\n  WHERE {t} >= @since AND {t} < @until{extra}\n"
            f"  QUALIFY ROW_NUMBER() OVER (PARTITION BY CAST({_ident(src.url_column, 'url column')} AS STRING) ORDER BY {t} DESC) = 1\n),\n")
    params: dict[str, Any] = {"cap": cfg.watch_posts_per_look, "min_f": cfg.watch_min_followers, "min_e": cfg.watch_min_engagement,
                              "near": float(cfg.watch_near_miss)}
    structs = []
    for i, w in enumerate(watches):
        params[f"w{i}_name"], params[f"w{i}_cond"] = w.name, w.question
        params[f"w{i}_rubric"] = w.rubric or "Score 1-10 how likely this post is to become a brand-safety issue in the next 6 hours."
        params[f"w{i}_nets"] = "|".join(w.networks)
        params[f"w{i}_bar"] = float(w.flag_at_score or cfg.watch_default_bar)
        structs.append(f"STRUCT({i} AS idx, @w{i}_name AS watch, @w{i}_cond AS cond, @w{i}_rubric AS rubric, @w{i}_bar AS bar, @w{i}_nets AS nets)")
    topics = [t for t in dict.fromkeys(clean_topic(t) for w in watches for t in (w.topics or cfg.watch_default_topics)) if t][:20]
    connection = ""
    if cfg.watch_ai_connection:
        if not re.fullmatch(r"[\w.-]+", cfg.watch_ai_connection):
            raise ValueError("The AI connection name has characters that are not allowed.")
        connection = f", connection_id => '{cfg.watch_ai_connection}'"
    classify = (f"AI.CLASSIFY(s.txt, [{', '.join(repr(t) for t in [*topics, 'Other'])}]{connection})" if topics else "CAST(NULL AS STRING)")
    sql = (
        f"WITH watches AS (\n  SELECT * FROM UNNEST([{', '.join(structs)}])\n),\n"
        + new_posts +
        "cand AS (\n  SELECT *, ROW_NUMBER() OVER (ORDER BY IFNULL(eng, 0) DESC, IFNULL(followers, 0) DESC) AS rk\n  FROM new_posts\n"
        "  WHERE post_url IS NOT NULL AND LENGTH(TRIM(txt)) > 0 AND posted >= @posted_since\n"
        "    AND (IFNULL(followers, 0) >= @min_f OR IFNULL(eng, 0) >= @min_e)\n),\n"
        "hits AS (\n  SELECT c.*, w.idx, w.watch, w.rubric, w.bar\n  FROM cand c CROSS JOIN watches w\n"
        "  WHERE c.rk <= @cap AND (w.nets = '' OR c.platform IN UNNEST(SPLIT(w.nets, '|')))\n"
        f"    AND AI.IF(CONCAT(w.cond, '\\n\\n{ENGLISH_RULE}\\n\\n', c.txt){connection})\n),\n"
        "scored AS (\n  SELECT *, AI.SCORE(CONCAT(rubric, '\\n\\nAuthor reach: ', IFNULL(CAST(followers AS STRING), 'unknown'),\n"
        f"    ' followers. Engagements so far: ', IFNULL(CAST(eng AS STRING), 'unknown'), '.\\n\\n', txt){connection}) AS impact\n  FROM hits\n)\n"
        "SELECT 'hit' AS kind, s.idx, s.watch, s.post_url, s.platform, s.author, s.followers, s.eng, s.posted,\n"
        f"  SUBSTR(s.txt, 1, 400) AS summary, ROUND(s.impact, 1) AS impact, s.bar, {classify} AS topic,\n"
        "  CAST(NULL AS INT64) AS found, CAST(NULL AS INT64) AS checked\n"
        "FROM scored s WHERE s.impact >= GREATEST(1, s.bar - @near)\n"
        "UNION ALL\n"
        "SELECT 'src', CAST(NULL AS INT64), CAST(NULL AS STRING), CAST(NULL AS STRING), CAST(NULL AS STRING), CAST(NULL AS STRING),\n"
        "  CAST(NULL AS INT64), CAST(NULL AS FLOAT64), MAX(posted), CAST(NULL AS STRING), CAST(NULL AS FLOAT64), CAST(NULL AS FLOAT64),\n"
        "  CAST(NULL AS STRING), COUNT(*), COUNTIF(rk <= @cap)\nFROM cand"
    )
    return sql, params


def run_due(ctx: "AgentContext", actor: str = "agent", force: bool = False) -> dict[str, Any]:
    """One look for every source that is due. Returns what each source handed over and what was flagged."""
    from . import bq_admin

    cfg = ctx.config.platform.campaigns
    now = ctx.now()
    watches = [w for w in list_watches(ctx) if w.enabled][: cfg.watch_max_enabled]
    if not watches:
        return {"watches": 0, "summary": ""}
    by_key = {s.key: s for s in ctx.config.platform.temp_check.sources if s.enabled and s.table}
    sources = [by_key[k] for k in cfg.watch_sources if k in by_key]
    if not sources:
        _set_status(ctx, watches, "⚠ no source: name post tables under Settings → Campaigns → watch_sources")
        return {"watches": len(watches), "sources": 0, "summary": "watches: no source is set"}
    try:
        gw = bq_admin.get_gateway(ctx)
    except Exception as exc:  # noqa: BLE001
        _set_status(ctx, watches, f"⚠ BigQuery isn't connected: {exc}"[:200])
        return {"watches": len(watches), "error": str(exc), "summary": "watches: BigQuery isn't connected"}
    results, flagged = [], 0
    for src in sources:
        state = ctx.store.get_doc(SOURCES_STATE, src.key) or {"key": src.key}
        last = datetime.fromisoformat(state["last_look"]) if state.get("last_look") else None
        if last and not force and now - last < timedelta(minutes=cfg.watch_interval_minutes):
            continue
        cursor = datetime.fromisoformat(state["cursor"]) if state.get("cursor") else now - timedelta(minutes=cfg.watch_first_look_minutes)
        since = max(cursor, now - timedelta(minutes=cfg.watch_max_look_minutes))
        entry: dict[str, Any] = {"source": src.key, "since": since.isoformat()}
        try:
            sql, params = look_sql(src, watches, cfg)
            params.update({"since": since, "until": now, "posted_since": now - timedelta(hours=cfg.watch_posted_within_hours)})
            if src.read_sql.strip():  # the stretch a table's own read covers
                params.update({"t_from": since, "t_to": now})
            rows = gw.query(sql, params, location=src.location or None, max_rows=5000, labels={"app": "triage-agent", "job": "watch"})
            hits = [r for r in rows if r.get("kind") == "hit"]
            meta = next((r for r in rows if r.get("kind") == "src"), {})
            new = _record(ctx, src.key, watches, hits, now)
            flagged += sum(1 for d in new if d.at_bar)
            entry.update({"found": int(meta.get("found") or 0), "checked": int(meta.get("checked") or 0), "detections": len(new)})
            state.update({"cursor": now.isoformat(), "last_look": now.isoformat(), "status": "live", "error": "", "failures": 0,
                          "found": entry["found"], "checked": entry["checked"], "label": src.label or src.key,
                          "newest": meta.get("posted") or state.get("newest")})
        except Exception as exc:  # noqa: BLE001 - noted; tried again from the same start at the next look
            failures = int(state.get("failures") or 0) + 1
            entry["error"] = str(exc)[:300]
            state.update({"last_look": now.isoformat(), "status": "failing", "error": entry["error"], "failures": failures,
                          "label": src.label or src.key})
            if failures >= 3:  # after 3 tries the window is skipped, so one bad window never stops the watch
                state["cursor"], state["failures"] = now.isoformat(), 0
        ctx.store.put_doc(SOURCES_STATE, src.key, state)
        results.append(entry)
    if results:
        errors = [r for r in results if r.get("error")]
        _set_status(ctx, watches, f"looked at {len(results)} source(s) at {now:%H:%M} UTC" + (f"; {len(errors)} failing" if errors else ""))
        link_alerts(ctx)
    return {"watches": len(watches), "sources": results, "flagged": flagged,
            "summary": f"watches: {flagged} flagged" if flagged else ""}


def _set_status(ctx: "AgentContext", watches: list[Watch], status: str) -> None:
    for w in watches:
        if w.status != status:
            w.status = status
            ctx.store.put_doc(WATCHES, w.watch_id, w.model_dump(mode="json"))


def _record(ctx: "AgentContext", source: str, watches: list[Watch], hits: list[dict[str, Any]], now: datetime) -> list[Detection]:
    """Keep each hit once a watch and a post; post the ones at the bar where a target is set."""
    from .tempcheck import post_key

    cfg = ctx.config.platform.campaigns
    out = []
    for h in hits:
        idx = int(h.get("idx") or 0)
        if idx >= len(watches) or not h.get("post_url"):
            continue
        w = watches[idx]
        key = re.sub(r"[^\w.-]", "_", f"{w.watch_id}:{post_key(h['post_url'])}")[:400]
        score, bar = float(h.get("impact") or 0), float(h.get("bar") or cfg.watch_default_bar)
        det = Detection(detection_id=key, watch_id=w.watch_id, watch=w.name, seen_at=now, score=score, bar=bar, at_bar=score >= bar,
                        topic=str(h.get("topic") or ""), post_url=h["post_url"], source=source, platform=str(h.get("platform") or ""),
                        author=str(h.get("author") or ""), followers=h.get("followers"), engagement=h.get("eng"),
                        posted_at=h.get("posted"), summary=str(h.get("summary") or ""))
        if not ctx.store.create_doc(DETECTIONS, key, det.model_dump(mode="json")):
            continue
        ctx.emit(PlatformEvent.WATCH_DETECTED, payload={"watch_id": w.watch_id, "watch": w.name, "score": score, "at_bar": det.at_bar,
                                                        "source": source, "topic": det.topic})
        if det.at_bar and cfg.watch_post_target:
            posted = f"{det.posted_at:%b %-d %H:%M} UTC" if isinstance(det.posted_at, datetime) else "time unknown"
            text = (f"{ctx.config.agent.message_prefix} *Watch alert* · {w.name} · score {score:g}\n"
                    f"<{det.post_url}|Open the post> · {det.author or 'unknown author'} · posted {posted}\n{det.summary}")
            ctx.enqueue(cfg.watch_post_target, text, source="watch")
            det.posted_to = cfg.watch_post_target
            ctx.store.put_doc(DETECTIONS, key, det.model_dump(mode="json"))
        out.append(det)
    return out


def list_detections(ctx: "AgentContext", *, watch_id: str | None = None, days: int = 7, limit: int = 500) -> list[Detection]:
    rows = ctx.store.list_docs(DETECTIONS, where={"watch_id": watch_id} if watch_id else None,
                               since=ctx.now() - timedelta(days=days), limit=limit)
    out = [Detection.model_validate(r) for r in rows]
    out.sort(key=lambda d: d.seen_at, reverse=True)
    return out


def rate(ctx: "AgentContext", detection_id: str, rating: str, actor: str) -> Detection:
    from . import audit

    row = ctx.store.get_doc(DETECTIONS, detection_id)
    if row is None:
        raise KeyError(detection_id)
    if rating not in ("", "Useful", "Noise"):
        raise ValueError("A rating is Useful, Noise or blank.")
    det = Detection.model_validate(row)
    det.rating, det.rated_by = rating, actor  # type: ignore[assignment]
    ctx.store.put_doc(DETECTIONS, detection_id, det.model_dump(mode="json"))
    audit.record(ctx, actor=actor, action="watch.rate", surface="console", target_type="detection", target_id=detection_id,
                 summary=f"Rated a “{det.watch}” detection {rating or 'unrated'}")
    return det


def link_alerts(ctx: "AgentContext") -> int:
    """Tie detections to the alert that came in on the same post, with the watch's lead over it."""
    from .qa.record_key import normalize_url

    cfg = ctx.config.platform.campaigns
    window = timedelta(hours=cfg.watch_lead_window_hours)
    waiting = [d for d in list_detections(ctx, days=max(1, cfg.watch_lead_window_hours // 24 + 1), limit=1000) if not d.case_id]
    if not waiting:
        return 0
    by_post: dict[str, Any] = {}  # each part of a case's record key -> the first case on it
    for case in ctx.store.list_cases(since=min(d.seen_at for d in waiting) - window, limit=2000):
        for part in (case.record_key or "").split("|"):
            if part and (part not in by_post or case.created_at < by_post[part].created_at):
                by_post[part] = case
    linked = 0
    for det in waiting:
        case = by_post.get(normalize_url(det.post_url) or "")
        if case is None or abs(case.created_at - det.seen_at) > window:
            continue
        det.case_id = case.case_id
        det.lead_minutes = round((case.created_at - det.seen_at).total_seconds() / 60, 1)
        ctx.store.put_doc(DETECTIONS, det.detection_id, det.model_dump(mode="json"))
        linked += 1
    return linked


def scorecard(ctx: "AgentContext", days: int = 7) -> dict[str, Any]:
    """For each of the last `days` days: alerts that came in, how many a watch caught at its bar, how many before
    the alert and the median lead, the flags and near misses, and people's ratings."""
    from zoneinfo import ZoneInfo

    tz = ZoneInfo(ctx.config.timezone)
    now = ctx.now()
    since = now - timedelta(days=days)
    dets = list_detections(ctx, days=days, limit=5000)
    cases = [c for c in ctx.store.list_cases(since=since, limit=2000) if c.source == "burson_chat" and c.created_at >= since]
    caught: dict[str, Detection] = {}
    for d in dets:
        if d.case_id and d.at_bar and (d.case_id not in caught or d.seen_at < caught[d.case_id].seen_at):
            caught[d.case_id] = d
    rows: dict[str, dict[str, Any]] = {}
    for i in range(days):
        day = (now - timedelta(days=i)).astimezone(tz).date().isoformat()
        rows[day] = {"day": day, "alerts": 0, "caught": 0, "caught_first": 0, "leads": [], "flags": 0, "near_misses": 0,
                     "useful": 0, "noise": 0}
    for c in cases:
        row = rows.get(c.created_at.astimezone(tz).date().isoformat())
        if row is None:
            continue
        row["alerts"] += 1
        d = caught.get(c.case_id)
        if d:
            row["caught"] += 1
            if (d.lead_minutes or 0) > 0:
                row["caught_first"] += 1
                row["leads"].append(d.lead_minutes)
    for d in dets:
        row = rows.get(d.seen_at.astimezone(tz).date().isoformat())
        if row is None:
            continue
        row["flags" if d.at_bar else "near_misses"] += 1
        row["useful"] += 1 if d.rating == "Useful" else 0
        row["noise"] += 1 if d.rating == "Noise" else 0
    out = []
    all_leads: list[float] = []
    for row in sorted(rows.values(), key=lambda r: r["day"], reverse=True):
        leads = row.pop("leads")
        all_leads += leads
        row["median_lead_min"] = round(statistics.median(leads), 1) if leads else None
        out.append(row)
    total = {k: sum(r[k] for r in out) for k in ("alerts", "caught", "caught_first", "flags", "near_misses", "useful", "noise")}
    total["median_lead_min"] = round(statistics.median(all_leads), 1) if all_leads else None
    return {"days": out, "total": total,
            "sources": sorted(ctx.store.list_docs(SOURCES_STATE, limit=100), key=lambda s: s.get("key", ""))}
