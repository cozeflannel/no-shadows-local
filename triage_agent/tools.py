"""The agent's tool surface: one registry used by Chat (converse) and by the in-Console chat agent.

Every tool wraps something the agent already does (an operation, a store read, retrieval), so a person in the
Console can do through the chat agent exactly what the agent does in Chat, with the same permission rules:

  * a tool that changes something needs the caller to be an analyst / IM (leads and admins where the operation says so);
  * the operation it runs applies its own checks again (review_decision checks the actor, and so on);
  * every call is audited (who, which tool, what it was given, what came of it).

A tool takes plain JSON arguments and returns a JSON-able dict. Errors a person can fix are ToolError.
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass, field
from datetime import timedelta
from typing import TYPE_CHECKING, Any, Callable

from .events import PlatformEvent
from .models import CaseStatus

if TYPE_CHECKING:  # pragma: no cover
    from .context import AgentContext

log = logging.getLogger(__name__)
ROLE_RANK = {"none": 0, "viewer": 1, "analyst": 2, "im": 2, "lead": 3, "admin": 4}


class ToolError(RuntimeError):
    """The tool could not do what was asked; the message is safe to show."""


@dataclass
class Caller:
    email: str
    role: str = "viewer"  # viewer | analyst | lead | admin
    surface: str = "chat_agent"  # chat_agent | chat

    def has(self, role: str) -> bool:
        return ROLE_RANK.get(self.role, 0) >= ROLE_RANK[role]


@dataclass
class Tool:
    name: str
    description: str
    params: dict[str, str]  # name -> "type: what it is" ("?" after the type marks it optional)
    run: Callable[["AgentContext", dict[str, Any], Caller], dict[str, Any]]
    mutating: bool = False
    min_role: str = "viewer"
    flag: str = ""  # a Console switch that must be ON
    summary: Callable[[dict[str, Any]], str] = field(default=lambda args: "")

    def spec(self) -> dict[str, Any]:
        return {"name": self.name, "description": self.description, "params": self.params, "changes_something": self.mutating,
                "needs_role": self.min_role, "needs_switch": self.flag or None}


REGISTRY: dict[str, Tool] = {}


def tool(name: str, description: str, params: dict[str, str] | None = None, *, mutating: bool = False, min_role: str = "viewer",
         flag: str = "", summary: Callable[[dict[str, Any]], str] | None = None) -> Callable[[Callable[..., dict[str, Any]]], Callable[..., dict[str, Any]]]:
    def decorator(fn: Callable[..., dict[str, Any]]) -> Callable[..., dict[str, Any]]:
        REGISTRY[name] = Tool(name=name, description=description, params=params or {}, run=fn, mutating=mutating,
                              min_role=min_role, flag=flag, summary=summary or (lambda args: ""))
        return fn

    return decorator


def available(ctx: "AgentContext", caller: Caller) -> list[Tool]:
    """Tools this caller can use now (role and switches). The chat agent's action switch gates every changing tool."""
    out = []
    for t in REGISTRY.values():
        if not caller.has(t.min_role):
            continue
        if t.flag and not ctx.flag(t.flag):
            continue
        if t.mutating and caller.surface == "chat_agent" and not ctx.flag("console_chat_agent"):
            continue
        out.append(t)
    return out


