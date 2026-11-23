"""Console API for the working surfaces: Chat tracking, the in-Console chat agent, temp checks, workforce,
knowledge, campaigns and watches."""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import PlainTextResponse, Response
from pydantic import BaseModel, Field

from triage_agent import audit, bwquery, campaigns_admin, chat_agent, chatlog, golden, knowledge, tempcheck, tools, watches, webfind, workforce
from triage_agent.config import switch_off
from triage_agent.context import ROSTER_IM, AgentContext

from .auth import User, get_ctx, require_admin, require_analyst, require_lead, require_viewer
from .ops import run_op

router = APIRouter(prefix="/api", tags=["work"])


def _bad(exc: Exception, status: int = 400) -> HTTPException:
    return HTTPException(status, {"error": str(exc), "code": "rejected"})


def _missing(what: str) -> HTTPException:
    return HTTPException(404, {"error": f"Unknown {what}", "code": "not_found"})


def _role(user: User) -> str:
    return "analyst" if user.role == "im" else user.role


# -- Chat tracking -----------------------------------------------------------------------------------------------------
@router.get("/chat/activity")
def chat_activity(
    space: str | None = None, case_id: str | None = None, direction: Literal["inbound", "outbound"] | None = None,
    kind: str | None = None, q: str | None = None, hours: int = Query(72, ge=1, le=24 * 90), limit: int = Query(200, ge=1, le=1000),
    ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_viewer),
) -> dict[str, Any]:
    items = chatlog.search(ctx, space_key=space or None, case_id=(case_id.upper() if case_id else None), direction=direction,
                           kind=kind or None, q=q, since=ctx.now() - timedelta(hours=hours), limit=limit)
    return {"items": [a.model_dump(mode="json") for a in items], "threads": chatlog.threads(items), "as_of": ctx.now()}


@router.get("/chat/spaces")
def chat_spaces(hours: int = Query(24, ge=1, le=24 * 30), ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_viewer)) -> dict[str, Any]:
    items = chatlog.search(ctx, since=ctx.now() - timedelta(hours=hours), limit=1000)
    external = set(ctx.config.platform.safety.external_spaces)
    rows: dict[str, dict[str, Any]] = {}
    for s in ctx.config.spaces:
        rows[s.key] = {"key": s.key, "name": s.display_name, "configured": bool(s.space_id or s.url), "external": s.key in external,
                       "inbound": 0, "outbound": 0, "queued": 0, "held": 0, "last": None}
    for key, name in (("dm", "Direct messages"), ("email", "Agent inbox (email)")):
        rows[key] = {"key": key, "name": name, "configured": True, "external": False, "inbound": 0, "outbound": 0, "queued": 0,
                     "held": 0, "last": None}
    for a in items:
        row = rows.setdefault(a.space_key or "other", {"key": a.space_key or "other", "name": "Other", "configured": False,
                                                       "external": False, "inbound": 0, "outbound": 0, "queued": 0, "held": 0, "last": None})
        row[a.direction] += 1
        row["queued"] += 1 if a.status == "queued" else 0
        row["held"] += 1 if a.status == "held" else 0
        if row["last"] is None or a.ts > row["last"]:
            row["last"] = a.ts
    return {"spaces": list(rows.values()), "hours": hours, "tracked": len(items)}


# -- the in-Console chat agent ---------------------------------------------------------------------------------------------
class MessageBody(BaseModel):
    text: str = Field(..., min_length=1, max_length=8000)


class ConfirmBody(BaseModel):
    approve: bool


def _session(ctx: AgentContext, session_id: str, user: User) -> chat_agent.Session:
    session = chat_agent.get_session(ctx, session_id, user.email)
    if session is None:
        raise _missing("chat")
    return session


@router.get("/agent/sessions")
def agent_sessions(ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_viewer)) -> dict[str, Any]:
    caller = tools.Caller(email=user.email, role=_role(user))
    usable = tools.available(ctx, caller)
    return {"sessions": chat_agent.list_sessions(ctx, user.email),
            "tools": [t.spec() for t in usable],
            "can_act": any(t.mutating for t in usable), "actions_switch": ctx.flag("console_chat_agent"),
            "confirm_actions": ctx.config.platform.chat_agent.confirm_actions}


@router.post("/agent/sessions")
def agent_new_session(ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_viewer)) -> dict[str, Any]:
    return chat_agent.create_session(ctx, user.email).model_dump(mode="json")


@router.get("/agent/sessions/{session_id}")
def agent_get_session(session_id: str, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_viewer)) -> dict[str, Any]:
    return _session(ctx, session_id, user).model_dump(mode="json")


