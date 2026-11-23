"""The AI page and the Early Detection page.

The AI page shows the three engines side by side, what each is for, whether it is connected, and checks each one
live: Gemini talks with people, Gemini Decisions decides, and Vertex AI in BigQuery reads the post tables at scale.
Document search (RAG) is what lets Gemini answer company questions from the Knowledge documents.
"""

from __future__ import annotations

import time
from datetime import timedelta
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from triage_agent import bq_admin, decisions, early, knowledge, watches
from triage_agent.config import switch_title
from triage_agent.context import AgentContext

from .auth import User, get_ctx, require_admin, require_analyst, require_lead, require_viewer

router = APIRouter(prefix="/api", tags=["ai"])
ENGINES = ("gemini", "decisions", "bigquery", "documents")


# -- Early Detection ---------------------------------------------------------------------------------------------------
@router.get("/early")
def early_list(hours: int = 72, status: str = "", ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_viewer)) -> dict[str, Any]:
    return {"signals": early.list_signals(ctx, max(1, min(hours, 24 * 30)), status), "state": early.status(ctx),
            "can_act": user.has("analyst"), "can_run": user.has("lead")}


@router.post("/early/check")
def early_check(ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_lead)) -> dict[str, Any]:
    """Read the post tables now, without waiting for the next read."""
    result = early.check(ctx, force=True)
    ctx.audit(actor=user.email, action="early.check", surface="console", target_type="early", status="ok" if result.get("ok") else "error",
              summary="Started an Early Detection read by hand" + (f": {result.get('error')}" if result.get("error") else ""))
    return result


class ActBody(BaseModel):
    action: Literal["acknowledge", "escalate", "dismiss", "reopen"]
    note: str = Field("", max_length=500)


@router.post("/early/{signal_id}/action")
def early_act(signal_id: str, body: ActBody, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_analyst)) -> dict[str, Any]:
    try:
        return early.act(ctx, signal_id, body.action, user.email, body.note)
    except KeyError as exc:
        raise HTTPException(404, {"error": "That story is no longer kept.", "code": "not_found"}) from exc


# -- the AI page -------------------------------------------------------------------------------------------------------
def _fact(label: str, value: Any) -> dict[str, str]:
    return {"label": label, "value": str(value)}


def _switch(ctx: AgentContext, name: str) -> dict[str, Any]:
    return {"name": name, "title": switch_title(name), "on": ctx.config.platform.flag(name)}


