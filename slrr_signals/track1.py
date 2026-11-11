"""Track 1 (official, strict): rules, then Gemini, then the Collection Requirements engine, into classified_mentions.

Every landed post gets one row: posts the rules stop are logged (passed_rules = false) and never reach Gemini or the
chat. Survivors get Gemini's structured classification, then triage_agent.qa.requirements.evaluate (the same engine
that QAs Burson's alerts) decides whether it meets the Collection Requirements. A row qualifies only when it meets
them, Gemini is at least track1.min_confidence sure, it is relevant, and the post wasn't reported in the last 14 days.
Qualifying rows wait in v_track1_ready: only the chatbot, with its own hand-off switch ON, ever takes them.
"""

from __future__ import annotations

import datetime as dt
import logging
from typing import Any

from triage_agent.models import Case, CaseStatus
from triage_agent.qa import requirements

from . import guards
from .classify import DISPLAY_NETWORK, Track1Classification, tags_from_config, track1_prompt, track1_system
from .guards import Budget
from .ingest import ET
from .rules import Rules, norm
from .settings import Settings
from .warehouse import Warehouse

log = logging.getLogger("slrr_signals.track1")
STAGE = "track1"


def load_context(wh: Warehouse, settings: Settings) -> dict[str, Any]:
    loc = settings.dataset_location
    taxonomy = wh.query(f"SELECT kind, priority, name, label, description, short_version, also_known_as, value, is_on, version "
                        f"FROM `{settings.table('v_taxonomy_current')}`", location=loc)
    kofs = wh.query(f"SELECT handle FROM `{settings.table('kof_list')}` WHERE handle IS NOT NULL", location=loc)
    history = wh.query(f"SELECT alert_id, record_key, issue_name, exposure_tag, priority, alerted_at "
                       f"FROM `{settings.table('v_issue_history_14d')}`", location=loc)
    return {"taxonomy": taxonomy, "kofs": [str(k["handle"]) for k in kofs], "history": history}


def day_start(now: dt.datetime) -> dt.datetime:
    local = now.astimezone(ET)
    return local.replace(hour=0, minute=0, second=0, microsecond=0).astimezone(dt.UTC)


def used_today(wh: Warehouse, settings: Settings, now: dt.datetime) -> tuple[int, int]:
    """(Gemini classifications, web checks) made today (ET)."""
    rows = wh.query(f"SELECT COUNTIF(passed_rules AND model IS NOT NULL) AS llm, COUNTIF(web_context IS NOT NULL) AS web "
                    f"FROM `{settings.table('classified_mentions')}` WHERE classified_at >= @start",
                    {"start": day_start(now)}, location=settings.dataset_location)
    r = rows[0] if rows else {}
    return int(r.get("llm") or 0), int(r.get("web") or 0)


def candidates(wh: Warehouse, settings: Settings, limit: int, *, hours: int = 6, reprocess: bool = False) -> list[dict[str, Any]]:
    """Landed posts with no classification yet (or, reprocessing, none under the current rules and prompt versions)."""
    done = (f"SELECT DISTINCT mention_key FROM `{settings.table('classified_mentions')}` "
            "WHERE classified_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 14 DAY)")
    params: dict[str, Any] = {"limit": int(limit), "hours": int(hours)}
    if reprocess:
        done += " AND rules_version = @rv AND prompt_version = @pv"
        params.update(rv=str(settings.get("track1.rules_version")), pv=str(settings.get("track1.prompt_version")))
    sql = (f"SELECT r.* FROM `{settings.table('raw_mentions')}` r LEFT JOIN ({done}) c USING (mention_key) "
           "WHERE r.ingested_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @hours HOUR) AND c.mention_key IS NULL "
           "QUALIFY ROW_NUMBER() OVER (PARTITION BY r.mention_key ORDER BY r.ingested_at) = 1 "
           "ORDER BY r.ingested_at DESC LIMIT @limit")
    return wh.query(sql, params, location=settings.dataset_location)


def history_cases(history: list[dict[str, Any]]) -> list[Case]:
    out = []
    for h in history:
        at = guards._ts(h.get("alerted_at"))
        try:
            out.append(Case(case_id=str(h.get("alert_id") or h.get("record_key") or "unknown"), record_key=h.get("record_key"),
                            status=CaseStatus.VERIFIED, issue_name=h.get("issue_name"), exposure_tag=h.get("exposure_tag"),
                            priority=h.get("priority"), clean_posted_at=at, created_at=at or guards.now_utc(),
                            updated_at=at or guards.now_utc()))
        except Exception:  # noqa: BLE001 - a malformed history row is skipped, never fatal
            continue
    return out


def base_row(m: dict[str, Any], now: dt.datetime, settings: Settings, taxonomy_version: str | None) -> dict[str, Any]:
    return {
        "mention_key": m["mention_key"], "source": m.get("source"), "post_url": m.get("post_url"), "platform": m.get("platform"),
        "author": m.get("author"), "engagement": m.get("engagement"), "posted_at": m.get("posted_at"),
        "ingested_at": m.get("ingested_at"), "classified_at": now, "rules_version": settings.get("track1.rules_version"),
        "taxonomy_version": taxonomy_version, "model": None, "prompt_version": None, "passed_rules": False,
        "rule_track": "none", "rule_reasons": [], "products": [], "meets_requirements": False, "qualifies": False,
        "previously_reported": False,
    }