@router.delete("/agent/sessions/{session_id}")
def agent_delete_session(session_id: str, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_viewer)) -> dict[str, Any]:
    if not chat_agent.delete_session(ctx, session_id, user.email):
        raise _missing("chat")
    return {"ok": True}


@router.post("/agent/sessions/{session_id}/messages")
def agent_send(session_id: str, body: MessageBody, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_viewer)) -> dict[str, Any]:
    session = _session(ctx, session_id, user)
    try:
        return chat_agent.send(ctx, session, body.text, email=user.email, role=_role(user)).model_dump(mode="json")
    except ValueError as exc:
        raise _bad(exc, 409) from exc


@router.post("/agent/sessions/{session_id}/confirm")
def agent_confirm(session_id: str, body: ConfirmBody, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_analyst)) -> dict[str, Any]:
    session = _session(ctx, session_id, user)
    try:
        return chat_agent.confirm(ctx, session, body.approve, email=user.email, role=_role(user)).model_dump(mode="json")
    except ValueError as exc:
        raise _bad(exc, 409) from exc


# -- temp checks ---------------------------------------------------------------------------------------------------------
class TempCheckBody(BaseModel):
    issue: str = Field("", max_length=300)
    query_ref: str = Field("", max_length=500)
    boolean: str = Field("", max_length=6000)
    filters: dict[str, Any] | None = None
    draft_query: bool = False
    case_id: str | None = None
    hours: int | None = Field(None, ge=1, le=720)
    update_of: str | None = None
    keep_refreshed_hours: int = Field(0, ge=0, le=72)
    broad_draft: bool = False  # "No query yet" with no Boolean typed: Gemini drafts a broad one
    since: datetime | None = None  # "Count from: a time I choose"
    alert_at: datetime | None = None
    alert_text: str = Field("", max_length=6000)
    own_on: bool | None = None
    own_sources: list[str] = Field(default_factory=list, max_length=20)
    reuse: str = Field("", max_length=40)
    writeup: bool = True
    run_key: str = Field("", max_length=64)
    from_alert: bool = False  # started for an alert that has no Brandwatch query yet


class ConvertBody(BaseModel):
    query: str = Field("", max_length=500)
    boolean: str = Field("", max_length=6000)
    filters: dict[str, Any] | None = None
    sources: list[str] = Field(default_factory=list, max_length=20)
    since: datetime | None = None
    estimate: bool = False


class SuggestBody(BaseModel):
    text: str = Field("", max_length=6000)


class TempActionBody(BaseModel):
    action: Literal["used", "sent", "dismissed", "noted", "keep_refreshed", "stop_refresh"]
    note: str = Field("", max_length=500)


def _check_brief(c: tempcheck.TempCheck) -> dict[str, Any]:
    return {"check_id": c.check_id, "issue": c.issue, "status": c.status, "total": c.total, "concern_level": c.concern_level,
            "basis": c.basis, "trigger": c.trigger, "via": c.via, "requested_by": c.requested_by, "case_id": c.case_id,
            "created_at": c.created_at, "completed_at": c.completed_at, "update_of": c.update_of, "title": c.title,
            "actions": c.actions, "error": c.error, "keep_refreshed_until": c.keep_refreshed_until, "standing": c.standing,
            "own_posts": int(c.own.get("kept") or 0), "own_from": c.own.get("from")}


@router.get("/temp-checks")
def temp_checks(case_id: str | None = None, limit: int = Query(100, ge=1, le=500),
                ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_viewer)) -> dict[str, Any]:
    cfg = ctx.config.platform.temp_check
    checks = tempcheck.list_checks(ctx, case_id=(case_id.upper() if case_id else None), limit=limit)
    auto = ctx.store.get_kv("tc:auto") or {}
    return {
        "checks": [_check_brief(c) for c in checks],
        "enabled": ctx.flag("temp_checks"), "auto_enabled": ctx.flag("auto_temp_checks"), "web_enabled": ctx.flag(webfind.SWITCH),
        "setup": {"brandwatch": bool(cfg.brandwatch_project_id and cfg.brandwatch_token_secret),
                  "sources": [{"key": s.key, "label": s.label or s.key, "enabled": s.enabled, "freshness": s.freshness} for s in cfg.sources],
                  "lookback_hours": cfg.lookback_hours},
        "form": {"tables": [{"key": s.key, "label": s.label or s.key, "freshness": s.freshness, "what": s.what} for s in tempcheck.own_sources(ctx)],
                 "platforms": [tempcheck.SOURCES.get(p, p.title()) for p in bwquery.PLATFORM_SITE],
                 "spike_mentions": cfg.spike_mentions, "no_query_hours": cfg.no_query_hours, "since_max_days": cfg.since_max_days,
                 "event_query_prefix": cfg.event_query_prefix},
        "auto": {"started_today": auto.get("started", 0) if auto.get("day") == ctx.now().date().isoformat() else 0,
                 "daily_limit": cfg.daily_limit, "log": (ctx.store.get_kv("tc:auto_log") or {}).get("rows", [])[:50]},
    }