def overview(ctx: AgentContext) -> list[dict[str, Any]]:
    cfg = ctx.config
    p = cfg.platform
    since = ctx.now() - timedelta(hours=24)
    usage = ctx.events.query(since=since, types=["llm.usage"], limit=20000)
    dec = decisions.status(ctx)
    es = early.status(ctx)
    docs = knowledge.list_docs(ctx)
    live_watches = [w for w in watches.list_watches(ctx) if w.enabled]
    return [
        {"key": "gemini", "name": "Gemini", "role": "Talks with people",
         "does": "Writes everything a person reads: the Console chat agent's answers, the QA chatbot's replies in Chat, alert write-ups, each early story's headline and call, and the review of each agent alert.",
         "state": "ready", "facts": [_fact("Runs on", "Vertex AI, called from Cloud Run and the Agent Runtime"),
                                     _fact("Alert reviews", cfg.models.triage), _fact("Chat agent", p.chat_agent.model or cfg.models.converse),
                                     _fact("Calls in the last 24 hours", len(usage))],
         "switches": [_switch(ctx, "console_chat_agent"), _switch(ctx, "knowledge_rag"), _switch(ctx, "story_reads")],
         "settings": [{"label": "Console chat agent", "to": "/settings/chat_agent"}, {"label": "Models", "to": "/settings/models"}]},
        {"key": "decisions", "name": "Gemini Decisions", "role": "Decides",
         "does": "Answers set questions with probabilities and writes no text: which class an alert is, and whether an early story is about the company, a risk, first-hand, or routine chatter.",
         "state": "failing" if dec["paused_until"] else "ready" if dec["connected"] else "not_connected",
         "facts": [_fact("Runs on", "Google's Gemini Decisions service, called from Cloud Run and the Agent Runtime"),
                   _fact("Model", dec["model"]), _fact("Asked today", dec["today"]["asked"]), _fact("Failed today", dec["today"]["failed"]),
                   *([_fact("Paused", dec["paused_why"] or "after a failure")] if dec["paused_until"] else [])],
         "switches": [_switch(ctx, "decisions_classifier"), _switch(ctx, "early_fast_triage")],
         "settings": [{"label": "Gemini Decisions", "to": "/settings/decisions"}]},
        {"key": "bigquery", "name": "Vertex AI in BigQuery", "role": "Reads the post tables",
         "does": "Runs next to the data: Early Detection turns each new post into an embedding and groups like posts into stories, Agent alerts checks each new post against its rules and groups the rest into stories, and Watches ask their question of every new post and score the matches.",
         "state": "failing" if es["error"] else "ready" if es["named_sources"] and p.bigquery.dataset else "incomplete",
         "facts": [_fact("Runs on", "Inside BigQuery, on Vertex AI"),
                   _fact("Embedding model", es["endpoint"]), _fact("Post tables read", ", ".join(es["named_sources"]) or "none named"),
                   _fact("Last read", (es["last"][:16].replace("T", " ") + " UTC") if es["last"] else "not yet"), _fact("Stories raised today", es["raised_today"]), _fact("Watches ON", len(live_watches))],
         "switches": [_switch(ctx, "early_detection"), _switch(ctx, "watches"), _switch(ctx, "early_cards"), _switch(ctx, "own_alerts")],
         "settings": [{"label": "Early Detection", "to": "/settings/early"}, {"label": "Agent alerts", "to": "/settings/own_alerts"},
                      {"label": "Campaigns and watches", "to": "/settings/campaigns"}, {"label": "BigQuery", "to": "/settings/bigquery"}]},
        {"key": "documents", "name": "Document search", "role": "Grounds the answers",
         "does": "Finds the passages of your Knowledge documents that bear on a question or an alert and hands them to Gemini, which cites them. This is how company questions get company answers.",
         "state": "ready" if docs else "incomplete",
         "facts": [_fact("Runs on", "Vertex AI embeddings, called from Cloud Run and the Agent Runtime"),
                   _fact("Documents", len(docs)), _fact("Search", "words and meaning" if p.knowledge.embedding_model else "words only"),
                   _fact("Embedding model", p.knowledge.embedding_model or "none set")],
         "switches": [_switch(ctx, "knowledge_rag")],
         "settings": [{"label": "How documents are read", "to": "/settings/knowledge"}, {"label": "Knowledge", "to": "/knowledge"}]},
    ]


@router.get("/ai")
def ai_get(ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_viewer)) -> dict[str, Any]:
    checks = {key: ctx.store.get_kv(f"ai:check:{key}") for key in ENGINES}
    return {"engines": [{**e, "check": checks[e["key"]]} for e in overview(ctx)], "can_check": user.has("admin")}


def _step(name: str, fn: Any) -> dict[str, Any]:
    t0 = time.monotonic()
    try:
        detail = fn()
        return {"step": name, "ok": True, "detail": str(detail), "ms": int((time.monotonic() - t0) * 1000)}
    except Exception as exc:  # noqa: BLE001 - the reason is the result
        out = {"step": name, "ok": False, "detail": str(exc)[:400], "ms": int((time.monotonic() - t0) * 1000)}
        return {**out, "waiting": True} if bq_admin.no_access(exc) else out


def _check_gemini(ctx: AgentContext) -> list[dict[str, Any]]:
    """What each model's real calls say. No test prompt is sent."""
    from triage_agent.prompts import call_evidence

    cfg = ctx.config
    models = dict.fromkeys(m for m in (cfg.models.triage, cfg.platform.chat_agent.model or cfg.models.converse) if m)
    return [_step(f"{m}: its real calls", lambda m=m: call_evidence(ctx, m)) for m in models]


