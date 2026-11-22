"""Live views: the real-time Dashboard, the live feed, the event stream and the Review Feed.

Recent events are kept in memory per Console process (EventCache) and topped up incrementally, so a page that
refreshes every few seconds costs one small read of what is new, not a scan of the day. Ranges inside the fast
window are served from the cache; longer ones are read once and kept for a short time.
"""

from __future__ import annotations

import asyncio
import json
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Literal
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.encoders import jsonable_encoder
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from triage_agent import chatlog, golden, workforce
from triage_agent import events as event_log
from triage_agent.context import AgentContext
from triage_agent.events import EventType as E
from triage_agent.events import PlatformEvent as P
from triage_agent.metrics import compute_kpis, timeseries
from triage_agent.models import AgentEvent, Case, CaseStatus

from .auth import User, get_ctx, require_analyst, require_viewer
from .ops import run_op
from .routes_metrics import KPI_GROUPS, _fill_buckets, env_filter, kpi_definitions
from .serializers import case_summary, event_json

router = APIRouter(prefix="/api", tags=["live"])

SERIES_TYPES = [E.ALERT_RECEIVED, E.TRIAGE_PASSED, E.TRIAGE_CORRECTED, E.TRIAGE_SUPPRESSED, E.TRIAGE_FAILED,
                E.TRIAGE_NEEDS_REVIEW, E.EMAIL_DRAFTED, E.EMAIL_SENT, E.SLA_MET, E.SLA_MISSED]
# Events that are housekeeping, not something a person acts on: left out of the live feed unless asked for.
QUIET = {P.LLM_USAGE, P.CHAT_INBOUND, P.CHAT_OUTBOUND, P.AUDIT_RECORDED, P.SAFETY_CHECKED, P.OUTBOUND_PUBLISHED,
         P.OUTBOUND_DELIVERED, P.AGENT_CHAT_TOOL, P.KNOWLEDGE_INDEXED, E.OUTBOX_DELIVERED, E.MESSAGE_IGNORED}
RangeName = Literal["hour", "today", "24h", "7d", "30d", "custom"]


class EventCache:
    """Events of the fast window, newest last, topped up from where the last read stopped."""

    def __init__(self) -> None:
        self._events: list[AgentEvent] = []
        self._ids: set[str] = set()
        self._cursor: datetime | None = None
        self._checked = 0.0
        self._writes = -1
        self._lock = threading.Lock()
        self._long: dict[tuple[Any, ...], tuple[float, list[AgentEvent]]] = {}

    def hours(self, ctx: AgentContext) -> int:
        return ctx.config.platform.bigquery.hot_window_hours

    def refresh(self, ctx: AgentContext, min_interval: float = 1.0) -> None:
        now_m = time.monotonic()
        with self._lock:
            written = event_log.writes()
            if now_m - self._checked < min_interval and written == self._writes:  # nothing new from this process
                return
            self._checked, self._writes = now_m, written
            cursor = self._cursor
        now = ctx.now()
        floor = now - timedelta(hours=self.hours(ctx))
        since = max(cursor - timedelta(seconds=10), floor) if cursor else floor
        fresh = ctx.events.query(since=since)
        with self._lock:
            if self._cursor is not None and now < self._cursor - timedelta(minutes=5):  # the clock went back (tests)
                self._events, self._ids, self._cursor = [], set(), None
            added = [e for e in fresh if e.event_id not in self._ids]
            if added:
                self._events.extend(added)
                self._events.sort(key=lambda e: e.event_ts)
                self._ids.update(e.event_id for e in added)
            if self._events and self._events[0].event_ts < floor:
                keep = [e for e in self._events if e.event_ts >= floor]
                self._ids = {e.event_id for e in keep}
                self._events = keep
            if self._events:
                self._cursor = self._events[-1].event_ts

    def window(self, ctx: AgentContext, since: datetime, until: datetime | None = None, env: str | None = None) -> list[AgentEvent]:
        """Events in [since, until), newest first."""
        now = ctx.now()
        if since < now - timedelta(hours=self.hours(ctx)) + timedelta(minutes=1):
            key = (since.replace(second=0, microsecond=0), until.replace(second=0, microsecond=0) if until else None, env)
            hit = self._long.get(key)
            if hit and time.monotonic() - hit[0] < 60:
                return hit[1]
            rows = ctx.events.query(since=since, until=until, env=env)
            if len(self._long) > 24:
                self._long.clear()
            self._long[key] = (time.monotonic(), rows)
            return rows
        self.refresh(ctx)
        with self._lock:
            rows = [e for e in self._events if e.event_ts >= since and (until is None or e.event_ts < until) and (env is None or e.env == env)]
        rows.reverse()
        return rows

    def after(self, ctx: AgentContext, event_ts: datetime | None, limit: int = 200) -> list[AgentEvent]:
        """Events newer than `event_ts`, oldest first (for the stream)."""
        self.refresh(ctx)
        with self._lock:
            rows = [e for e in self._events if event_ts is None or e.event_ts > event_ts]
        return rows[-limit:]


