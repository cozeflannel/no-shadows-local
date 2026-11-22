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
         "does": "Writes everything a person reads: the Console chat agent's answers, the QA chatbot's replies in Chat, alert write-ups and each early story's headline and call.",
         "state": "ready", "facts": [_fact("Alert reviews", cfg.models.triage), _fact("Chat agent", p.chat_agent.model or cfg.models.converse),
                                     _fact("Calls in the last 24 hours", len(usage))],
         "switches": [_switch(ctx, "console_chat_agent"), _switch(ctx, "knowledge_rag")],
         "settings": [{"label": "Console chat agent", "to": "/settings/platform/chat_agent"}, {"label": "Models", "to": "/settings/models"}]},
        {"key": "decisions", "name": "Gemini Decisions", "role": "Decides",
         "does": "Answers set questions with probabilities and writes no text: which class an alert is, and whether an early story is about the company, a risk, first-hand, or routine chatter.",
         "state": "failing" if dec["paused_until"] else "ready" if dec["connected"] else "not_connected",
         "facts": [_fact("Model", dec["model"]), _fact("Asked today", dec["today"]["asked"]), _fact("Failed today", dec["today"]["failed"]),
                   *([_fact("Paused", dec["paused_why"] or "after a failure")] if dec["paused_until"] else [])],
         "switches": [_switch(ctx, "decisions_classifier"), _switch(ctx, "early_fast_triage")],
         "settings": [{"label": "Gemini Decisions", "to": "/settings/platform/decisions"}]},
        {"key": "bigquery", "name": "Vertex AI in BigQuery", "role": "Reads the post tables",
         "does": "Runs next to the data: Early Detection turns each new post into an embedding and groups like posts into stories, and Watches ask their question of every new post and score the matches.",
         "state": "failing" if es["error"] else "ready" if es["named_sources"] and p.bigquery.dataset else "incomplete",
         "facts": [_fact("Embedding model", es["endpoint"]), _fact("Post tables read", ", ".join(es["named_sources"]) or "none named"),
                   _fact("Last read", es["last"] or "not yet"), _fact("Stories raised today", es["raised_today"]), _fact("Watches ON", len(live_watches))],
         "switches": [_switch(ctx, "early_detection"), _switch(ctx, "watches"), _switch(ctx, "early_cards")],
         "settings": [{"label": "Early Detection", "to": "/settings/platform/early"}, {"label": "Campaigns and watches", "to": "/settings/platform/campaigns"},
                      {"label": "BigQuery", "to": "/settings/platform/bigquery"}]},
        {"key": "documents", "name": "Document search", "role": "Grounds the answers",
         "does": "Finds the passages of your Knowledge documents that bear on a question or an alert and hands them to Gemini, which cites them. This is how company questions get company answers.",
         "state": "ready" if docs else "incomplete",
         "facts": [_fact("Documents", len(docs)), _fact("Search", "words and meaning" if p.knowledge.embedding_model else "words only"),
                   _fact("Embedding model", p.knowledge.embedding_model or "none set")],
         "switches": [_switch(ctx, "knowledge_rag")],
         "settings": [{"label": "How documents are read", "to": "/settings/platform/knowledge"}, {"label": "Knowledge", "to": "/knowledge"}]},
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
        return {"step": name, "ok": False, "detail": str(exc)[:400], "ms": int((time.monotonic() - t0) * 1000)}


def _check_gemini(ctx: AgentContext) -> list[dict[str, Any]]:
    cfg = ctx.config
    models = dict.fromkeys(m for m in (cfg.models.triage, cfg.platform.chat_agent.model or cfg.models.converse) if m)
    return [_step(f"{m} answers", lambda m=m: "said: " + ctx.llm.generate_text(model=m, system="Answer in one word.", prompt="Say ready.",
                                                                              temperature=0.0, purpose="ai.check").strip()[:40]) for m in models]


def _check_decisions(ctx: AgentContext) -> list[dict[str, Any]]:
    def one() -> str:
        q = {"risk": {"type": "noul", "instructions": "Does the input describe a service outage?",
                      "criteria": {"true_description": "A service is down.", "false_description": "Nothing is down."}}}
        r = decisions.ask(ctx, "Several people report that the service has been down for an hour.", q, purpose="ai.check")
        if not r["ok"]:
            raise RuntimeError(r["why"])
        return f"answered {r['answers']['risk']['p']:.2f} in {r['ms']} ms"

    return [_step("One question is answered with a probability", one)]


def _check_bigquery(ctx: AgentContext) -> list[dict[str, Any]]:
    gw = bq_admin.get_gateway(ctx)
    e = ctx.config.platform.early
    home = ctx.config.platform.bigquery.location or None
    steps = [_step("Vertex AI makes an embedding from BigQuery", lambda: str(gw.query(
        f"SELECT ARRAY_LENGTH(AI.EMBED('ready', endpoint => '{e.embedding_endpoint}', task_type => 'SEMANTIC_SIMILARITY'{early._connection(e)}).result) AS n",
        location=home, labels=early.LABELS)[0]["n"]) + " numbers")]
    try:
        plan = early.plan(ctx, ctx.now())
    except Exception as exc:  # noqa: BLE001
        return steps + [{"step": "Early Detection's statements", "ok": False, "detail": str(exc)[:400], "ms": 0}]
    for item in plan:  # a dry run of each statement: BigQuery checks it against the real tables and runs nothing
        steps.append(_step(f"Early Detection: {item['what']}", lambda item=item: f"valid, would read {gw.dry_run(item['sql'], item['params'], location=item['location']):,} bytes"))
    return steps


def _check_documents(ctx: AgentContext) -> list[dict[str, Any]]:
    steps = [_step("A search finds passages", lambda: f"{len(knowledge.retrieve(ctx, 'escalation process'))} passages for a test question")]
    if ctx.config.platform.knowledge.embedding_model:
        steps.append(_step("The embedding model answers", lambda: f"{len((knowledge.embed(ctx, ['ready']) or [[]])[0])} numbers"))
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
    result = {"ok": all(s["ok"] for s in steps), "steps": steps, "at": ctx.now().isoformat(), "by": user.email}
    ctx.store.put_kv(f"ai:check:{key}", result)
    ctx.audit(actor=user.email, action="ai.check", surface="console", target_type="engine", target_id=key, status="ok" if result["ok"] else "error",
              summary=f"Checked {key}: {'all good' if result['ok'] else next(s['detail'] for s in steps if not s['ok'])}"[:300])
    return result