def run(ctx: "AgentContext", name: str, args: dict[str, Any], caller: Caller) -> dict[str, Any]:
    """Run one tool with permission checks and an audit entry. Raises ToolError for anything a person can fix."""
    from . import audit

    t = REGISTRY.get(name)
    if t is None:
        raise ToolError(f"There is no tool named {name}.")
    denied = ""
    if not caller.has(t.min_role):
        denied = f"{name} needs the {t.min_role} role (you are {caller.role})."
    elif t.flag and not ctx.flag(t.flag):
        denied = f"{name} is switched off (Feature flags → {t.flag})."
    elif t.mutating and caller.surface == "chat_agent" and not ctx.flag("console_chat_agent"):
        denied = "The chat agent may only read and answer: actions are switched off (Feature flags → console_chat_agent)."
    if denied:
        audit.record(ctx, actor=caller.email, action=f"tool.{name}", surface=caller.surface, target_type="tool", target_id=name,  # type: ignore[arg-type]
                     summary=denied, status="denied", detail={"args": args})
        raise ToolError(denied)
    try:
        result = t.run(ctx, args or {}, caller)
    except ToolError as exc:
        audit.record(ctx, actor=caller.email, action=f"tool.{name}", surface=caller.surface, target_type="tool", target_id=name,  # type: ignore[arg-type]
                     summary=str(exc)[:300], status="error", detail={"args": args})
        raise
    except Exception as exc:  # noqa: BLE001 - reported to the caller as a tool failure
        log.exception("tool %s failed", name)
        audit.record(ctx, actor=caller.email, action=f"tool.{name}", surface=caller.surface, target_type="tool", target_id=name,  # type: ignore[arg-type]
                     summary=f"{type(exc).__name__}: {exc}"[:300], status="error", detail={"args": args})
        raise ToolError(f"{name} failed: {exc}") from exc
    case_id = result.get("case_id") if isinstance(result, dict) else None
    if t.mutating or name in ("search_knowledge",):
        audit.record(ctx, actor=caller.email, action=f"tool.{name}", surface=caller.surface, target_type="case" if case_id else "tool",  # type: ignore[arg-type]
                     target_id=str(case_id or name), summary=(t.summary(args) or str(result.get("summary") or name))[:300],
                     case_id=case_id, detail={"args": args})
    try:
        ctx.emit(PlatformEvent.AGENT_CHAT_TOOL, actor=caller.email, case_id=case_id, space="console" if caller.surface == "chat_agent" else None,
                 payload={"tool": name, "mutating": t.mutating, "surface": caller.surface})
    except Exception:  # noqa: BLE001
        log.warning("tool event failed", exc_info=True)
    return result


# -- helpers -----------------------------------------------------------------------------------------------------------
def _op(ctx: "AgentContext", op: str, payload: dict[str, Any], caller: Caller) -> dict[str, Any]:
    """Run an agent operation as the caller; chat outputs go to the outbox for the Studio flow, as from the Console."""
    from .operations import handle

    resp = handle({"op": op, "payload": payload, "context": {"deliver": "outbox", "invoked_by": caller.email, "flow": caller.surface}}, ctx)
    if not resp.ok:
        raise ToolError(resp.error or f"{op} failed")
    data = resp.data or {}
    if data.get("user_error"):
        raise ToolError(str(data["user_error"]))
    return {"summary": resp.outputs.get("summary") or "", "case_id": resp.outputs.get("case_id") or None,
            "escalation_id": resp.outputs.get("escalation_id") or None, "verdict": resp.outputs.get("verdict") or None,
            "reply": data.get("reply_text") or "", "queued_posts": len(data.get("queued_outbox_ids") or []),
            "held": data.get("held_outputs") or [], "data": {k: v for k, v in data.items() if k not in ("reply_text", "queued_outbox_ids")}}


def _case(ctx: "AgentContext", case_id: Any) -> Any:
    case = ctx.store.get_case(str(case_id or "").strip().upper())
    if case is None:
        raise ToolError(f"I don't know a case {case_id}.")
    return case


def case_brief(case: Any) -> dict[str, Any]:
    result = case.latest.result if case.latest else None
    a = result.assessment if result else None
    extra = (result.extra or {}) if result else {}
    return {
        "case_id": case.case_id, "status": case.status.value, "alert_name": case.alert_name, "issue": case.issue_name,
        "product": case.product, "exposure_tag": case.exposure_tag, "priority": case.priority, "track": case.track,
        "platform": case.platform, "source": case.source, "created_at": case.created_at.isoformat(),
        "verdict": result.verdict.value if result else None, "confidence": result.confidence if result else None,
        "sla_due_at": case.sla_due_at.isoformat() if case.sla_due_at else None, "sla_met": case.sla_met,
        "acknowledged": bool(case.acknowledged_at), "suggested_actions": a.suggested_actions if a else [],
        "classification": (extra.get("classification") or {}).get("label"),
        "actions_taken": [x.code for x in case.actions], "escalations": case.escalation_ids,
    }