def cache_of(request: Request) -> EventCache:
    state = request.app.state
    if not hasattr(state, "event_cache"):
        state.event_cache = EventCache()
    return state.event_cache


# -- ranges ------------------------------------------------------------------------------------------------------------
def resolve_range(ctx: AgentContext, name: str, start: datetime | None, end: datetime | None) -> tuple[datetime, datetime, str]:
    """(since, until, bucket) for a range name. `today` is the display timezone's day so far."""
    now = ctx.now()
    tz = ZoneInfo(ctx.config.timezone)
    if name == "hour":
        return now - timedelta(hours=1), now, "minute"
    if name == "today":
        local = now.astimezone(tz).replace(hour=0, minute=0, second=0, microsecond=0)
        return local.astimezone(timezone.utc), now, "hour"
    if name == "24h":
        return now - timedelta(hours=24), now, "hour"
    if name == "7d":
        return now - timedelta(days=7), now, "day"
    if name == "30d":
        return now - timedelta(days=30), now, "day"
    if name == "custom":
        if start is None or end is None:
            raise HTTPException(422, {"error": "A custom range needs a start and an end.", "code": "validation_error"})
        s = start if start.tzinfo else start.replace(tzinfo=tz)
        e = end if end.tzinfo else end.replace(tzinfo=tz)
        if e <= s:
            raise HTTPException(422, {"error": "The range must end after it starts.", "code": "validation_error"})
        if e - s > timedelta(days=180):
            raise HTTPException(422, {"error": "A range covers 180 days at most.", "code": "validation_error"})
        return s, min(e, now), ("hour" if e - s <= timedelta(days=3) else "day")
    raise HTTPException(422, {"error": f"Unknown range '{name}'.", "code": "validation_error"})


def _minute_series(events: list[AgentEvent], since: datetime, until: datetime, tz: str) -> list[dict[str, Any]]:
    """Five-minute buckets for the last hour."""
    zone = ZoneInfo(tz)
    step = timedelta(minutes=5)
    start = since.replace(second=0, microsecond=0)
    start -= timedelta(minutes=start.minute % 5)
    rows: dict[datetime, dict[str, Any]] = {}
    t = start
    while t < until:
        rows[t] = {"bucket": t.astimezone(zone).strftime("%Y-%m-%dT%H:%M"), **{k: 0 for k in SERIES_TYPES}}
        t += step
    for e in events:
        if e.event_type not in SERIES_TYPES:
            continue
        key = e.event_ts.replace(second=0, microsecond=0)
        key -= timedelta(minutes=key.minute % 5)
        if key in rows:
            rows[key][e.event_type] += 1
    return [rows[k] for k in sorted(rows)]


