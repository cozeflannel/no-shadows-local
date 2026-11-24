"""Stories (the map and its drill-down), the comparison of the app with Burson and the IMs, and the Admin overview."""

from __future__ import annotations

import logging
import os
import re
from collections import Counter
from datetime import datetime, timedelta
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field, ValidationError

from triage_agent import audit, chatlog, pubsub, safety, stories, storyread
from triage_agent.config import owner_admins, switch_off
from triage_agent.context import ROSTER_IM, AgentContext
from triage_agent.events import EventType as E
from triage_agent.events import PlatformEvent as P
from triage_agent.metrics import compute_kpis
from triage_agent.models import Person
from triage_agent.platform_jobs import TICK_KEY

from . import gmail_oauth
from .auth import BOOTSTRAP_ADMIN_ENV, User, get_ctx, require_admin, require_analyst, require_lead, require_viewer
from .live import feed_card
from .routes_cases import get_parity
from .routes_metrics import env_filter, window
from .routes_settings import format_errors, save_sections

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["insight"])

STORY_ALERTS = 200  # alerts opened in one drill-down
STORY_CHAT = 200
CHANGE_PREFIXES = ("settings.", "secret.", "bigquery.", "delivery.", "prompt.", "people.", "connection.")
CHANGE_PATHS = ("/api/settings/", "/api/rosters/")


# -- stories ---------------------------------------------------------------------------------------------------------------------
def _refresh(ctx: AgentContext) -> None:
    try:
        stories.refresh(ctx)
    except Exception:  # noqa: BLE001 - the map still shows what is already placed
        log.exception("stories could not be refreshed")


def _story_card(ctx: AgentContext, story: stories.Story, read: dict[str, Any] | None, since: datetime | None = None) -> dict[str, Any]:
    """A story as the map shows it, with what Gemini's read adds: topic, name, the counted labels and each alert's label."""
    card = {**stories.summary(ctx, story, since=since), **storyread.card(ctx, story, read)}
    labels = (read or {}).get("labels") or {}
    for point in card["points"]:
        point["m"] = labels.get(point["id"], "")
    return card


def _facet(cards: list[dict[str, Any]], key: str) -> list[dict[str, Any]]:
    """The values of `key` the stories carry, with how many stories and alerts each has: the choices to filter by."""
    seen: dict[str, dict[str, Any]] = {}
    for c in cards:
        value = str(c.get(key) or "")
        if not value:
            continue
        row = seen.setdefault(value, {"value": value, "stories": 0, "alerts": 0})
        row["stories"] += 1
        row["alerts"] += c["alerts"]
    return sorted(seen.values(), key=lambda r: (-r["alerts"], r["value"]))


@router.get("/stories")
def get_stories(
    hours: int | None = Query(None, ge=1, le=24 * 30),
    env: str | None = None,
    ctx: AgentContext = Depends(get_ctx),
    user: User = Depends(require_viewer),
) -> dict[str, Any]:
    cfg = ctx.config.platform.stories
    _refresh(ctx)
    span = hours or cfg.map_hours
    since = ctx.now() - timedelta(hours=span)
    reads = storyread.reads_since(ctx, ctx.now() - timedelta(days=cfg.keep_days))
    cards = [_story_card(ctx, s, reads.get(s.story_id), since) for s in stories.list_stories(ctx, since, env=env_filter(ctx, env))]
    cards.sort(key=lambda c: (-c["size"], -c["alerts"]))
    return {"stories": cards, "hours": span, "since": since, "as_of": ctx.now(), "size_by": cfg.size_by, "active_hours": cfg.active_hours,
            "by_meaning": bool(ctx.config.platform.knowledge.embedding_model), "reads_on": ctx.flag("story_reads"),
            "negative_share": cfg.negative_share, "positive_share": cfg.positive_share, "min_rated_share": cfg.min_rated_share,
            "facets": {"products": _facet(cards, "product"), "topics": _facet(cards, "topic"), "tones": _facet(cards, "tone")},
            "totals": {"stories": len(cards), "alerts": sum(c["alerts"] for c in cards), "engagement": sum(c["engagement"] for c in cards),
                       "growing": sum(1 for c in cards if c["status"] != "quiet"), "needs": sum(c["needs"] for c in cards)}}