@router.get("/temp-checks/queries")
def temp_check_queries(q: str = Query("", max_length=200), limit: int = Query(40, ge=1, le=200),
                       ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_viewer)) -> dict[str, Any]:
    """The event queries offered in the picker: the newest whose name has every word typed."""
    try:
        return {"queries": tempcheck.find_queries(ctx, q, limit), "error": ""}
    except tempcheck.BrandwatchUnavailable as exc:
        return {"queries": [], "error": str(exc)}


@router.get("/temp-checks/queries/{query_id}")
def temp_check_query(query_id: int, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_viewer)) -> dict[str, Any]:
    """One Brandwatch query with its Boolean, shown when it is picked."""
    try:
        query = tempcheck.Brandwatch(ctx).query(query_id)
    except tempcheck.BrandwatchUnavailable as exc:
        raise HTTPException(503, {"error": str(exc), "code": "brandwatch_unavailable"}) from exc
    if query is None:
        raise _missing("Brandwatch query")
    return query


@router.post("/temp-checks/suggest")
def temp_check_suggest(body: SuggestBody, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_analyst)) -> dict[str, Any]:
    """A broad first-draft Boolean for an issue with no Brandwatch query yet: the analyst checks it before running."""
    try:
        draft = tempcheck.suggest_query(ctx, body.text)
    except tempcheck.Refused as exc:
        raise _bad(exc) from exc
    except Exception as exc:  # noqa: BLE001 - Gemini could not be asked
        raise HTTPException(503, {"error": f"Gemini could not draft a query: {str(exc)[:200]}", "code": "draft_failed"}) from exc
    audit.record(ctx, actor=user.email, action="temp_check.suggest", surface="console", target_type="temp_check", target_id="draft",
                 summary="Drafted a broad query for a temp check", detail={"boolean": draft["boolean"]})
    return {"boolean": draft["boolean"], "wide": draft["wide"], "why": draft["why"]}


@router.post("/temp-checks/convert")
def temp_check_convert(body: ConvertBody, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_viewer)) -> dict[str, Any]:
    """How a Boolean converts to a search of our tables: what was converted, approximated and left out, and (when
    asked) what each table would scan and the SQL. Nothing runs."""
    return tempcheck.preview(ctx, query_ref=body.query, boolean=body.boolean, filters=body.filters, sources=body.sources,
                             since=body.since, estimate=body.estimate)


@router.get("/temp-checks/run/{run_key}")
def temp_check_progress(run_key: str, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_viewer)) -> dict[str, Any]:
    """What a run started from this page has done so far, by the key the page gave it."""
    check = tempcheck.by_run_key(ctx, run_key[:64])
    if check is None:
        return {"check_id": "", "status": "starting", "steps": [], "error": "", "started_at": None}
    return {"check_id": check.check_id, "status": check.status, "steps": check.steps, "error": check.error, "started_at": check.created_at}


@router.post("/temp-checks")
def temp_check_run(body: TempCheckBody, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_analyst)) -> dict[str, Any]:
    if not any([body.issue.strip(), body.query_ref.strip(), body.boolean.strip(), body.filters, body.case_id, body.update_of]):
        raise HTTPException(422, {"error": "Pick a Brandwatch query, or name the issue.", "code": "validation_error"})
    ref = body.query_ref.strip()
    if ref and not tempcheck.query_id(ref):  # named by words: when they fit several queries, or none, the close ones are offered and nothing runs
        try:
            found = tempcheck.match_query(tempcheck.Brandwatch(ctx), ref)
        except tempcheck.BrandwatchUnavailable:
            found = {"query": None}
        if "query" not in found:
            pick = lambda rows: [{"id": q["id"], "name": q["name"], "created": q.get("created"), "state": q.get("state")} for q in rows or []]  # noqa: E731
            return {"needs": {"choices": pick(found.get("choices")), "near": pick(found.get("near")), "missing": found.get("missing") or 0}}
    payload = body.model_dump(exclude={"from_alert"})
    result = run_op(ctx, "run_temp_check", {**payload, "case_id": body.case_id.upper() if body.case_id else None, "actor": user.email,
                                            "via": "console", **({"trigger": "alert"} if body.from_alert else {})}, user)
    check = tempcheck.get(ctx, result["data"].get("check_id", ""))
    return {**result, "check": check.model_dump(mode="json") if check else None}