def operational_now(ctx: AgentContext) -> dict[str, Any]:
    """What needs someone now: the queue, SLAs, deliveries, held messages, who is on."""
    from triage_agent import pubsub

    now = ctx.now()
    open_cases = ctx.store.list_cases(statuses=[CaseStatus.VERIFIED, CaseStatus.NEEDS_REVIEW, CaseStatus.FAILED],
                                      since=now - timedelta(days=3), limit=1000)
    review = [c for c in open_cases if c.status == CaseStatus.NEEDS_REVIEW]
    waiting = [c for c in open_cases if c.status == CaseStatus.VERIFIED and c.acknowledged_at is None]
    at_risk = [c for c in waiting if c.sla_due_at and c.sla_met is None and now >= c.sla_due_at - timedelta(minutes=5)]
    outbox = ctx.store.list_outbox(undelivered_only=True, limit=500)
    try:
        dead = len(pubsub.list_dead_letters(ctx, limit=200))
    except Exception:  # noqa: BLE001
        dead = 0
    im = ctx.im_on_shift()
    return {
        "review_queue": len(review), "oldest_review_min": round(max(((now - c.updated_at).total_seconds() / 60 for c in review), default=0), 1),
        "unacknowledged": len(waiting), "sla_at_risk": len(at_risk), "waiting_on_burson": sum(1 for c in open_cases if c.status == CaseStatus.FAILED),
        "outbox_waiting": len(outbox), "oldest_outbox_min": round(max(((now - i.created_at).total_seconds() / 60 for i in outbox), default=0), 1),
        "dead_letters": dead, "im_on_shift": im.person.name if im.person else None, "im_source": im.source,
        "staff_on_shift": len(workforce.staff_at(ctx.roster("slrr_im"), now)),
    }


@router.get("/dashboard")
def get_dashboard(
    request: Request,
    range: RangeName = "today",  # noqa: A002 - the query parameter's name
    start: datetime | None = Query(None, alias="from"),
    end: datetime | None = Query(None, alias="to"),
    env: str | None = None,
    ctx: AgentContext = Depends(get_ctx),
    user: User = Depends(require_viewer),
) -> dict[str, Any]:
    since, until, bucket = resolve_range(ctx, range, start, end)
    env_f = env_filter(ctx, env)
    cache = cache_of(request)
    events = cache.window(ctx, since, until, env_f)
    previous = cache.window(ctx, since - (until - since), since, env_f)
    result, prev = compute_kpis(events, ctx.config), compute_kpis(previous, ctx.config)
    tz = ctx.config.timezone
    if bucket == "minute":
        series = _minute_series(events, since, until, tz)
    else:
        rows = timeseries([e for e in events if e.event_type in SERIES_TYPES], SERIES_TYPES, bucket=bucket, tz=tz)
        series = _fill_buckets(rows, SERIES_TYPES, since, until, bucket, tz)
    blocked = sum(1 for e in events if e.event_type == P.SAFETY_BLOCKED)
    usage = [e for e in events if e.event_type == P.LLM_USAGE]
    return {
        "range": range, "window": {"since": since, "until": until, "bucket": bucket, "env": env_f, "timezone": tz},
        "kpis": result["kpis"], "derived": result["derived"],
        "previous": {"kpis": prev["kpis"], "derived": prev["derived"], "event_count": len(previous)},
        "series": series, "series_types": SERIES_TYPES, "definitions": kpi_definitions(), "groups": KPI_GROUPS,
        "event_count": len(events), "metrics_config": ctx.config.metrics.model_dump(mode="json"),
        "now": operational_now(ctx),
        "extra": {"blocked_messages": blocked, "llm_calls": len(usage), "llm_errors": sum(1 for e in usage if not (e.payload or {}).get("ok", True)),
                  "temp_checks": sum(1 for e in events if e.event_type == P.TEMP_CHECK_COMPLETED),
                  "chat_messages": sum(1 for e in events if e.event_type in (P.CHAT_INBOUND, P.CHAT_OUTBOUND)),
                  "console_actions": sum(1 for e in events if e.event_type == P.AUDIT_RECORDED and (e.payload or {}).get("surface") in ("console", "chat_agent"))},
        "as_of": ctx.now(),
    }