# -- reading -----------------------------------------------------------------------------------------------------------
@tool("search_cases", "Find alerts (cases) by words, status or age.",
      {"query": "string?: words in the alert name, issue, product or id", "status": "string?: VERIFIED | NEEDS_REVIEW | FAILED | SUPPRESSED | CLOSED",
       "days": "integer?: how far back (default 7)", "limit": "integer?: at most (default 10)"})
def search_cases(ctx: "AgentContext", args: dict[str, Any], caller: Caller) -> dict[str, Any]:
    statuses = [CaseStatus(str(args["status"]).upper())] if args.get("status") else None
    since = ctx.now() - timedelta(days=int(args.get("days") or 7))
    q = str(args.get("query") or "").lower().strip()
    out = []
    for case in ctx.store.list_cases(statuses=statuses, since=since, limit=500):
        hay = " ".join(str(x or "") for x in (case.case_id, case.alert_name, case.issue_name, case.product, case.exposure_tag)).lower()
        if q and not all(word in hay for word in q.split()):
            continue
        out.append(case_brief(case))
        if len(out) >= int(args.get("limit") or 10):
            break
    return {"cases": out, "count": len(out)}


@tool("get_case", "Everything about one alert: fields, corrections, the agent's reasoning, citations, what was done.",
      {"case_id": "string: for example TRG-1042"})
def get_case(ctx: "AgentContext", args: dict[str, Any], caller: Caller) -> dict[str, Any]:
    case = _case(ctx, args.get("case_id"))
    result = case.latest.result if case.latest else None
    extra = (result.extra or {}) if result else {}
    return {
        **case_brief(case),
        "fields": {k: (v.isoformat() if hasattr(v, "isoformat") else v) for k, v in (result.normalized if result else {}).items()
                   if v not in (None, "", [])},
        "corrections": [{"field": c.field, "old": c.old, "new": c.new, "applied": c.applied, "confidence": c.confidence,
                         "reason": c.reason, "reverted_by": c.reverted_by} for c in (result.corrections if result else [])],
        "issues": [{"field": i.field, "rule": i.rule, "severity": i.severity.value, "fix": i.fix} for i in (result.issues if result else [])],
        "review_reasons": result.review_reasons if result else [],
        "field_confidence": extra.get("field_confidence") or {},
        "citations": [{"ref": c.get("ref"), "title": c.get("title")} for c in extra.get("citations") or []],
        "review": case.review.model_dump(mode="json") if case.review else None,
        "closed_reason": case.closed_reason, "superseded_by": case.superseded_by,
    }


@tool("review_queue", "Alerts waiting for an IM's decision, the longest-waiting first.")
def review_queue(ctx: "AgentContext", args: dict[str, Any], caller: Caller) -> dict[str, Any]:
    cases = ctx.store.list_cases(statuses=[CaseStatus.NEEDS_REVIEW], limit=200)
    cases.sort(key=lambda c: c.updated_at)
    return {"cases": [{**case_brief(c), "reasons": c.latest.result.review_reasons if c.latest else []} for c in cases[:25]],
            "count": len(cases)}


@tool("search_knowledge", "Search the team's knowledge docs, the Collection Requirements and past cases.",
      {"query": "string: what to look for"})
def search_knowledge(ctx: "AgentContext", args: dict[str, Any], caller: Caller) -> dict[str, Any]:
    from . import knowledge
    from .converse import answer as answer_mod

    query = str(args.get("query") or "").strip()
    if not query:
        raise ToolError("Give something to search for.")
    passages = knowledge.retrieve(ctx, query, include_cases=True, top_k=ctx.config.platform.chat_agent.retrieval_top_k or None,
                                  budget_chars=10000)
    playbook, sources = answer_mod.grounding(ctx, query)
    return {"passages": [{"ref": p.ref, "title": p.title, "kind": p.kind, "text": p.text[:1500], "score": p.score} for p in passages[:12]],
            "playbook": playbook[:6000], "playbook_sources": [s for s in sources if not s.startswith(("KD-", "Case "))]}


@tool("metrics", "The agent's numbers for a period: alerts, verdicts, corrections, SLA, emails.",
      {"hours": "integer?: the last N hours (default 24)"})
