"""Track 2 (radar, exploratory): sub-threshold clusters, their velocity, and Gemini's outlook, into radar_clusters.

Two kinds of cluster, read-only:
- early_detection's embedding clusters (active_clusters, their hourly rollup and their posts): the existing low-tier,
  topic-agnostic pipeline, never written to here;
- the sources' own issue groupings in raw_mentions (Pendulum's issue names) that Track 1 didn't qualify.
Each is assessed at most every track2.reassess_hours (sooner when its authors doubled), track2.max_per_run a run and
track2.max_per_day a day. Nothing is posted anywhere: high-likelihood clusters wait in v_radar_review for people.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import logging
from typing import Any

from . import guards
from .classify import Track2Assessment, tags_from_config, track2_prompt, track2_system
from .guards import Budget
from .settings import Settings
from .track1 import day_start
from .warehouse import Warehouse

log = logging.getLogger("slrr_signals.track2")
STAGE = "track2"
ED = "brand-social-central-data.early_detection"


def early_clusters(wh: Warehouse, settings: Settings, limit: int) -> list[dict[str, Any]]:
    sql = f"""
WITH c AS (
  SELECT cluster_id, cluster_label, dominant_topic_hint, total_mentions_24h, unique_authors_24h, created_at, last_seen_at
  FROM `{ED}.active_clusters`
  WHERE last_seen_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @hours HOUR) AND IFNULL(unique_authors_24h, 0) >= 2
),
r AS (
  SELECT grain_key AS cluster_id,
    SUM(IF(hour_bucket >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 3 HOUR), unique_author_count, 0)) AS authors_3h,
    SUM(IF(hour_bucket < TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 3 HOUR), unique_author_count, 0)) AS authors_before
  FROM `{ED}.low_tier_hourly_rollup`
  WHERE grain_type = 'CLUSTER' AND hour_bucket >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 24 HOUR)
  GROUP BY 1
),
p AS (
  SELECT a.cluster_id,
    ARRAY_AGG(STRUCT(m.platform AS platform, SUBSTR(IFNULL(m.clean_text, m.raw_text), 1, 400) AS text, m.canonical_url AS url)
      ORDER BY m.engagement_count DESC LIMIT 8) AS posts,
    ARRAY_AGG(DISTINCT m.platform IGNORE NULLS) AS platforms
  FROM `{ED}.mention_cluster_assignments` a
  JOIN `{ED}.low_tier_mentions` m USING (mention_id)
  WHERE a.assigned_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 24 HOUR)
    AND m.ingested_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 HOUR)
    AND a.cluster_id IN (SELECT cluster_id FROM c)
  GROUP BY 1
)
SELECT c.*, r.authors_3h, r.authors_before, p.posts, p.platforms
FROM c LEFT JOIN r USING (cluster_id) LEFT JOIN p USING (cluster_id)
ORDER BY IFNULL(r.authors_3h, 0) DESC, c.unique_authors_24h DESC
LIMIT @limit"""
    rows = wh.query(sql, {"hours": int(settings.get("track2.lookback_hours", 24)), "limit": int(limit)}, location="US")
    out = []
    for r in rows:
        a3, before = int(r.get("authors_3h") or 0), int(r.get("authors_before") or 0)
        out.append({
            "cluster_id": f"ed:{r['cluster_id']}", "origin": "early_detection", "origin_ref": r["cluster_id"],
            "label": r.get("cluster_label"), "topic": r.get("dominant_topic_hint"), "mentions": r.get("total_mentions_24h"),
            "authors": r.get("unique_authors_24h"), "platforms": list(r.get("platforms") or []),
            "posts": [dict(p) for p in (r.get("posts") or [])], "first_seen": r.get("created_at"), "last_seen": r.get("last_seen_at"),
            "growth_per_hour": round(a3 / 3.0, 2), "velocity_ratio": round((a3 / 3.0) / max(before / 21.0, 0.5), 2),
        })
    return out


def issue_clusters(wh: Warehouse, settings: Settings, limit: int) -> list[dict[str, Any]]:
    """The sources' own issue groupings (Pendulum's issue names) among posts Track 1 didn't qualify, 3+ authors."""
    sql = f"""
SELECT JSON_VALUE(r.extra, '$.issue') AS issue, COUNT(DISTINCT r.mention_key) AS mentions,
  COUNT(DISTINCT LOWER(IFNULL(r.author, r.mention_key))) AS authors,
  COUNT(DISTINCT IF(r.ingested_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 3 HOUR), LOWER(IFNULL(r.author, r.mention_key)), NULL)) AS authors_3h,
  ARRAY_AGG(DISTINCT r.platform IGNORE NULLS) AS platforms,
  ARRAY_AGG(STRUCT(r.platform AS platform, SUBSTR(COALESCE(r.text, r.title, ''), 1, 400) AS text, r.post_url AS url)
    ORDER BY IFNULL(r.engagement, 0) DESC LIMIT 8) AS posts,
  MIN(r.ingested_at) AS first_seen, MAX(r.ingested_at) AS last_seen
FROM `{settings.table('raw_mentions')}` r
LEFT JOIN `{settings.table('v_track1_latest')}` c USING (mention_key)
WHERE r.ingested_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @hours HOUR) AND NOT IFNULL(c.qualifies, FALSE)
  AND IFNULL(JSON_VALUE(r.extra, '$.issue'), '') != ''
GROUP BY 1
HAVING authors >= 3
ORDER BY authors_3h DESC, authors DESC
LIMIT @limit"""
    rows = wh.query(sql, {"hours": int(settings.get("track2.lookback_hours", 24)), "limit": int(limit)},
                    location=settings.dataset_location)
    out = []
    for r in rows:
        issue = str(r["issue"])
        a3, total = int(r.get("authors_3h") or 0), int(r.get("authors") or 0)
        out.append({
            "cluster_id": "issue:" + hashlib.sha1(issue.lower().encode()).hexdigest()[:16], "origin": "raw_mentions",
            "origin_ref": issue[:200], "label": issue, "topic": None, "mentions": r.get("mentions"), "authors": total,
            "platforms": list(r.get("platforms") or []), "posts": [dict(p) for p in (r.get("posts") or [])],
            "first_seen": r.get("first_seen"), "last_seen": r.get("last_seen"), "growth_per_hour": round(a3 / 3.0, 2),
            "velocity_ratio": round((a3 / 3.0) / max((total - a3) / 21.0, 0.5), 2),
        })
    return out