# -- the live feed ---------------------------------------------------------------------------------------------------------
def _feed_item(ctx: AgentContext, e: AgentEvent, cases: dict[str, Case | None]) -> dict[str, Any]:
    item = event_json(e)
    if e.event_type.startswith(("audit.", "chat.", "outbound.", "safety.", "temp_check.", "workforce.", "forecast.", "watch.",
                                "golden.", "assessment.", "agent_chat.", "prompt.", "knowledge.doc", "campaign.", "bigquery.", "secret.")):
        item["summary"] = describe_platform_event(e)
    if e.case_id:
        if e.case_id not in cases:
            cases[e.case_id] = ctx.store.get_case(e.case_id)
        case = cases[e.case_id]
        if case is not None:
            item["case"] = {"case_id": case.case_id, "status": case.status.value, "alert_name": case.alert_name,
                            "track": case.track, "priority": case.priority, "product": case.product}
            item["needs"] = needs_of(ctx, case)
    return item


def needs_of(ctx: AgentContext, case: Case) -> str:
    """What a case is waiting for, in a word: the feed's call to action."""
    if case.status == CaseStatus.NEEDS_REVIEW:
        return "review"
    if case.status == CaseStatus.VERIFIED and case.acknowledged_at is None:
        if case.sla_due_at and case.sla_met is None and ctx.now() >= case.sla_due_at - timedelta(minutes=5):
            return "sla"
        return "acknowledge"
    if case.status == CaseStatus.FAILED:
        return "source_fix"
    return ""


def describe_platform_event(e: AgentEvent) -> str:
    p = e.payload or {}
    t = e.event_type
    if t == P.AUDIT_RECORDED:
        return p.get("summary") or p.get("action") or "Action recorded"
    if t == P.SAFETY_BLOCKED:
        return f"Held a message to {p.get('target')}: {p.get('check', '').replace('_', ' ')}" + (f" ({', '.join(p.get('hits') or [])})" if p.get("hits") else "")
    if t == P.OUTBOUND_DEAD_LETTERED:
        return f"Delivery gave up after {p.get('attempts')} attempts: {p.get('error') or p.get('kind')}"
    if t == P.OUTBOUND_FAILED:
        return f"Delivery attempt {p.get('attempt')} failed: {p.get('error')}"
    if t == P.OUTBOUND_REPLAYED:
        return "A dead-lettered delivery was replayed"
    if t in (P.TEMP_CHECK_STARTED, P.TEMP_CHECK_COMPLETED, P.TEMP_CHECK_FAILED):
        what = {"temp_check.started": "started", "temp_check.completed": f"finished ({p.get('status')}, {p.get('total', 0)} counted)",
                "temp_check.failed": f"failed: {p.get('error')}"}[t]
        return f"Temp check {p.get('check_id')} {what}"
    if t == P.TEMP_CHECK_ACTIONED:
        return f"Temp check {p.get('check_id')}: {p.get('action')}"
    if t == P.FORECAST_RUN:
        return f"Forecast run by {p.get('method')}: {p.get('recommendations', 0)} recommendation(s) pending"
    if t == P.FORECAST_FAILED:
        return f"Forecast failed: {p.get('error')}"
    if t == P.RECOMMENDATION_CREATED:
        return f"Staffing recommendation: {str(p.get('kind', '')).replace('_', ' ')} ({p.get('gap')} IM)"
    if t == P.RECOMMENDATION_DECIDED:
        return f"Staffing recommendation {p.get('decision')}"
    if t == P.GAP_ALERT:
        return f"Volume over forecast: {p.get('actual')} against {p.get('expected')} expected"
    if t == P.WATCH_DETECTED:
        return f"Watch “{p.get('watch')}” {'flagged' if p.get('at_bar') else 'noted'} a post (score {p.get('score')})"
    if t == P.ASSESSMENT_RECORDED:
        return f"IM assessment: {'agrees' if p.get('agree') else 'disagrees'}"
    if t == P.GOLDEN_RECORDED:
        return f"Golden example {p.get('label')}"
    if t == P.AGENT_CHAT_TURN:
        return "Chat agent turn" + (f" ({', '.join(t for t in p.get('tools') or [] if t)})" if p.get("tools") else "")
    if t == P.PROMPT_PUBLISHED:
        return f"AI instructions changed for {p.get('purpose')}"
    if t in (P.KNOWLEDGE_DOC_SAVED, P.KNOWLEDGE_DOC_REMOVED):
        return f"Knowledge doc {'saved' if t == P.KNOWLEDGE_DOC_SAVED else 'removed'}: {p.get('title')}"
    if t in (P.CHAT_INBOUND, P.CHAT_OUTBOUND):
        return f"Chat {p.get('kind')} {'received' if t == P.CHAT_INBOUND else p.get('status')} ({p.get('space_key') or 'unknown space'})"
    if t == P.LLM_USAGE:
        return f"Gemini call: {p.get('purpose')}"
    return t.replace(".", " ").replace("_", " ")