def metrics(ctx: "AgentContext", args: dict[str, Any], caller: Caller) -> dict[str, Any]:
    from .metrics import compute_kpis

    hours = max(1, min(24 * 90, int(args.get("hours") or 24)))
    events = ctx.events.query(since=ctx.now() - timedelta(hours=hours), env=ctx.config.env)
    out = compute_kpis(events, ctx.config)
    return {"hours": hours, "counts": out.get("kpis"), "derived": out.get("derived")}


@tool("who_is_on", "Who is on shift now, on the IM roster or the Burson on-call roster.",
      {"roster": "string?: slrr_im (default) or burson"})
def who_is_on(ctx: "AgentContext", args: dict[str, Any], caller: Caller) -> dict[str, Any]:
    from . import workforce

    name = "burson" if str(args.get("roster") or "").lower().startswith("b") else "slrr_im"
    res = ctx.on_call(name)
    staffed = workforce.staff_at(ctx.roster(name), ctx.now())
    return {"roster": name, "primary": res.person.name if res.person else None, "source": res.source,
            "until": res.until.isoformat() if res.until else None, "everyone_on": [p.name for p, _ in staffed]}


@tool("chat_activity", "What was said and posted in Chat about a case or in a space.",
      {"case_id": "string?: a case id", "space": "string?: a space key such as clean, burson, team", "limit": "integer?: at most (default 20)"})
def chat_activity(ctx: "AgentContext", args: dict[str, Any], caller: Caller) -> dict[str, Any]:
    from . import chatlog

    items = chatlog.search(ctx, case_id=(str(args["case_id"]).upper() if args.get("case_id") else None),
                           space_key=args.get("space") or None, limit=int(args.get("limit") or 20))
    return {"activity": [{"ts": a.ts.isoformat(), "direction": a.direction, "kind": a.kind, "space": a.space_key, "actor": a.actor,
                          "text": a.text[:500], "emoji": a.emoji, "status": a.status} for a in items]}


@tool("list_escalations", "Email drafts and Trust & Safety forms for a case, or everything still open.",
      {"case_id": "string?: a case id (default: everything open)"})
def list_escalations(ctx: "AgentContext", args: dict[str, Any], caller: Caller) -> dict[str, Any]:
    case_id = str(args.get("case_id") or "").upper() or None
    escs = ctx.store.list_escalations(case_id=case_id, open_only=case_id is None, limit=50)
    return {"escalations": [{"escalation_id": e.escalation_id, "case_id": e.case_id, "analyst": e.analyst_email,
                             "emails": [{"purpose": m.purpose, "status": m.status.value, "version": len(m.versions)} for m in e.emails],
                             "tns": e.tns.status.value if e.tns else None} for e in escs]}


@tool("workforce_now", "Who is on shift, the open load, and how live volume compares with the forecast.")
def workforce_now(ctx: "AgentContext", args: dict[str, Any], caller: Caller) -> dict[str, Any]:
    from . import workforce

    intraday = workforce.intraday(ctx, hours_back=3, hours_ahead=6)
    return {"actuals": workforce.actuals(ctx), "gap_alerts": intraday["gap_alerts"], "next_hours": intraday["hours"][3:],
            "pending_recommendations": [r.model_dump(mode="json") for r in workforce.list_recommendations(ctx, status="pending")[:5]]}


@tool("list_temp_checks", "Recent temp checks, or the ones for a case.", {"case_id": "string?: a case id"}, flag="temp_checks")
def list_temp_checks(ctx: "AgentContext", args: dict[str, Any], caller: Caller) -> dict[str, Any]:
    from . import tempcheck

    checks = tempcheck.list_checks(ctx, case_id=(str(args["case_id"]).upper() if args.get("case_id") else None), limit=15)
    return {"temp_checks": [{"check_id": c.check_id, "issue": c.issue, "status": c.status, "total": c.total, "concern": c.concern_level,
                             "created_at": c.created_at.isoformat(), "basis": c.basis} for c in checks]}


@tool("get_temp_check", "One temp check's write-up and numbers.", {"check_id": "string: for example TC-1a2b3c4d5e"}, flag="temp_checks")
def get_temp_check(ctx: "AgentContext", args: dict[str, Any], caller: Caller) -> dict[str, Any]:
    from . import tempcheck

    check = tempcheck.get(ctx, str(args.get("check_id") or ""))
    if check is None:
        raise ToolError("I don't know that temp check.")
    return {"check_id": check.check_id, "status": check.status, "issue": check.issue, "total": check.total, "concern": check.concern_level,
            "writeup": check.writeup_text, "notes": check.notes, "error": check.error}