def _check_decisions(ctx: AgentContext) -> list[dict[str, Any]]:
    """Today's real calls to Gemini Decisions. No test question is asked."""
    def state() -> str:
        st = decisions.status(ctx)
        if not st["connected"]:
            raise RuntimeError("no API key is set (Settings, Gemini Decisions)")
        if st["paused_until"]:
            raise RuntimeError(f"paused after a failure: {st['paused_why']}")
        t = st["today"]
        if not t["asked"]:
            return "Not asked yet today. It is asked when an alert or an early story comes in with one of its switches ON; a failure shows here."
        return f"asked {t['asked']} times today, {t['failed']} failed, {t['refused']} refused by the safety filter"

    return [_step("Its real calls today", state)]


def _check_bigquery(ctx: AgentContext) -> list[dict[str, Any]]:
    """Each Early Detection statement is checked by BigQuery against the real tables without running (a dry run),
    and the last real read of each table is reported. A table whose owners have not let this account in yet is
    marked `waiting`: it is said, and it does not fail the check."""
    gw = bq_admin.get_gateway(ctx)
    try:
        plan = early.plan(ctx, ctx.now())
    except Exception as exc:  # noqa: BLE001
        return [{"step": "Early Detection's statements", "ok": False, "detail": str(exc)[:400], "ms": 0}]
    steps = [{**_step(f"Early Detection: {item['what']}", lambda item=item: f"valid, would read {gw.dry_run(item['sql'], item['params'], location=item['location']):,} bytes"),
              "source": item["source"]} for item in plan]
    for src in early.status(ctx)["sources"]:
        steps.append({"step": f"Last real read of {src.get('label') or src['key']}", "ok": src.get("status") == "live",
                      "detail": src.get("error") or f"{src.get('how', 'read')} at {str(src.get('at', ''))[:16].replace('T', ' ')} UTC", "ms": 0,
                      "source": src["key"], **({"waiting": True} if src.get("status") == "waiting" else {})})
    return steps


def _check_documents(ctx: AgentContext) -> list[dict[str, Any]]:
    """What the documents themselves show. No test question is searched."""
    docs = knowledge.list_docs(ctx)
    steps = [{"step": "Documents kept", "ok": bool(docs), "ms": 0,
              "detail": f"{len(docs)} documents, {sum(d.chunks for d in docs)} passages" if docs else "No document yet. Add one on the Knowledge page."}]
    if ctx.config.platform.knowledge.embedding_model:
        steps.append(_step("Embeddings", lambda: knowledge.embedding_evidence(ctx)))
    return steps


@router.post("/ai/{key}/check")
def ai_check(key: str, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_admin)) -> dict[str, Any]:
    """Checks one engine against the live service, and keeps the result for the page."""
    run = {"gemini": _check_gemini, "decisions": _check_decisions, "bigquery": _check_bigquery, "documents": _check_documents}.get(key)
    if not run:
        raise HTTPException(404, {"error": "Unknown engine.", "code": "not_found"})
    try:
        steps = run(ctx)
    except Exception as exc:  # noqa: BLE001
        steps = [{"step": "Reach the service", "ok": False, "detail": str(exc)[:400], "ms": 0}]
    failed = [s for s in steps if not s["ok"] and not s.get("waiting")]
    waiting = len({s.get("source") or s["step"] for s in steps if s.get("waiting")})
    result = {"ok": not failed, "steps": steps, "at": ctx.now().isoformat(), "by": user.email}
    ctx.store.put_kv(f"ai:check:{key}", result)
    said = "all good" + (f", {waiting} table{'' if waiting == 1 else 's'} waiting for access" if waiting else "")
    ctx.audit(actor=user.email, action="ai.check", surface="console", target_type="engine", target_id=key, status="ok" if result["ok"] else "error",
              summary=f"Checked {key}: {said if result['ok'] else failed[0]['detail']}"[:300])
    return result