@router.get("/live/feed")
def get_live_feed(
    request: Request,
    since: datetime | None = None,
    limit: int = Query(60, ge=1, le=300),
    include_quiet: bool = False,
    env: str | None = None,
    ctx: AgentContext = Depends(get_ctx),
    user: User = Depends(require_viewer),
) -> dict[str, Any]:
    cache = cache_of(request)
    start = since or (ctx.now() - timedelta(hours=6))
    events = cache.window(ctx, start, None, env_filter(ctx, env))
    if since is not None:
        events = [e for e in events if e.event_ts > since]
    if not include_quiet:
        events = [e for e in events if e.event_type not in QUIET]
    cases: dict[str, Case | None] = {}
    items = [_feed_item(ctx, e, cases) for e in events[:limit]]
    return {"items": items, "as_of": ctx.now(), "now": operational_now(ctx)}


@router.get("/live/stream")
async def live_stream(request: Request, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_viewer)) -> StreamingResponse:
    """Server-sent events: each new event as it lands, plus the operational counts when they change."""
    cache = cache_of(request)
    console = request.app.state.console
    env = ctx.config.env

    async def gen() -> Any:
        last: datetime | None = ctx.now()
        last_now: dict[str, Any] | None = None
        beat = 0
        yield "retry: 3000\n\n"
        while True:
            if await request.is_disconnected():
                return
            fresh_ctx = console.fresh()

            def read() -> tuple[list[dict[str, Any]], dict[str, Any], datetime | None]:
                events = [e for e in cache.after(fresh_ctx, last) if e.env == env and e.event_type not in QUIET]
                cases: dict[str, Case | None] = {}
                return ([_feed_item(fresh_ctx, e, cases) for e in events], operational_now(fresh_ctx),
                        (events[-1].event_ts if events else last))

            try:
                items, now_counts, newest = await asyncio.to_thread(read)
            except Exception as exc:  # noqa: BLE001 - tell the client and keep the stream open
                yield f"event: problem\ndata: {json.dumps({'error': str(exc)[:200]})}\n\n"
                await asyncio.sleep(5)
                continue
            last = newest
            if items:
                yield f"event: events\ndata: {json.dumps(jsonable_encoder(items))}\n\n"
            if now_counts != last_now:
                last_now = now_counts
                yield f"event: now\ndata: {json.dumps(jsonable_encoder(now_counts))}\n\n"
            beat += 1
            if beat % 8 == 0:
                yield ": keep-alive\n\n"
            await asyncio.sleep(2)

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"})


