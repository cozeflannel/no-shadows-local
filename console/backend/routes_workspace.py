"""Console API for the alert workspace: one alert, worked in one place.

    GET  /api/workspace/{case_id}              everything the workspace shows: the alert, its brief, the email, the Trust &
                                               Safety form, its temp checks, its QA evaluations and its timeline
    POST /api/workspace/{case_id}/brief        have Gemini word the brief (kept until the alert changes)
    PUT  /api/workspace/{case_id}/email        keep the edited email and write it to the draft in the analyst's Gmail
    POST /api/workspace/{case_id}/email/send   send that email from the analyst's Gmail (only with the switch "Send alert
                                               emails from the Console" on; Testing recipients only while Testing is on)
    POST /api/workspace/{case_id}/email/reset  drop the edit: the email as the template writes it from the alert
    POST /api/workspace/{case_id}/tns          prepare the form, or mark it submitted or discarded
    POST /api/temp-checks/{id}/share           send a temp check to the analysts' space
    POST /api/temp-checks/{id}/revise          have Gemini reword a temp check's written lines
    GET  /api/qa-evals, /rubric, /subject      the QA evaluations report, the form, and one alert's evaluations
    POST /api/qa-evals                         submit a QA evaluation (one person an alert; its owner revises it)

Nothing here posts in a live space, and an email is sent only by the analyst: from Gmail, or from the composer when that
switch is on (under the same Testing and recipient rules as every draft). The Trust & Safety form is submitted by the
analyst in the form itself, and a shared temp check is queued like any other post (Routing and Safety decide whether it
goes out).
"""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from triage_agent import qa_evals, tempcheck, workspace
from triage_agent.context import AgentContext
from triage_agent.models import Case
from triage_agent.operations import UserFacingError

from .auth import User, get_ctx, require_analyst, require_viewer
from .live import feed_card
from .routes_cases import _case_events
from .routes_work import _check_brief
from .serializers import event_json

router = APIRouter(prefix="/api", tags=["workspace"])


def _case(ctx: AgentContext, case_id: str) -> Case:
    case = ctx.store.get_case(case_id.upper())
    if case is None:
        raise HTTPException(404, {"error": f"Unknown case {case_id}", "code": "not_found"})
    return case


def _said(exc: Exception, status: int = 400) -> HTTPException:
    return HTTPException(status, {"error": str(exc), "code": "rejected"})


def _temp(ctx: AgentContext, case: Case) -> dict[str, Any]:
    return {"enabled": ctx.flag("temp_checks"), "auto": ctx.flag("auto_temp_checks"),
            "docs": bool(ctx.config.platform.temp_check.docs_folder_id),
            "checks": [_check_brief(c) | {"doc_url": c.doc_url} for c in tempcheck.list_checks(ctx, case_id=case.case_id, limit=20)]}


def _view(ctx: AgentContext, case: Case, user: User) -> dict[str, Any]:
    escalations = ctx.store.list_escalations(case_id=case.case_id, limit=100)
    esc_ids = list(dict.fromkeys(case.escalation_ids + [e.escalation_id for e in escalations]))
    return {
        "card": feed_card(ctx, case, detail=True),
        "brief": workspace.brief(ctx, case),
        "email": workspace.email_state(ctx, case, user.email),
        "tns": workspace.tns_view(ctx, case, user.email),
        "temp": _temp(ctx, case),
        "qa": {"rubric": qa_evals.rubric("case"), "evals": qa_evals.for_subject(ctx, "case", case.case_id),
               "standing": qa_evals.standing(ctx, "case", case.case_id, user.email)},
        "events": [event_json(e) for e in _case_events(ctx, case, esc_ids)][-60:],
        "legend": [x.model_dump(mode="json") for x in ctx.config.actions],
        "verdicts": ["PASS", "CORRECTED", "NEEDS_REVIEW", "SUPPRESSED", "FAIL"],
        "can_act": user.has("analyst"),
    }


@router.get("/workspace/{case_id}")
def workspace_get(case_id: str, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_viewer)) -> dict[str, Any]:
    return _view(ctx, _case(ctx, case_id), user)


class BriefBody(BaseModel):
    refresh: bool = False


@router.post("/workspace/{case_id}/brief")
def workspace_brief(case_id: str, body: BriefBody, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_viewer)) -> dict[str, Any]:
    return workspace.brief(ctx, _case(ctx, case_id), write=True, refresh=body.refresh)


class EmailBody(BaseModel):
    subject: str = Field(..., max_length=400)
    to: list[str] = Field(default_factory=list, max_length=300)
    cc: list[str] = Field(default_factory=list, max_length=300)
    bcc: list[str] = Field(default_factory=list, max_length=300)
    html: str = Field(..., min_length=1, max_length=workspace.alert_html.MAX_HTML)


@router.put("/workspace/{case_id}/email")
def workspace_email(case_id: str, body: EmailBody, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_analyst)) -> dict[str, Any]:
    case = _case(ctx, case_id)
    try:
        email = workspace.save_email(ctx, case, user.email, subject=body.subject, to=body.to, cc=body.cc, bcc=body.bcc, html=body.html)
    except UserFacingError as exc:
        raise _said(exc, 409) from exc
    ctx.audit(actor=user.email, action="workspace.email", surface="console", target_type="case", target_id=case.case_id, case_id=case.case_id,
              summary=f"Wrote the Social Alert draft for {case.case_id} to Gmail", detail={"to": len(body.to), "cc": len(body.cc), "bcc": len(body.bcc)})
    return {"ok": True, "email": email}