# -- acting ------------------------------------------------------------------------------------------------------------
@tool("triage_alert", "Put an alert through triage as if it had arrived: paste the alert's text.",
      {"text": "string: the alert as posted"}, mutating=True, min_role="analyst", summary=lambda a: "Triaged a pasted alert")
def triage_alert(ctx: "AgentContext", args: dict[str, Any], caller: Caller) -> dict[str, Any]:
    text = str(args.get("text") or "").strip()
    if not text:
        raise ToolError("Paste the alert's text.")
    space = ctx.config.space("burson")
    msg_id = f"console-{uuid.uuid4().hex[:12]}"
    payload = {"message": {"message_id": msg_id, "text": text, "sender": {"email": caller.email, "name": "Console", "type": "HUMAN"},
                           "space_id": space.space_id if space and space.space_id else "spaces/console",
                           "space_name": space.display_name if space else "console", "thread_id": f"thread-{msg_id}",
                           "conversation_type": "SPACE"}}
    out = _op(ctx, "triage_message", payload, caller)
    if not out["case_id"]:
        raise ToolError("That text was not read as an alert (no case was made).")
    return {**out, "case": case_brief(_case(ctx, out["case_id"]))}


@tool("review_decision", "Decide an alert held for review: forward it (optionally setting fields), bounce it, or suppress it.",
      {"case_id": "string", "decision": "string: forward | bounce | suppress", "reason": "string?: why (needed to bounce or suppress)",
       "fields": "object?: field name -> the right value, applied when forwarding"},
      mutating=True, min_role="analyst", summary=lambda a: f"{a.get('decision')} {a.get('case_id')}")
def review_decision(ctx: "AgentContext", args: dict[str, Any], caller: Caller) -> dict[str, Any]:
    decision = str(args.get("decision") or "").lower()
    if decision not in ("forward", "bounce", "suppress"):
        raise ToolError("The decision is forward, bounce or suppress.")
    case = _case(ctx, args.get("case_id"))
    return _op(ctx, "review_decision", {"case_id": case.case_id, "decision": decision, "reason": args.get("reason") or None,
                                        "fields": args.get("fields") or None, "actor": caller.email, "via": "console"}, caller)


@tool("revert_correction", "Undo one correction the agent applied to an alert.", {"case_id": "string", "field": "string: the field name"},
      mutating=True, min_role="analyst", summary=lambda a: f"Reverted {a.get('field')} on {a.get('case_id')}")
def revert_correction(ctx: "AgentContext", args: dict[str, Any], caller: Caller) -> dict[str, Any]:
    case = _case(ctx, args.get("case_id"))
    return _op(ctx, "revert_correction", {"case_id": case.case_id, "field": str(args.get("field") or ""), "actor": caller.email}, caller)


@tool("take_action", "Do what an emoji reaction does on an alert: acknowledge, draft the Social Alert email, prepare the "
      "Trust & Safety form, add a team to the draft, post to the crisis chat, close, mark superseded, or flag the agent's call as wrong. "
      "Drafts land in the caller's own Gmail.",
      {"case_id": "string", "action": "string: an action code from the legend (see the list in your instructions)"},
      mutating=True, min_role="analyst", summary=lambda a: f"{a.get('action')} on {a.get('case_id')}")
def take_action(ctx: "AgentContext", args: dict[str, Any], caller: Caller) -> dict[str, Any]:
    case = _case(ctx, args.get("case_id"))
    action = ctx.config.action(str(args.get("action") or ""))
    if action is None:
        raise ToolError("Unknown action. Use one of: " + ", ".join(a.code for a in ctx.config.actions))
    clean = ctx.config.space("clean")
    return _op(ctx, "record_reaction", {
        "emoji": action.emoji, "reactor_email": caller.email, "reactor_name": caller.email.split("@")[0],
        "message_text": f"[{case.case_id}]", "message_id": case.clean_message_ref or f"console-{case.case_id}",
        "space": clean.display_name if clean else "clean"}, caller)