def due(clusters: list[dict[str, Any]], latest: dict[str, dict[str, Any]], now: dt.datetime, hours: float) -> list[dict[str, Any]]:
    """Clusters never assessed, assessed over `hours` ago, or whose authors doubled since."""
    out = []
    for c in clusters:
        last = latest.get(c["cluster_id"])
        if not last:
            out.append(c)
            continue
        at = guards._ts(last.get("assessed_at"))
        grew = int(c.get("authors") or 0) >= 2 * max(1, int(last.get("authors") or 0))
        if grew or at is None or now - at >= dt.timedelta(hours=hours):
            out.append(c)
    return out


def run_track2(wh: Warehouse, settings: Settings, agent_cfg: Any, llm: Any, web: Any, now: dt.datetime,
               budget: Budget) -> dict[str, Any]:
    if not settings.get("track2.enabled", True):
        return {"status": "off"}
    loc = settings.dataset_location
    used = wh.query(f"SELECT COUNT(*) AS n, COUNTIF(web_context IS NOT NULL) AS web FROM `{settings.table('radar_clusters')}` "
                    "WHERE assessed_at >= @start", {"start": day_start(now)}, location=loc)
    n_used, web_used = (int(used[0].get("n") or 0), int(used[0].get("web") or 0)) if used else (0, 0)
    left = min(int(settings.get("track2.max_per_run", 12)), max(0, int(settings.get("track2.max_per_day", 250)) - n_used))
    web_left = max(0, int(settings.get("track2.web_max_per_day", 60)) - web_used) if settings.get("track2.web_check", True) else 0
    stats: dict[str, Any] = {"candidates": 0, "assessed": 0, "errors": 0, "origins": {}}
    if left <= 0:
        stats["status"] = "day maximum reached"
        return stats
    clusters: list[dict[str, Any]] = []
    for name, fn in (("early_detection", early_clusters), ("raw_mentions", issue_clusters)):
        try:
            got = fn(wh, settings, left * 3)
            clusters += got
            stats["origins"][name] = len(got)
        except Exception as e:  # noqa: BLE001 - one origin failing never stops the other
            stats["origins"][name] = f"error: {str(e)[:200]}"
            log.warning("track2 origin %s failed: %s", name, e)
    ids = [c["cluster_id"] for c in clusters]
    latest = {}
    if ids:
        for r in wh.query(f"SELECT cluster_id, assessed_at, authors FROM `{settings.table('v_radar_latest')}` "
                          "WHERE cluster_id IN UNNEST(@ids)", {"ids": ids}, location=loc):
            latest[str(r["cluster_id"])] = r
    todo = due(clusters, latest, now, float(settings.get("track2.reassess_hours", 6)))
    stats["candidates"] = len(todo)
    dead = guards.dead_tries(wh, settings, STAGE, [c["cluster_id"] for c in todo])
    max_tries = int(settings.get("guards.dead_letter_tries", 3))
    tax = wh.query(f"SELECT priority, name, description, short_version FROM `{settings.table('v_taxonomy_current')}` "
                   "WHERE kind = 'tag' AND IFNULL(is_on, TRUE)", location=loc) or tags_from_config(agent_cfg)
    system = track2_system(tax)
    model = str(settings.get("models.radar", "gemini-3.8-flash"))
    rows = []
    for c in todo[:left]:
        if dead.get(c["cluster_id"], 0) >= max_tries:
            continue
        if budget.expired(need=10):
            break
        try:
            a: Track2Assessment = llm.generate_json(model=model, system=system, prompt=track2_prompt(c), schema=Track2Assessment,
                                                    temperature=0.2, purpose="signals.track2")
            pri = next((str(t.get("priority")) for t in tax if a.closest_tag and str(t.get("name")) == a.closest_tag), None)
            row = {
                "cluster_id": c["cluster_id"], "assessed_at": now, "origin": c["origin"], "origin_ref": str(c["origin_ref"]),
                "headline": (a.headline or c.get("label") or "")[:300],
                "representative_texts": [str(p.get("text") or "")[:400] for p in c.get("posts", [])][:8],
                "post_urls": [str(p.get("url")) for p in c.get("posts", []) if p.get("url")][:8],
                "mentions": c.get("mentions"), "authors": c.get("authors"), "platforms": c.get("platforms", []),
                "velocity_ratio": c.get("velocity_ratio"), "growth_per_hour": c.get("growth_per_hour"),
                "first_seen": guards._ts(c.get("first_seen")), "last_seen": guards._ts(c.get("last_seen")),
                "likelihood": a.likelihood, "closest_tag": a.closest_tag, "closest_priority": pri, "action": a.action,
                "rationale": a.rationale[:1000], "confidence": float(a.confidence), "model": model,
                "prompt_version": settings.get("track2.prompt_version"),
            }
            if a.likelihood == "high" and web is not None and web_left > 0 and not budget.expired(need=15):
                try:
                    row["web_context"] = web.check(f"{row['headline']}\n" + "\n".join(row["representative_texts"][:3]))
                    web_left -= 1
                except Exception as e:  # noqa: BLE001
                    log.warning("web check failed for %s: %s", c["cluster_id"], e)
            rows.append(row)
            stats["assessed"] += 1
        except Exception as e:  # noqa: BLE001
            stats["errors"] += 1
            tries = dead.get(c["cluster_id"], 0) + 1
            guards.record_failure(wh, settings, STAGE, c["cluster_id"], tries, f"{type(e).__name__}: {e}", {"origin": c["origin"]}, now)
            log.warning("track2 failed for %s (try %d of %d): %s", c["cluster_id"], tries, max_tries, e)
    if rows:
        wh.insert(settings.table("radar_clusters"), rows,
                  row_ids=[f"{r['cluster_id']}:{r['assessed_at'].isoformat()}" for r in rows])
    return stats