@router.post("/workspace/{case_id}/email/send")
def workspace_email_send(case_id: str, body: EmailBody, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_analyst)) -> dict[str, Any]:
    """Sends the email as the composer holds it, from the analyst's own Gmail (switch: Send alert emails from the Console).
    While Testing is on it goes to the Testing recipients only. workspace.send_email records who sent it."""
    case = _case(ctx, case_id)
    try:
        email = workspace.send_email(ctx, case, user.email, subject=body.subject, to=body.to, cc=body.cc, bcc=body.bcc, html=body.html)
    except UserFacingError as exc:
        raise _said(exc, 409) from exc
    return {"ok": True, "email": email}


@router.post("/workspace/{case_id}/email/reset")
def workspace_email_reset(case_id: str, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_analyst)) -> dict[str, Any]:
    return {"ok": True, "email": workspace.reset_email(ctx, _case(ctx, case_id), user.email)}


class TnsBody(BaseModel):
    action: Literal["prepare", "submitted", "discard"]


@router.post("/workspace/{case_id}/tns")
def workspace_tns(case_id: str, body: TnsBody, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_analyst)) -> dict[str, Any]:
    case = _case(ctx, case_id)
    try:
        view = workspace.tns_prepare(ctx, case, user.email) if body.action == "prepare" else workspace.tns_mark(ctx, case, user.email, body.action)
    except UserFacingError as exc:
        raise _said(exc, 409) from exc
    ctx.audit(actor=user.email, action=f"workspace.tns.{body.action}", surface="console", target_type="case", target_id=case.case_id,
              case_id=case.case_id, summary=f"Trust & Safety form for {case.case_id}: {body.action}")
    return {"ok": True, "tns": view}


# -- temp checks ---------------------------------------------------------------------------------------------------------
class ReviseBody(BaseModel):
    instruction: str = Field(..., min_length=1, max_length=1000)


@router.post("/temp-checks/{check_id}/share")
def temp_check_share(check_id: str, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_analyst)) -> dict[str, Any]:
    try:
        out = workspace.share_temp_check(ctx, check_id, user.email)
    except KeyError as exc:
        raise HTTPException(404, {"error": "Unknown temp check", "code": "not_found"}) from exc
    except UserFacingError as exc:
        raise _said(exc, 409) from exc
    return {"ok": True, "outbox_id": out["outbox_id"], "text": out["text"], "check": out["check"].model_dump(mode="json")}


@router.post("/temp-checks/{check_id}/revise")
def temp_check_revise(check_id: str, body: ReviseBody, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_analyst)) -> dict[str, Any]:
    try:
        out = workspace.revise_temp_check(ctx, check_id, body.instruction, user.email)
    except KeyError as exc:
        raise HTTPException(404, {"error": "Unknown temp check", "code": "not_found"}) from exc
    except UserFacingError as exc:
        raise _said(exc, 409) from exc
    return {"ok": True, "changed": out["changed"], "check": out["check"].model_dump(mode="json")}


# -- QA evaluations ------------------------------------------------------------------------------------------------------
class EvalBody(BaseModel):
    subject_type: Literal["case", "agent_alert"]
    subject_id: str = Field(..., min_length=1, max_length=200)
    ratings: dict[str, int | None]
    comment: str = Field("", max_length=2000)
    verdict: str | None = Field(None, max_length=20)  # what the agent's call should have been (an alert's review)
    fields: dict[str, Any] = Field(default_factory=dict)  # field -> the value that is right


@router.get("/qa-evals/rubric")
def qa_rubric(subject_type: Literal["case", "agent_alert"] = "case", user: User = Depends(require_viewer)) -> dict[str, Any]:
    return qa_evals.rubric(subject_type)


@router.get("/qa-evals/subject")
def qa_subject(subject_id: str, subject_type: Literal["case", "agent_alert"] = "case", ctx: AgentContext = Depends(get_ctx),
               user: User = Depends(require_viewer)) -> dict[str, Any]:
    key = subject_id.upper() if subject_type == "case" else subject_id
    return {"rubric": qa_evals.rubric(subject_type), "evals": qa_evals.for_subject(ctx, subject_type, key),
            "standing": qa_evals.standing(ctx, subject_type, key, user.email)}


@router.get("/qa-evals")
def qa_report(days: int = Query(30, ge=1, le=365), subject_type: Literal["", "case", "agent_alert"] = "",
              ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_viewer)) -> dict[str, Any]:
    return qa_evals.report(ctx, days, subject_type)


@router.post("/qa-evals")
def qa_submit(body: EvalBody, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_analyst)) -> dict[str, Any]:
    unknown = [k for k in body.fields if ctx.config.alert_template.field(k) is None]
    if unknown:
        raise HTTPException(422, {"error": f"Unknown alert field(s): {', '.join(unknown)}", "code": "validation_error"})
    corrections = {k: v for k, v in (("verdict", body.verdict), ("fields", body.fields)) if v}
    try:
        record = qa_evals.submit(ctx, subject_type=body.subject_type, subject_id=body.subject_id, evaluator=user.email,
                                 ratings=body.ratings, comment=body.comment, corrections=corrections)
    except KeyError as exc:
        raise HTTPException(404, {"error": "That alert is no longer kept.", "code": "not_found"}) from exc
    except qa_evals.Taken as exc:  # one person evaluates an alert
        raise _said(exc, 409) from exc
    except UserFacingError as exc:
        raise _said(exc, 422) from exc
    return {"ok": True, "eval": record}