@router.get("/temp-checks/{check_id}")
def temp_check_get(check_id: str, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_viewer)) -> dict[str, Any]:
    check = tempcheck.get(ctx, check_id)
    if check is None:
        raise _missing("temp check")
    chain = [c for c in tempcheck.list_checks(ctx, limit=300) if c.update_of == check_id or c.check_id == check.update_of]
    return {"check": check.model_dump(mode="json"), "related": [_check_brief(c) for c in chain]}


@router.get("/temp-checks/{check_id}/own-posts")
def temp_check_own_posts(check_id: str, limit: int = Query(60, ge=1, le=500), ctx: AgentContext = Depends(get_ctx),
                         user: User = Depends(require_viewer)) -> dict[str, Any]:
    """The posts our own tables found for a temp check, the most engaged first (the "Our data" tab's cards)."""
    if tempcheck.get(ctx, check_id) is None:
        raise _missing("temp check")
    kept = tempcheck.kept_posts(ctx, check_id)
    return {"kept": len(kept), "posts": [tempcheck.as_writeup_post(p) for p in kept[:limit]]}


@router.post("/temp-checks/{check_id}/action")
def temp_check_action(check_id: str, body: TempActionBody, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_analyst)) -> dict[str, Any]:
    try:
        check = tempcheck.record_action(ctx, check_id, user.email, body.action, body.note)
    except KeyError as exc:
        raise _missing("temp check") from exc
    return {"ok": True, "check": check.model_dump(mode="json")}


class WebBody(BaseModel):
    need: str = Field("", max_length=500)  # what the analyst needs to know; blank = what people are saying about the issue


@router.post("/temp-checks/{check_id}/web")
def temp_check_web(check_id: str, body: WebBody, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_analyst)) -> dict[str, Any]:
    """Search the web for what the analyst needs to know about this temp check's issue. The answer goes to the analyst
    who asked and nowhere else: nothing found is kept, and the record says only who asked and what for."""
    check = tempcheck.get(ctx, check_id)
    if check is None:
        raise _missing("temp check")
    asked = {"target_type": "temp_check", "target_id": check.check_id, "case_id": check.case_id}
    try:
        found = webfind.find(ctx, check, body.need)
    except webfind.Off as exc:
        raise HTTPException(409, {"error": str(exc), "code": "switched_off"}) from exc
    except webfind.Unavailable as exc:
        audit.record(ctx, actor=user.email, action="temp_check.web", surface="console", status="error", summary=str(exc)[:300],
                     detail={"need": " ".join(body.need.split())}, **asked)
        raise HTTPException(503, {"error": str(exc), "code": "web_search_failed"}) from exc
    audit.record(ctx, actor=user.email, action="temp_check.web", surface="console", summary="Searched the web for a temp check's issue",
                 detail={"need": found["need"], "search": found["search"]}, **asked)
    return found


# -- workforce -----------------------------------------------------------------------------------------------------------
class RecommendationBody(BaseModel):
    decision: Literal["accept", "edit", "dismiss"]
    person_id: str | None = None
    start: datetime | None = None
    end: datetime | None = None
    note: str = Field("", max_length=500)


@router.get("/workforce/actuals")
def wf_actuals(ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_viewer)) -> dict[str, Any]:
    return workforce.actuals(ctx)


@router.get("/workforce/historicals")
def wf_historicals(days: int = Query(28, ge=1, le=180), ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_viewer)) -> dict[str, Any]:
    return workforce.historicals(ctx, days)


@router.get("/workforce/intraday")
def wf_intraday(back: int = Query(12, ge=1, le=72), ahead: int = Query(12, ge=0, le=168),
                ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_viewer)) -> dict[str, Any]:
    return workforce.intraday(ctx, back, ahead)


@router.get("/workforce/coverage")
def wf_coverage(days: int = Query(7, ge=1, le=28), start: datetime | None = None, roster: str = ROSTER_IM,
                ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_viewer)) -> dict[str, Any]:
    """Who is scheduled in each hour, for the roster builder's coverage grid."""
    if roster not in ("slrr_im", "burson"):
        raise _missing("roster")
    cfg = ctx.config.platform.forecasting
    first = workforce.floor_hour(start or ctx.now())
    grid = workforce.staffing_by_hour(ctx.roster(roster), first, first + timedelta(days=days))
    latest = workforce.latest_forecast(ctx)
    forecast = {datetime.fromisoformat(p["ts"]): p["value"] for p in latest.points} if latest else {}
    rows = []
    for at, staff in sorted(grid.items()):
        need = workforce.required_staff(forecast[at], cfg) if at in forecast else None
        rows.append({"hour": at, "staff": len(staff), "people": [{"id": p.id, "name": p.name, "source": src} for p, src in staff],
                     "forecast": round(forecast[at], 2) if at in forecast else None, "required": need,
                     "short": bool(need is not None and len(staff) < need)})
    return {"roster": roster, "timezone": str(workforce.tz_of(ctx)), "hours": rows,
            "shifts": [s.model_dump(mode="json") for s in ctx.config.shifts]}