def run_track1(wh: Warehouse, settings: Settings, agent_cfg: Any, llm: Any, web: Any, now: dt.datetime, budget: Budget,
               *, reprocess_hours: int | None = None) -> dict[str, Any]:
    if not settings.get("track1.enabled", True):
        return {"status": "off"}
    per_tick = int(settings.get("track1.max_per_tick", 40))
    llm_used, web_used = used_today(wh, settings, now)
    llm_left = min(per_tick, max(0, int(settings.get("track1.max_per_day", 1500)) - llm_used))
    web_left = max(0, int(settings.get("track1.web_max_per_day", 150)) - web_used) if settings.get("track1.web_check", True) else 0
    ctx = load_context(wh, settings)
    tags = [t for t in ctx["taxonomy"] if t.get("kind") == "tag" and t.get("is_on", True)] or tags_from_config(agent_cfg)
    taxonomy_version = next((str(t.get("version")) for t in ctx["taxonomy"] if t.get("version")), "config")
    rules = Rules(settings, agent_cfg, ctx["taxonomy"], ctx["kofs"], ctx["history"])
    cases = history_cases(ctx["history"])
    system = track1_system(tags, list(agent_cfg.collection.do_not_escalate or []))
    priority_of = {}
    for t in tags:
        for n in [t.get("name"), *(t.get("also_known_as") or [])]:
            if n:
                priority_of[norm(n)] = (str(t.get("priority")), str(t.get("name")))
    found = candidates(wh, settings, per_tick * 25, hours=reprocess_hours or 6, reprocess=reprocess_hours is not None)
    dead = guards.dead_tries(wh, settings, STAGE, [str(m["mention_key"]) for m in found])
    max_tries = int(settings.get("guards.dead_letter_tries", 3))
    min_conf = float(settings.get("track1.min_confidence", 0.8))
    model = str(settings.get("models.classify", "gemini-3.8-flash"))
    rows: list[dict[str, Any]] = []
    stats = {"candidates": len(found), "stopped": 0, "classified": 0, "qualified": 0, "errors": 0, "deferred": 0}
    for m in found:
        key = str(m["mention_key"])
        if dead.get(key, 0) >= max_tries:
            continue
        res = rules.evaluate(m)
        row = base_row(m, now, settings, taxonomy_version)
        row.update(passed_rules=res.passed, rule_track=res.track, rule_reasons=res.reasons,
                   previously_reported=res.previously_reported, previous_alert_id=res.previous_alert_id)
        if not res.passed:
            rows.append(row)
            stats["stopped"] += 1
            continue
        if llm_left <= 0 or budget.expired(need=8):
            stats["deferred"] += 1  # no row: it's a candidate again next time
            continue
        try:
            c: Track1Classification = llm.generate_json(model=model, system=system, prompt=track1_prompt(m, res.track, res.reasons),
                                                        schema=Track1Classification, temperature=0.1, purpose="signals.track1")
            llm_left -= 1
            pri_name = priority_of.get(norm(c.exposure_tag)) if c.exposure_tag else None
            risk = priority_of.get(norm(c.risk_tag)) if c.risk_tag else None
            exposure_tag = pri_name[1] if pri_name and pri_name[0] in ("P0", "P1", "P2") else None
            priority = pri_name[0] if exposure_tag else None
            risk_tag = risk[1] if risk and risk[0] == "Sensitive" else None
            products = [p for p in c.products if p][:5]
            fields = {
                "alert_name": c.issue_name, "issue_name": c.issue_name, "summary": c.summary, "post_content": m.get("text") or "",
                "product": products[0] if products else None, "other_products": products[1:], "exposure_tag": exposure_tag,
                "priority": priority, "risk_tags": [risk_tag] if risk_tag else [], "kof": res.is_kof,
                "kof_lists": list(m.get("kof_lists") or []), "total_engagement": m.get("engagement"),
                "social_network": DISPLAY_NETWORK.get(str(m.get("platform") or ""), m.get("platform")),
            }
            req = requirements.evaluate(agent_cfg, fields, received_at=now, extra={"language": "en"}, history=cases,
                                        history_complete=True)
            a = req.assessment
            meets = bool(a.alertable and a.track)
            qualifies = bool(meets and c.relevant and c.urgency != "none" and c.confidence >= min_conf
                             and exposure_tag and not res.previously_reported)
            row.update(model=model, prompt_version=settings.get("track1.prompt_version"), exposure_tag=exposure_tag,
                       exposure_priority=priority, risk_tag=risk_tag, products=products, issue_name=c.issue_name,
                       summary=c.summary[:1000], urgency=c.urgency, confidence=float(c.confidence), rationale=c.rationale[:1000],
                       track=a.track, issue_status=a.issue_status, meets_requirements=meets,
                       suppression_reason=a.suppression_reason, qualifies=qualifies)
            stats["classified"] += 1
            if qualifies:
                stats["qualified"] += 1
                if web is not None and web_left > 0 and not budget.expired(need=15):
                    try:
                        row["web_context"] = web.check(f"{c.summary}\nPost: {m.get('post_url')}")
                        web_left -= 1
                    except Exception as e:  # noqa: BLE001 - the web check never blocks a classification
                        log.warning("web check failed for %s: %s", key, e)
            rows.append(row)
        except Exception as e:  # noqa: BLE001 - one post's failure never stops the others
            stats["errors"] += 1
            tries = dead.get(key, 0) + 1
            guards.record_failure(wh, settings, STAGE, key, tries, f"{type(e).__name__}: {e}", {"source": m.get("source")}, now)
            if tries >= max_tries:  # set aside for good: a row so it's never a candidate again
                row["error"] = f"gave up after {tries} tries: {str(e)[:300]}"
                rows.append(row)
            log.warning("track1 failed for %s (try %d of %d): %s", key, tries, max_tries, e)
    if rows:
        rv, pv = settings.get("track1.rules_version"), settings.get("track1.prompt_version")
        wh.insert(settings.table("classified_mentions"), rows, row_ids=[f"{r['mention_key']}:{rv}:{pv}" for r in rows])
    return stats