@router.get("/stories/{story_id}")
def get_story(story_id: str, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_viewer)) -> dict[str, Any]:
    _refresh(ctx)  # an alert that just came in is on its story before the story is shown
    story = stories.get(ctx, story_id)
    if story is None:
        raise HTTPException(404, {"error": f"No story {story_id}", "code": "not_found"})
    members = sorted(story.members, key=lambda m: (m.at, m.case_id), reverse=True)[:STORY_ALERTS]
    read = storyread.get(ctx, story_id)
    labels = (read or {}).get("labels") or {}
    alerts, chat = [], []
    for m in members:
        case = ctx.store.get_case(m.case_id)
        if case is None:
            continue
        alerts.append({**feed_card(ctx, case), "at": m.at, "how": m.how, "sim": m.sim, "also": m.also,
                       "sentiment": labels.get(m.case_id, ""), "post_text": stories.post_text(case)})
        if len(chat) < STORY_CHAT:
            chat.extend(x.model_dump(mode="json") for x in chatlog.search(ctx, case_id=m.case_id, limit=20))
    chat.sort(key=lambda x: str(x.get("ts")), reverse=True)
    return {"story": _story_card(ctx, story, read), "read": _read_view(story, read), "alerts": alerts, "chat": chat[:STORY_CHAT],
            "shown": len(alerts), "total": len(story.members), "reads_on": ctx.flag("story_reads")}


def _read_view(story: stories.Story, read: dict[str, Any] | None) -> dict[str, Any] | None:
    if not read:
        return None
    return {"topic": read.get("topic") or "", "name": read.get("name") or "", "summary": read.get("summary") or "", "at": read.get("at"),
            "read": int(read.get("read") or 0), "members": int(read.get("members") or 0), "model": read.get("model") or "",
            "stale": int(read.get("members") or 0) != len(story.members)}


@router.post("/stories/{story_id}/read")
def read_story(story_id: str, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_analyst)) -> dict[str, Any]:
    """Have Gemini read one story now: its topic, a neutral name, a short summary and a label for each post."""
    if not ctx.flag("story_reads"):
        raise HTTPException(400, {"error": switch_off("Reading stories", "story_reads"), "code": "switched_off"})
    story = stories.get(ctx, story_id)
    if story is None:
        raise HTTPException(404, {"error": f"No story {story_id}", "code": "not_found"})
    try:
        read = storyread.read(ctx, story)
    except Exception as exc:  # noqa: BLE001 - Gemini could not be asked
        raise HTTPException(503, {"error": f"Gemini could not read this story: {str(exc)[:200]}", "code": "read_failed"}) from exc
    audit.record(ctx, actor=user.email, action="story.read", surface="console", target_type="story", target_id=story_id,
                 summary=f"Had Gemini read story {story_id}", detail={"topic": read["topic"], "posts": read["read"]})
    return {"read": _read_view(story, read), "story": _story_card(ctx, story, read)}


# -- the app, Burson and the IMs, side by side -------------------------------------------------------------------------------------
def _row(key: str, label: str, value: Any, unit: str = "count", note: str = "", previous: Any = None) -> dict[str, Any]:
    return {"key": key, "label": label, "value": value, "unit": unit, "note": note, "previous": previous}


def _median(stat: Any) -> Any:
    return stat.get("median", stat.get("p50")) if isinstance(stat, dict) else stat