@router.get("/workforce/forecast")
def wf_forecast(ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_viewer)) -> dict[str, Any]:
    cfg = ctx.config.platform.forecasting
    latest = workforce.latest_forecast(ctx)
    runs = ctx.store.list_docs(workforce.FORECASTS, limit=15)
    return {"enabled": ctx.flag("workforce_forecasting"), "settings": cfg.model_dump(mode="json"),
            "latest": latest.model_dump(mode="json") if latest else None,
            "runs": [{k: r.get(k) for k in ("run_id", "created_at", "method", "status", "error", "fallback_from", "requested_by", "model")}
                     | {"points": len(r.get("points") or [])} for r in runs],
            "accuracy": workforce.forecast_accuracy(ctx, 14)}


@router.post("/workforce/forecast/run")
def wf_forecast_run(ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_lead)) -> dict[str, Any]:
    try:
        return workforce.run_forecast(ctx, actor=user.email, force=True)
    except Exception as exc:  # noqa: BLE001 - the message says what to set
        raise _bad(exc, 409) from exc


@router.get("/workforce/recommendations")
def wf_recommendations(status: str | None = None, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_viewer)) -> dict[str, Any]:
    recs = workforce.list_recommendations(ctx, status=status or None)
    people = [{"id": p.id, "name": p.name, "email": p.email} for p in ctx.roster(ROSTER_IM).people]
    return {"recommendations": [r.model_dump(mode="json") for r in recs], "people": people}


@router.post("/workforce/recommendations/{rec_id}")
def wf_decide(rec_id: str, body: RecommendationBody, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_lead)) -> dict[str, Any]:
    try:
        rec = workforce.decide_recommendation(ctx, rec_id, actor=user.email, decision=body.decision, person_id=body.person_id,
                                              start=body.start, end=body.end, note=body.note)
    except KeyError as exc:
        raise _missing("recommendation") from exc
    except ValueError as exc:
        raise _bad(exc, 409) from exc
    return {"ok": True, "recommendation": rec.model_dump(mode="json")}


@router.get("/workforce/report")
def wf_report(days: int = Query(14, ge=1, le=180), ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_viewer)) -> dict[str, Any]:
    return workforce.report(ctx, days)


@router.get("/workforce/report.csv")
def wf_report_csv(days: int = Query(14, ge=1, le=180), ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_viewer)) -> PlainTextResponse:
    return PlainTextResponse(workforce.report_csv(ctx, days), media_type="text/csv",
                             headers={"Content-Disposition": f'attachment; filename="workforce-report-{days}d.csv"'})


# -- knowledge -----------------------------------------------------------------------------------------------------------
class DocBody(BaseModel):
    doc_id: str | None = None
    title: str = Field(..., min_length=1, max_length=200)
    source_type: Literal["text", "url", "drive"] = "text"
    link: str = Field("", max_length=2000)
    text: str | None = Field(None, max_length=1_000_000)
    html: str | None = Field(None, max_length=4_000_000)  # the document as the editor holds it (cleaned before it is kept)
    covers: str = Field("", max_length=1000)
    kind: Literal["document", "guidance"] = "document"
    tags: list[str] = Field(default_factory=list)
    classes: list[str] = Field(default_factory=list)
    external_ok: bool = False
    enabled: bool = True


class SearchBody(BaseModel):
    query: str = Field(..., min_length=1, max_length=2000)
    label: str | None = None
    external: bool = False


class SheetImportBody(BaseModel):
    dry_run: bool = True  # preview: what would be added, updated, left the same or left out, and why
    budget_chars: int = Field(400_000, ge=10_000, le=5_000_000)  # text stored in one call; the page calls again for the rest


@router.get("/knowledge")
def knowledge_list(ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_viewer)) -> dict[str, Any]:
    docs = knowledge.list_docs(ctx)
    cfg = ctx.config.platform
    classes = knowledge.classes(ctx)
    mapping = []
    for c in classes:
        allowed = knowledge.docs_for_class(ctx, c.name) or set()
        mapping.append({"name": c.name, "description": c.description, "knowledge_tags": c.knowledge_tags,
                        "docs": sorted(d.doc_id for d in docs if d.doc_id in allowed)})
    return {"docs": [d.model_dump(mode="json") for d in docs], "classes": mapping,
            "classes_from_settings": bool(cfg.classification.classes),
            "switches": {"knowledge_rag": cfg.flags.knowledge_rag, "classification_layer": cfg.flags.classification_layer},
            "retrieval": {"embedding_model": cfg.knowledge.embedding_model, "top_k": cfg.knowledge.top_k},
            "can_edit": user.has("lead"), "can_import": user.has("admin")}