# -- the Review Feed ---------------------------------------------------------------------------------------------------------
_AGREEMENT: dict[str, Any] = {"at": 0.0, "value": {}}


def _agreement(ctx: AgentContext) -> dict[str, Any]:
    """Measured agreement per field, counted once a minute (every card on the feed shows the same counts)."""
    import time

    from triage_agent.qa import certainty

    if time.monotonic() - _AGREEMENT["at"] > 60 or not _AGREEMENT["value"]:
        _AGREEMENT.update(at=time.monotonic(), value=certainty.field_agreement(ctx))
    return _AGREEMENT["value"]


def feed_card(ctx: AgentContext, case: Case, *, detail: bool = False) -> dict[str, Any]:
    """One alert as the Review Feed shows it: the classification, the measured numbers, citations and what can be done."""
    card = case_summary(case)
    latest = case.latest
    result = latest.result if latest else None
    extra = (result.extra or {}) if result else {}
    a = result.assessment if result else None
    actions = {x.code: x for x in ctx.config.actions}
    card.update({
        "needs": needs_of(ctx, case),
        "classification": extra.get("classification"),
        "field_agreement": _agreement(ctx),  # per field: how often IMs kept the app's value (counted, last 30 days)
        "citations": extra.get("citations") or [],
        "knowledge_read": extra.get("knowledge_read") or [],
        "proposed_actions": [{"code": c, "label": actions[c].label if c in actions else c, "kind": actions[c].kind if c in actions else ""}
                             for c in (a.suggested_actions if a else [])],
        "actions_taken": [x.model_dump(mode="json") for x in case.actions],
        "applied_corrections": [c.model_dump(mode="json") for c in (result.applied_corrections if result else [])],
        "proposed_corrections": [c.model_dump(mode="json") for c in (result.proposed_corrections if result else [])],
        "summary_text": (result.normalized or {}).get("summary") if result else None,
        "recipients": a.recipients.model_dump(mode="json") if a and a.recipients else None,
        "waiting_min": round((ctx.now() - (latest.received_at if latest else case.created_at)).total_seconds() / 60, 1),
        "ts_recommended": bool(a and a.ts_recommended),
    })
    if detail:
        record = golden.get(ctx, case.case_id)
        card.update({
            "normalized": result.normalized if result else {},
            "issue_list": [i.model_dump(mode="json") for i in (result.issues if result else [])],
            "alert_text": latest.message.text if latest else "",
            "chat": [x.model_dump(mode="json") for x in chatlog.search(ctx, case_id=case.case_id, limit=100)],
            "golden": record.model_dump(mode="json") if record else None,
            "checks_run": result.checks_run if result else [],
        })
    return card


@router.get("/feed")
def get_feed(
    view: Literal["action", "all", "review", "verified", "suppressed", "closed"] = "action",
    q: str | None = None,
    hours: int = Query(72, ge=1, le=24 * 30),
    limit: int = Query(60, ge=1, le=300),
    ctx: AgentContext = Depends(get_ctx),
    user: User = Depends(require_viewer),
) -> dict[str, Any]:
    statuses = {"review": [CaseStatus.NEEDS_REVIEW], "verified": [CaseStatus.VERIFIED], "suppressed": [CaseStatus.SUPPRESSED],
                "closed": [CaseStatus.CLOSED, CaseStatus.ABANDONED]}.get(view)
    cases = ctx.store.list_cases(statuses=statuses, since=ctx.now() - timedelta(hours=hours), limit=1500)
    needle = (q or "").strip().lower()
    cards = []
    for case in cases:
        if needle and needle not in " ".join(str(x or "") for x in (case.case_id, case.alert_name, case.issue_name, case.product,
                                                                    case.exposure_tag, case.platform)).lower():
            continue
        if view == "action" and not needs_of(ctx, case):
            continue
        cards.append(feed_card(ctx, case))
    order = {"sla": 0, "review": 1, "acknowledge": 2, "source_fix": 3, "": 4}
    cards.sort(key=lambda c: (order.get(c["needs"], 4), -(c["waiting_min"] or 0)) if view == "action" else (-_ts(c["latest_received_at"]),))
    return {"cards": cards[:limit], "total": len(cards), "view": view, "as_of": ctx.now(),
            "legend": [x.model_dump(mode="json") for x in ctx.config.actions],
            "verdicts": ["PASS", "CORRECTED", "NEEDS_REVIEW", "SUPPRESSED", "FAIL"]}