@router.get("/compare")
def get_compare(
    days: int = Query(7, ge=1, le=180),
    env: str | None = None,
    ctx: AgentContext = Depends(get_ctx),
    user: User = Depends(require_viewer),
) -> dict[str, Any]:
    """One page of numbers: Burson's alerts as the app found them, the app's own detection against Burson's, and how
    often the IMs agreed with the app."""
    since, until = window(days, now=ctx.now())
    env_f = env_filter(ctx, env)
    events = ctx.events.query(since=since, until=until, env=env_f)
    before = ctx.events.query(since=since - (until - since), until=since, env=env_f)
    now_, then = compute_kpis(events, ctx.config), compute_kpis(before, ctx.config)
    k, d, pk, pd = now_["kpis"], now_["derived"], then["kpis"], then["derived"]

    def judged(rows: list[Any]) -> tuple[int, int]:
        said = [bool((e.payload or {}).get("agree")) for e in rows if e.event_type == P.ASSESSMENT_RECORDED]
        return sum(said), len(said) - sum(said)

    right, wrong = judged(events)
    p_right, p_wrong = judged(before)
    parity = get_parity(days=days, env=env, ctx=ctx, user=user)
    ps = parity["summary"]
    compared = ps["matched"] + ps["burson_only"] + ps["inhouse_only"]
    no_parity = "" if compared else "No in-house alert was compared with Burson's in this window."

    def pct(a: int, b: int) -> float | None:
        return round(a / b, 3) if b else None

    sections = [
        {"key": "burson", "title": "Burson's alerts, checked by the app", "rows": [
            _row("alerts_received", "Alerts received", k["alerts_received"], previous=pk["alerts_received"]),
            _row("first_pass_yield", "Right as Burson sent them", d["first_pass_yield"], "pct", previous=pd["first_pass_yield"]),
            _row("auto_corrected", "Fixed by the app", k["auto_corrected"], previous=pk["auto_corrected"]),
            _row("sent_back_for_edits", "Sent back to Burson", k["sent_back_for_edits"], previous=pk["sent_back_for_edits"]),
            _row("burson_reruns_passed", "Passed after Burson's fix", k["burson_reruns_passed"], previous=pk["burson_reruns_passed"]),
            _row("held_for_review", "Held for an IM", k["needs_review"], previous=pk["needs_review"]),
            _row("suppressed", "Not alertable", k["suppressed"], previous=pk["suppressed"]),
        ]},
        {"key": "detection", "title": "The app's own detection against Burson's", "rows": [
            _row("parity_matched", "Found by both", ps["matched"], note=no_parity),
            _row("parity_burson_only", "Only Burson found", ps["burson_only"]),
            _row("parity_inhouse_only", "Only the app found", ps["inhouse_only"]),
            _row("parity_recall", "Of Burson's alerts, the app also found", ps["recall"], "pct", note=no_parity),
            _row("parity_precision", "Of the app's alerts, Burson also found", ps["precision"], "pct"),
            _row("parity_full_agreement", "Found by both and classified the same", ps["full_agreement"], "pct"),
        ]},
        {"key": "ims", "title": "The IMs against the app", "rows": [
            _row("im_agreement", "IMs agreed with the app", pct(right, right + wrong), "pct", previous=pct(p_right, p_right + p_wrong),
                 note="" if right + wrong else "No IM has recorded an assessment in this window."),
            _row("im_right", "Assessments: the app was right", right, previous=p_right),
            _row("im_wrong", "Assessments: the app was wrong", wrong, previous=p_wrong),
            _row("verdict_overrides", "Verdicts an IM overrode", k["verdict_overrides"], previous=pk["verdict_overrides"]),
            _row("corrections_reverted", "App fixes an IM undid", k["corrections_reverted"], previous=pk["corrections_reverted"]),
            _row("review_forwarded", "Held alerts an IM sent on", k["review_forwarded"], previous=pk["review_forwarded"]),
            _row("review_bounced", "Held alerts an IM sent back", k["review_bounced"], previous=pk["review_bounced"]),
            _row("review_suppressed", "Held alerts an IM dropped", k["review_suppressed"], previous=pk["review_suppressed"]),
        ]},
        {"key": "speed", "title": "Speed", "rows": [
            _row("detect_latency_min", "Post to Burson's alert", _median(d["detect_latency_min"]), "min", previous=_median(pd["detect_latency_min"])),
            _row("triage_latency_ms", "The app's check", _median(d["triage_latency_ms"]), "ms", previous=_median(pd["triage_latency_ms"])),
            _row("time_to_correction_min", "Burson's fix after a send-back", _median(d["time_to_correction_min"]), "min",
                 previous=_median(pd["time_to_correction_min"])),
            _row("flag_to_send_min", "Alert to email sent", _median(d["flag_to_send_min"]), "min", previous=_median(pd["flag_to_send_min"])),
            _row("post_to_send_min", "Post to email sent", _median(d["post_to_send_min"]), "min", previous=_median(pd["post_to_send_min"])),
            _row("sla_met_pct", "Sent within the SLA", d["sla_met_pct"], "pct", previous=pd["sla_met_pct"]),
            _row("time_saved_hours", "Hours saved (estimate)", d.get("time_saved_hours"), "hours", previous=pd.get("time_saved_hours"),
                 note="From the minutes per alert in Settings → Metrics."),
        ]},
    ]
    return {"window": {"days": days, "since": since, "until": until, "env": env_f}, "sections": sections,
            "disagreements": parity.get("field_disagreements", [])[:12], "event_count": len(events)}