@router.post("/knowledge/import-sheet")
def knowledge_import_sheet(body: SheetImportBody, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_admin)) -> dict[str, Any]:
    """Bring the sheet-based bot's knowledge docs over (its Resources tab, with the text the bot already read). dry_run
    previews; otherwise up to budget_chars of text is stored and `remaining` says how many are left for the next call.
    The sheet is read with the Console's own account: when it can't, the error says what to share with whom."""
    from triage_agent import knowledge_import, sheet_read

    try:
        return knowledge_import.run(ctx, actor=user.email, dry_run=body.dry_run, budget_chars=body.budget_chars)
    except sheet_read.SheetUnreadable as exc:
        raise HTTPException(502, {"error": str(exc), "code": "sheet_unreadable"}) from exc


@router.get("/knowledge/{doc_id}")
def knowledge_get(doc_id: str, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_viewer)) -> dict[str, Any]:
    doc = knowledge.get_doc(ctx, doc_id)
    if doc is None:
        raise _missing("knowledge doc")
    return {"doc": doc.model_dump(mode="json"), "text": knowledge.get_text(ctx, doc_id), "html": knowledge.get_html(ctx, doc_id),
            "editable": doc.source_type == "text"}  # a linked document is edited where it lives


@router.post("/knowledge/upload")
async def knowledge_upload(request: Request, filename: str = Query(..., min_length=1, max_length=300), covers: str = Query("", max_length=1000),
                           kind: Literal["document", "guidance"] = "document", ctx: AgentContext = Depends(get_ctx),
                           user: User = Depends(require_lead)) -> dict[str, Any]:
    """A file becomes a document: Word (.docx), PDF, a web page, Markdown or plain text. The file is the request body."""
    from triage_agent import docfiles

    limit = ctx.config.platform.knowledge.max_upload_mb
    data = await request.body()
    if len(data) > limit * 1024 * 1024:
        raise HTTPException(413, {"error": f"The file is larger than {limit} MB.", "code": "too_large"})
    try:
        title, content = docfiles.from_upload(filename, data)
    except ValueError as exc:
        raise HTTPException(422, {"error": str(exc), "code": "validation_error"}) from exc
    doc = knowledge.save_doc(ctx, actor=user.email, title=title, source_type="text", html=content, covers=covers, kind=kind,
                             file_name=filename.rsplit("/", 1)[-1])
    return {"ok": True, "doc": doc.model_dump(mode="json")}


def _export_one(ctx: AgentContext, doc: Any, fmt: str) -> tuple[bytes, str, str]:
    from triage_agent import docfiles

    return docfiles.export(doc.title, knowledge.get_html(ctx, doc.doc_id), fmt)


@router.get("/knowledge/{doc_id}/export")
def knowledge_export(doc_id: str, format: str = "docx", ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_viewer)) -> Response:
    """One document as Word (docx), a web page (html) or plain text (txt)."""
    doc = knowledge.get_doc(ctx, doc_id)
    if doc is None:
        raise _missing("knowledge doc")
    try:
        data, media, name = _export_one(ctx, doc, format)
    except ValueError as exc:
        raise HTTPException(422, {"error": str(exc), "code": "validation_error"}) from exc
    ctx.audit(actor=user.email, action="knowledge.export", surface="console", target_type="knowledge", target_id=doc_id,
              summary=f"Exported knowledge doc “{doc.title}” as {format}")
    return Response(data, media_type=media, headers={"Content-Disposition": f'attachment; filename="{name}"'})


@router.get("/knowledge-export")
def knowledge_export_all(format: str = "docx", ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_viewer)) -> Response:
    """Every document in one .zip, each as Word (docx), a web page (html) or plain text (txt)."""
    from triage_agent import docfiles

    docs = knowledge.list_docs(ctx)
    try:
        files = [(name, data) for data, _, name in (_export_one(ctx, d, format) for d in docs)]
    except ValueError as exc:
        raise HTTPException(422, {"error": str(exc), "code": "validation_error"}) from exc
    ctx.audit(actor=user.email, action="knowledge.export_all", surface="console", target_type="knowledge",
              summary=f"Exported the Knowledge base ({len(files)} documents) as {format}")
    return Response(docfiles.zip_of(files), media_type="application/zip", headers={"Content-Disposition": 'attachment; filename="knowledge-base.zip"'})