@tool("close_case", "Close an alert with a reason.", {"case_id": "string", "reason": "string"}, mutating=True, min_role="analyst",
      summary=lambda a: f"Closed {a.get('case_id')}")
def close_case(ctx: "AgentContext", args: dict[str, Any], caller: Caller) -> dict[str, Any]:
    case = _case(ctx, args.get("case_id"))
    reason = str(args.get("reason") or "").strip()
    if not reason:
        raise ToolError("Give a reason.")
    return _op(ctx, "close_case", {"case_id": case.case_id, "reason": reason, "actor": caller.email}, caller)


@tool("record_assessment", "Record your own judgment of an alert for the golden set: agree, or say what is right.",
      {"case_id": "string", "agree": "boolean", "verdict": "string?: the right verdict when you disagree",
       "fields": "object?: field name -> the right value", "note": "string?"},
      mutating=True, min_role="analyst", summary=lambda a: f"Assessment on {a.get('case_id')}: {'agree' if a.get('agree') else 'disagree'}")
def record_assessment(ctx: "AgentContext", args: dict[str, Any], caller: Caller) -> dict[str, Any]:
    case = _case(ctx, args.get("case_id"))
    return _op(ctx, "record_assessment", {"case_id": case.case_id, "agree": bool(args.get("agree")), "verdict": args.get("verdict") or None,
                                          "fields": args.get("fields") or {}, "note": args.get("note") or "", "actor": caller.email}, caller)


@tool("run_temp_check", "Run a temp check on an issue: by a case, a Brandwatch query (name, id or link) or a Boolean. "
      "With none of those, a query is drafted from the issue.",
      {"issue": "string?: the issue's name", "case_id": "string?: the alert it is about", "query": "string?: a Brandwatch query's name, id or link",
       "boolean": "string?: a Brandwatch Boolean", "update_of": "string?: an earlier temp check to refresh"},
      mutating=True, min_role="analyst", flag="temp_checks", summary=lambda a: f"Temp check: {a.get('issue') or a.get('case_id') or a.get('query') or ''}")
def run_temp_check(ctx: "AgentContext", args: dict[str, Any], caller: Caller) -> dict[str, Any]:
    if not any(args.get(k) for k in ("issue", "case_id", "query", "boolean", "update_of")):
        raise ToolError("Name the issue, or give a case, a Brandwatch query or a Boolean.")
    out = _op(ctx, "run_temp_check", {
        "issue": args.get("issue") or "", "case_id": (str(args["case_id"]).upper() if args.get("case_id") else None),
        "query_ref": args.get("query") or "", "boolean": args.get("boolean") or "", "update_of": args.get("update_of") or None,
        "draft_query": not (args.get("query") or args.get("boolean") or args.get("update_of")), "actor": caller.email,
        "via": caller.surface, "silent": True}, caller)
    return {"check_id": out["data"].get("check_id"), "status": out["data"].get("status"), "concern": out["data"].get("concern"),
            "summary": out["reply"] or out["summary"], "case_id": out["case_id"]}


@tool("chat_command", "Run anything the agent understands in Chat, as you: for example `revise ESC-1207: shorter`, `submitted ESC-1207`, "
      "`bug ESC-1207 b/123`, `handover`, `I'm on until 6pm ET`, `hand off to <email>`, `remember that …`, `approve PROP-12`.",
      {"text": "string: the command, as you would type it to the agent"}, mutating=True, min_role="analyst",
      summary=lambda a: f"Chat command: {str(a.get('text') or '')[:120]}")
def chat_command(ctx: "AgentContext", args: dict[str, Any], caller: Caller) -> dict[str, Any]:
    text = str(args.get("text") or "").strip()
    if not text:
        raise ToolError("Give the command.")
    msg_id = f"console-{uuid.uuid4().hex[:12]}"
    out = _op(ctx, "converse", {"message": {"message_id": msg_id, "text": text, "sender": {"email": caller.email, "type": "HUMAN"},
                                             "conversation_type": "DM", "thread_id": f"thread-{msg_id}"}}, caller)
    return {**out, "answer": out["reply"]}