# -- Admin ---------------------------------------------------------------------------------------------------------------------
def people(ctx: AgentContext) -> list[dict[str, Any]]:
    """Everyone with a role in the Console or a place on the IM roster, once each."""
    cfg = ctx.config
    out: dict[str, dict[str, Any]] = {}

    def person(email: str) -> dict[str, Any]:
        key = email.strip().lower()
        return out.setdefault(key, {"email": key, "name": "", "role": "viewer", "role_source": "", "on_roster": False, "on_call": False,
                                    "gmail_connected": None, "last_active": None, "actions": 0, "locked": False})

    for a in cfg.analysts:
        person(a.email).update(name=a.name, role=a.role, role_source="people")
    for email in cfg.platform.access.bootstrap_admins:
        if email.strip():
            person(email).update(role="admin", role_source="access")
    if not cfg.admin_emails() and not cfg.platform.access.bootstrap_admins:  # the deployer is the admin until one is named
        for email in os.environ.get(BOOTSTRAP_ADMIN_ENV, "").split(","):
            if email.strip():
                person(email).update(role="admin", role_source="deploy")
    for email in owner_admins():  # set on the back end: an admin whatever their record says, and not changeable here
        person(email).update(role="admin", role_source="owner", locked=True)
    try:
        roster = ctx.roster(ROSTER_IM)
        on_call = ctx.on_call(ROSTER_IM, ctx.now()).person
    except Exception:  # noqa: BLE001 - the roster can't be read: roles still show
        log.warning("IM roster unavailable for the people list", exc_info=True)
        roster, on_call = None, None
    for p in (roster.people if roster else []):
        row = person(p.email)
        row.update(on_roster=True, name=row["name"] or p.name, on_call=bool(on_call and on_call.email.lower() == row["email"]))
        if not row["role_source"]:
            row.update(role="analyst", role_source="roster")
    gmail = gmail_oauth.gmail_module()
    for row in out.values():
        if gmail is not None:
            try:
                row["gmail_connected"] = bool(gmail_oauth._is_connected(ctx, gmail, row["email"]))
            except Exception:  # noqa: BLE001 - unknown stays unknown
                row["gmail_connected"] = None
    return sorted(out.values(), key=lambda r: ({"admin": 0, "lead": 1}.get(r["role"], 2), r["name"].lower() or r["email"]))


@router.get("/admin/overview")
def admin_overview(ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_lead)) -> dict[str, Any]:
    cfg, plat, now = ctx.config, ctx.config.platform, ctx.now()
    week = now - timedelta(days=7)
    entries = [e for e in audit.search(ctx, since=week, limit=3000) if e.ts >= week]
    seen: Counter[str] = Counter()
    last: dict[str, Any] = {}
    for e in entries:
        if e.surface in ("console", "chat") and "@" in e.actor:
            seen[e.actor] += 1
            last[e.actor] = max(last.get(e.actor, e.ts), e.ts)
    rows = people(ctx)
    for row in rows:
        row.update(actions=seen.get(row["email"], 0), last_active=last.get(row["email"]))
    changes = [e for e in entries if e.action.startswith(CHANGE_PREFIXES) or (e.action.startswith("api.") and e.target_id.startswith(CHANGE_PATHS))]
    changes.sort(key=lambda e: e.ts, reverse=True)

    tick = ctx.store.get_kv(TICK_KEY) or {}
    ago = round((now - _when(tick["at"])).total_seconds() / 60) if tick.get("at") else None
    checks = safety.run_checks(ctx)
    failed = [c for c in checks if not c.passed]
    dead = pubsub.list_dead_letters(ctx, include_resolved=False)
    waiting = ctx.store.list_outbox(undelivered_only=True, limit=200)
    status = {
        "tick": {"at": tick.get("at"), "minutes_ago": ago, "failed": tick.get("failed") or [],
                 "ok": ago is not None and ago <= plat.telemetry.tick_late_minutes and not tick.get("failed"),
                 "late_after_minutes": plat.telemetry.tick_late_minutes},
        "agent": {"runtime": plat.gcp.agent_runtime_resource, "model": cfg.models.triage, "backend": os.environ.get("TRIAGE_BACKEND", "local"),
                  "env": cfg.env, "config_version": ctx.config_version},
        "delivery": {"pubsub": pubsub.enabled(ctx), "doorbell": cfg.outbox.doorbell, "dead_letters": len(dead), "waiting": len(waiting),
                     "oldest_waiting_min": round(max(((now - i.created_at).total_seconds() / 60 for i in waiting), default=0), 1)},
        "safety": {"passed": not [c for c in failed if c.severity == "blocker"], "testing": plat.safety.testing,
                   "failed": [{"id": c.id, "title": c.title, "severity": c.severity, "fix": c.fix} for c in failed], "checks": len(checks)},
        "bigquery": {"dataset": plat.bigquery.dataset, "connected": ctx.bq is not None and bool(plat.bigquery.dataset)},
        "switches_on": sorted(name for name, on in plat.flags.model_dump().items() if on),
        "switches": len(plat.flags.model_dump()),
    }
    return {"people": rows, "access": plat.access.model_dump(mode="json"), "status": status, "as_of": now,
            "changes": [e.model_dump(mode="json") for e in changes[:40]],
            "active": [{"actor": a, "actions": n, "last_at": last[a]} for a, n in seen.most_common(30)],
            "events_seen": sum(1 for e in ctx.events.query(since=now - timedelta(hours=24), until=now, env=cfg.env, types=[E.ALERT_RECEIVED]))}