@router.post("/knowledge")
def knowledge_save(body: DocBody, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_lead)) -> dict[str, Any]:
    if body.source_type != "text" and not body.link.strip():
        raise HTTPException(422, {"error": "Paste the document's link.", "code": "validation_error"})
    if body.source_type == "text" and body.doc_id is None and not (body.text or "").strip() and not (body.html or "").strip():
        raise HTTPException(422, {"error": "Write the document, or upload a file.", "code": "validation_error"})
    doc = knowledge.save_doc(ctx, actor=user.email, **body.model_dump())
    return {"ok": True, "doc": doc.model_dump(mode="json")}


@router.delete("/knowledge/{doc_id}")
def knowledge_delete(doc_id: str, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_lead)) -> dict[str, Any]:
    if not knowledge.delete_doc(ctx, doc_id, user.email):
        raise _missing("knowledge doc")
    return {"ok": True}


@router.post("/knowledge/{doc_id}/refresh")
def knowledge_refresh(doc_id: str, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_lead)) -> dict[str, Any]:
    doc = knowledge.get_doc(ctx, doc_id)
    if doc is None:
        raise _missing("knowledge doc")
    return {"ok": True, "doc": knowledge.refresh_doc(ctx, doc, user.email, force=True).model_dump(mode="json")}  # whatever the stored copy says


@router.post("/knowledge/search")
def knowledge_search(body: SearchBody, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_viewer)) -> dict[str, Any]:
    """Try retrieval: what the agent would read for a question or an alert."""
    passages = knowledge.retrieve(ctx, body.query, label=body.label or None, external=body.external, include_cases=not body.external)
    return {"passages": [p.model_dump(mode="json") for p in passages], "count": len(passages)}


@router.get("/golden")
def golden_list(label: str | None = None, limit: int = Query(200, ge=1, le=2000),
                ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_viewer)) -> dict[str, Any]:
    records = golden.list_records(ctx, label=label or None, limit=limit)
    return {"stats": golden.stats(ctx), "records": [r.model_dump(mode="json", exclude={"alert_text"}) for r in records],
            "capture_on": ctx.flag("golden_set_capture")}


@router.get("/golden/export.yaml")
def golden_export(ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_lead)) -> PlainTextResponse:
    ctx.audit(actor=user.email, action="golden.export", surface="console", target_type="golden", summary="Exported the golden set")
    return PlainTextResponse(golden.export_yaml(ctx), media_type="application/yaml",
                             headers={"Content-Disposition": 'attachment; filename="golden_from_console.yaml"'})


# -- campaigns and watches -----------------------------------------------------------------------------------------------
class CampaignChangeBody(BaseModel):
    changes: dict[str, Any]


class WatchBody(BaseModel):
    watch_id: str | None = None
    name: str = Field(..., min_length=1, max_length=120)
    enabled: bool = False
    question: str = Field(..., min_length=1, max_length=2000)
    rubric: str = Field("", max_length=2000)
    topics: list[str] = Field(default_factory=list)
    flag_at_score: float | None = Field(None, ge=1, le=10)
    networks: list[str] = Field(default_factory=list)


class RatingBody(BaseModel):
    rating: Literal["", "Useful", "Noise"]


class SwitchBody(BaseModel):
    enabled: bool


class SignalImportBody(BaseModel):
    dry_run: bool = True


@router.get("/campaigns")
def campaigns_list(ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_viewer)) -> dict[str, Any]:
    try:
        rows = campaigns_admin.list_campaigns(ctx)
        requests = campaigns_admin.list_requests(ctx)
        error = ""
    except Exception as exc:  # noqa: BLE001 - the page says what to set
        rows, requests, error = [], [], str(exc)
    return {"campaigns": rows, "requests": requests[:100], "error": error, "can_change": ctx.flag("campaigns") and user.has("lead"),
            "switch": ctx.flag("campaigns"), "editable": list(campaigns_admin.EDITABLE), "actions": list(campaigns_admin.ACTIONS)}


@router.post("/campaigns/{campaign_id}/changes")
def campaigns_change(campaign_id: str, body: CampaignChangeBody, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_lead)) -> dict[str, Any]:
    try:
        return {"ok": True, "request": campaigns_admin.request_change(ctx, campaign_id=campaign_id, changes=body.changes, actor=user.email)}
    except KeyError as exc:
        raise _missing("campaign") from exc
    except PermissionError as exc:
        raise _bad(exc, 403) from exc
    except ValueError as exc:
        raise _bad(exc, 422) from exc