def _ts(value: Any) -> float:
    return value.timestamp() if isinstance(value, datetime) else 0.0


@router.get("/feed/{case_id}")
def get_feed_card(case_id: str, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_viewer)) -> dict[str, Any]:
    case = ctx.store.get_case(case_id.upper())
    if case is None:
        raise HTTPException(404, {"error": f"Unknown case {case_id}", "code": "not_found"})
    return feed_card(ctx, case, detail=True)


class ActionBody(BaseModel):
    action: str = Field(..., min_length=1, max_length=40)


@router.post("/feed/{case_id}/action")
def post_feed_action(case_id: str, body: ActionBody, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_analyst)) -> dict[str, Any]:
    """Do what a legend reaction does, as the signed-in person (a draft lands in their own Gmail)."""
    case = ctx.store.get_case(case_id.upper())
    if case is None:
        raise HTTPException(404, {"error": f"Unknown case {case_id}", "code": "not_found"})
    action = ctx.config.action(body.action)
    if action is None:
        raise HTTPException(422, {"error": f"Unknown action '{body.action}'", "code": "validation_error"})
    clean = ctx.config.space("clean")
    result = run_op(ctx, "record_reaction", {
        "emoji": action.emoji, "reactor_email": user.email, "reactor_name": user.name or user.email.split("@")[0],
        "message_text": f"[{case.case_id}]", "message_id": case.clean_message_ref or f"console-{case.case_id}",
        "space": clean.display_name if clean else "clean"}, user)
    updated = ctx.store.get_case(case.case_id)
    return {**result, "card": feed_card(ctx, updated, detail=True) if updated else None}


class AssessmentBody(BaseModel):
    agree: bool
    verdict: str | None = Field(None, max_length=20)
    fields: dict[str, Any] = Field(default_factory=dict)
    note: str = Field("", max_length=2000)


@router.post("/feed/{case_id}/assessment")
def post_assessment(case_id: str, body: AssessmentBody, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_analyst)) -> dict[str, Any]:
    unknown = [k for k in body.fields if ctx.config.alert_template.field(k) is None]
    if unknown:
        raise HTTPException(422, {"error": f"Unknown alert field(s): {', '.join(unknown)}", "code": "validation_error"})
    result = run_op(ctx, "record_assessment", {"case_id": case_id.upper(), "agree": body.agree, "verdict": body.verdict,
                                               "fields": body.fields, "note": body.note, "actor": user.email}, user)
    case = ctx.store.get_case(case_id.upper())
    return {**result, "card": feed_card(ctx, case, detail=True) if case else None}


class IntakeBody(BaseModel):
    text: str = Field(..., min_length=1, max_length=20000)


@router.post("/intake")
def post_intake(body: IntakeBody, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_analyst)) -> dict[str, Any]:
    """Put an alert through triage by hand (pasted text): a real case, worked like any other."""
    from triage_agent import tools

    try:
        out = tools.run(ctx, "triage_alert", {"text": body.text}, tools.Caller(email=user.email, role="analyst", surface="console"))
    except tools.ToolError as exc:
        raise HTTPException(400, {"error": str(exc), "code": "op_rejected"}) from exc
    case = ctx.store.get_case(out["case_id"]) if out.get("case_id") else None
    return {"ok": True, "case_id": out.get("case_id"), "summary": out.get("summary"), "card": feed_card(ctx, case, detail=True) if case else None}