# -- people: one record gives a person their role and their place on the IM roster ------------------------------------------------
_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class PersonBody(BaseModel):
    name: str = Field("", max_length=120)
    role: Literal["admin", "user", "lead", "im", "analyst"] = "user"
    on_roster: bool = False


class AccessModeBody(BaseModel):
    open_domain_viewers: bool
    domain: str = Field("", max_length=120)


def _default_name(email: str) -> str:
    local = email.split("@", 1)[0]
    parts = [p for p in re.split(r"[._+-]+", local) if p]
    return " ".join(p.capitalize() for p in parts) if parts else local


def _address(email: str) -> str:
    email = email.strip().lower()
    if not _EMAIL.match(email):
        raise HTTPException(422, {"error": f"'{email}' is not an email address", "code": "validation_error"})
    return email


def _shifts(roster: Any, person_id: str, now: datetime) -> int:
    return (sum(1 for slot in roster.rotation if slot.person_id == person_id) + sum(1 for o in roster.overrides if o.person_id == person_id and o.end > now)
            + (1 if roster.backup_person_id == person_id else 0))


def _set_roster(ctx: AgentContext, user: User, email: str, name: str, on_roster: bool) -> None:
    roster = ctx.roster(ROSTER_IM)
    held = next((p for p in roster.people if p.email.lower() == email), None)
    if on_roster and held is None:
        taken = {p.id for p in roster.people}
        base = re.sub(r"[^a-z0-9]+", "-", email.split("@")[0]).strip("-") or "person"
        pid = base if base not in taken else next(f"{base}-{n}" for n in range(2, 1000) if f"{base}-{n}" not in taken)
        roster.people.append(Person(id=pid, name=name, email=email, org=email.split("@")[1].split(".")[0]))
    elif on_roster and held is not None and held.name != name:
        held.name = name
    elif not on_roster and held is not None:
        count = _shifts(roster, held.id, ctx.now())
        if count:
            raise HTTPException(422, {"error": f"{held.name} holds {count} shift(s) on the IM roster. Move them in Workforce first.", "code": "validation_error"})
        roster.people = [p for p in roster.people if p.id != held.id]
    else:
        return
    ctx.store.save_roster(roster, actor=user.email, name=ROSTER_IM)
    ctx.emit(E.ROSTER_UPDATED, actor=user.email, space="console",
             payload={"roster": ROSTER_IM, "via": "people", "people": len(roster.people), "rotation": len(roster.rotation)})


def _save_people(request: Request, ctx: AgentContext, user: User, analysts: list[dict[str, Any]], access: dict[str, Any] | None, note: str) -> AgentContext:
    target: dict[str, Any] = {"analysts": analysts}
    if access is not None:
        target["platform"] = {**ctx.config.platform.model_dump(mode="json"), "access": access}
    try:
        return save_sections(request, ctx, user, target, note)
    except ValidationError as exc:
        raise HTTPException(422, {"error": "That person could not be saved", "code": "validation_error", "errors": format_errors(exc, "analysts")}) from exc