@router.get("/watches")
def watches_list(days: int = Query(7, ge=1, le=30), ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_viewer)) -> dict[str, Any]:
    cfg = ctx.config.platform.campaigns
    detections = watches.list_detections(ctx, days=days, limit=300)
    since = ctx.now() - timedelta(hours=24)
    checked = watches.checked_ids(ctx)
    rows = []
    for w in watches.list_watches(ctx):
        recent = [d for d in detections if d.watch_id == w.watch_id and d.seen_at >= since]
        flagged = sum(1 for d in recent if d.at_bar)
        rows.append({**w.model_dump(mode="json"), "checked": w.watch_id in checked and ctx.flag("watches") and bool(cfg.watch_sources),
                     "flagged_24h": flagged, "near_misses_24h": len(recent) - flagged,
                     "plain_status": watches.plain_status(w, switch_on=ctx.flag("watches"), sources_set=bool(cfg.watch_sources),
                                                          checked=w.watch_id in checked, limit=cfg.watch_max_enabled,
                                                          flagged=flagged, near=len(recent) - flagged)})
    return {"watches": rows,
            "detections": [d.model_dump(mode="json") for d in detections],
            "scorecard": watches.scorecard(ctx, days), "switch": ctx.flag("watches"), "can_edit": user.has("lead"),
            "can_import": user.has("lead"),
            "settings": {"default_bar": cfg.watch_default_bar, "max_enabled": cfg.watch_max_enabled, "sources": cfg.watch_sources,
                         "post_target": cfg.watch_post_target, "default_topics": cfg.watch_default_topics,
                         "interval_minutes": cfg.watch_interval_minutes},
            # what a new signal starts from: the sheet's defaults (topics from Settings when it names some) and its templates
            "defaults": {"rubric": watches.SHEET_DEFAULT_RUBRIC, "topics": cfg.watch_default_topics or watches.SHEET_DEFAULT_TOPICS,
                         "flag_at_score": cfg.watch_default_bar},
            "templates": watches.SHEET_TEMPLATES}


@router.post("/watches")
def watches_save(body: WatchBody, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_lead)) -> dict[str, Any]:
    """Adds or changes a signal, whatever the Watches switch says (the switch only decides whether the Console looks)."""
    try:
        return {"ok": True, "watch": watches.save_watch(ctx, user.email, body.model_dump()).model_dump(mode="json")}
    except ValueError as exc:
        raise _bad(exc, 422) from exc


@router.post("/watches/import-sheet")
def watches_import_sheet(body: SignalImportBody, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_lead)) -> dict[str, Any]:
    """Bring the sheet's signals (its Watches tab) over, all OFF; dry_run previews. The same name again updates its signal."""
    from triage_agent import sheet_read, watches_import

    try:
        return watches_import.run(ctx, actor=user.email, dry_run=body.dry_run)
    except sheet_read.SheetUnreadable as exc:
        raise HTTPException(502, {"error": str(exc), "code": "sheet_unreadable"}) from exc
    except ValueError as exc:
        raise _bad(exc, 422) from exc


@router.post("/watches/{watch_id}/switch")
def watches_switch(watch_id: str, body: SwitchBody, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_lead)) -> dict[str, Any]:
    """Turns one signal on or off (at most watch_max_enabled on at once), whatever the Watches switch says."""
    try:
        return {"ok": True, "watch": watches.set_enabled(ctx, user.email, watch_id, body.enabled).model_dump(mode="json")}
    except KeyError as exc:
        raise _missing("signal") from exc
    except ValueError as exc:
        raise _bad(exc, 422) from exc


@router.delete("/watches/{watch_id}")
def watches_delete(watch_id: str, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_lead)) -> dict[str, Any]:
    if not watches.delete_watch(ctx, user.email, watch_id):
        raise _missing("signal")
    return {"ok": True}


@router.post("/watches/run")
def watches_run(ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_lead)) -> dict[str, Any]:
    if not ctx.flag("watches"):
        raise HTTPException(403, {"error": switch_off("Checking new posts against the signals", "watches"), "code": "rejected"})
    ctx.audit(actor=user.email, action="watch.run", surface="console", target_type="watch", summary="Ran a look by hand")
    return watches.run_due(ctx, actor=user.email, force=True)


@router.post("/watches/detections/{detection_id}/rating")
def watches_rate(detection_id: str, body: RatingBody, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_analyst)) -> dict[str, Any]:
    try:
        return {"ok": True, "detection": watches.rate(ctx, detection_id, body.rating, user.email).model_dump(mode="json")}
    except KeyError as exc:
        raise _missing("detection") from exc


__all__ = ["router", "require_admin"]