@router.put("/admin/people/{email}")
def put_person(email: str, body: PersonBody, request: Request, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_admin)) -> dict[str, Any]:
    """Add a person, or change them: their Console role (Admin or User) and their place on the IM roster, from one record."""
    email = _address(email)
    was = ctx.config.analyst(email)
    name = body.name.strip() or (was.name if was else "") or _default_name(email)
    stored_role = "analyst" if body.role == "user" else body.role
    if email in owner_admins() and stored_role != "admin":
        raise HTTPException(422, {"error": f"{name} owns this Console and is always an admin. That is set on the back end and can't be changed here.",
                                  "code": "validation_error"})
    analysts = [a.model_dump(mode="json") for a in ctx.config.analysts if a.email.lower() != email]
    if was and was.role == "admin" and stored_role != "admin" and not _other_admins(ctx, email):
        raise HTTPException(422, {"error": "This is the only admin. Make someone else an admin first.", "code": "validation_error"})
    if user.role_source == "bootstrap" and user.email != email and not any(a["email"].lower() == user.email for a in analysts):
        analysts.append({"name": user.name or _default_name(user.email), "email": user.email, "role": "admin"})
    _set_roster(ctx, user, email, name, body.on_roster)  # refused first when they hold shifts: nothing is half done
    analysts.append({"name": name, "email": email, "role": stored_role})
    fresh = _save_people(request, ctx, user, analysts, None, f"{name} saved under People")
    audit.record(fresh, actor=user.email, action="people.save", surface="console", target_type="person", target_id=email,
                 summary=f"{name}: role {stored_role}, {'on' if body.on_roster else 'not on'} the IM roster",
                 detail={"before": was.model_dump(mode="json") if was else None, "role": stored_role, "on_roster": body.on_roster})
    return {"ok": True, "person": next(p for p in people(fresh) if p["email"] == email)}


@router.put("/admin/access")
def put_access_mode(body: AccessModeBody, request: Request, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_admin)) -> dict[str, Any]:
    """Switch between invite-only access (only listed People may open the Console) and workspace read-only viewer access."""
    access = ctx.config.platform.access.model_dump(mode="json")
    if body.open_domain_viewers:
        dom = body.domain.strip().lower().lstrip("@") or (access["viewer_domains"][0] if access.get("viewer_domains") else "") or user.email.rsplit("@", 1)[-1]
        if not dom or "." not in dom:
            raise HTTPException(422, {"error": "Enter a valid workspace domain.", "code": "validation_error"})
        access["viewer_domains"] = [dom]
        summary = f"Allowed read-only Console viewing for @{dom}"
    else:
        access["viewer_domains"] = []
        summary = "Restricted Console access to invited people only"
    analysts = [a.model_dump(mode="json") for a in ctx.config.analysts]
    if user.role_source == "bootstrap" and not any(a["email"].lower() == user.email for a in analysts):
        analysts.append({"name": user.name or _default_name(user.email), "email": user.email, "role": "admin"})
    fresh = _save_people(request, ctx, user, analysts, access, summary)
    audit.record(fresh, actor=user.email, action="people.access", surface="console", target_type="setting", target_id="access", summary=summary,
                 detail={"viewer_domains": access["viewer_domains"]})
    return {"ok": True, "access": fresh.config.platform.access.model_dump(mode="json")}


def _other_admins(ctx: AgentContext, email: str) -> list[str]:
    named = {a.lower() for a in ctx.config.admin_emails()} | {e.strip().lower() for e in ctx.config.platform.access.bootstrap_admins if e.strip()}
    return sorted(named - {email})


@router.delete("/admin/people/{email}")
def delete_person(email: str, request: Request, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_admin)) -> dict[str, Any]:
    """Take a person's access away: their role, their admin entry and their place on the IM roster."""
    email = _address(email)
    known = next((p for p in people(ctx) if p["email"] == email), None)
    if known is None:
        raise HTTPException(404, {"error": f"{email} is not under People", "code": "not_found"})
    if email in owner_admins():
        raise HTTPException(422, {"error": f"{known['name'] or email} owns this Console and is always an admin. That is set on the back end, so they can't be removed here.",
                                  "code": "validation_error"})
    if known["role"] == "admin" and not _other_admins(ctx, email):
        raise HTTPException(422, {"error": "This is the only admin. Make someone else an admin first.", "code": "validation_error"})
    _set_roster(ctx, user, email, known["name"], False)
    access = ctx.config.platform.access.model_dump(mode="json")
    access["bootstrap_admins"] = [e for e in access["bootstrap_admins"] if e.strip().lower() != email]
    analysts = [a.model_dump(mode="json") for a in ctx.config.analysts if a.email.lower() != email]
    fresh = _save_people(request, ctx, user, analysts, access, f"{known['name'] or email} removed under People")
    audit.record(fresh, actor=user.email, action="people.remove", surface="console", target_type="person", target_id=email,
                 summary=f"{known['name'] or email}: role and roster place removed", detail={"before": {k: known[k] for k in ("role", "on_roster")}})
    return {"ok": True, "email": email}


def _when(value: str) -> datetime:
    return datetime.fromisoformat(value)
