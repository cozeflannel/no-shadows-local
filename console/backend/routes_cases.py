"""Case-centric endpoints: activity, cases, suppressed, review queue, reverts/closing, parity,
escalations and outbox (docs/CONTRACTS.md §17)."""

from __future__ import annotations

from collections import Counter, defaultdict
from datetime import timedelta
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field

from triage_agent.context import AgentContext
from triage_agent.events import EventType as E
from triage_agent.metrics import window
from triage_agent.models import AgentEvent, Case, CaseStatus, ChatMessage

from .auth import User, get_ctx, require_analyst, require_viewer
from .ops import op_available, run_op
from .routes_metrics import env_filter
from .serializers import case_summary, escalation_json, event_json

router = APIRouter(prefix="/api", tags=["cases"])

OPEN_STATUSES = {CaseStatus.VERIFIED, CaseStatus.FAILED, CaseStatus.NEEDS_REVIEW}
PARITY_MATCH_WINDOW = timedelta(hours=2)


def _not_found(what: str) -> HTTPException:
    return HTTPException(404, {"error": f"{what} not found", "code": "not_found"})


def _get_case(ctx: AgentContext, case_id: str) -> Case:
    case = ctx.store.get_case(case_id.strip().upper())
    if case is None:
        raise _not_found(f"Case {case_id}")
    return case


def resolve_event_types(spec: str | None) -> list[str] | None:
    """`type` filter: exact types, prefixes (`triage.` / `triage.*` / `triage`), comma-separated."""
    if not spec:
        return None
    known = E.all()
    out: list[str] = []
    for token in (t.strip() for t in spec.split(",")):
        if not token:
            continue
        if token in known:
            matches = [token]
        else:
            prefix = token.rstrip("*")
            prefix = prefix if prefix.endswith(".") else prefix + "."
            matches = [t for t in known if t.startswith(prefix)]
        if not matches:
            raise HTTPException(422, {"error": f"Unknown event type: {token}", "code": "validation_error"})
        out.extend(m for m in matches if m not in out)
    return out


# ---------------------------------------------------------------------------
# Activity
# ---------------------------------------------------------------------------


@router.get("/activity")
def get_activity(
    limit: int = Query(200, ge=1, le=2000),
    type: str | None = Query(None, description="Event type(s) or prefixes, comma-separated"),
    case_id: str | None = None,
    escalation_id: str | None = None,
    actor: str | None = None,
    days: int | None = Query(None, ge=1, le=180),
    env: str | None = None,
    ctx: AgentContext = Depends(get_ctx),
    user: User = Depends(require_viewer),
) -> dict[str, Any]:
    types = resolve_event_types(type)
    since = ctx.now() - timedelta(days=days) if days else None
    actor_q = (actor or "").strip().lower()
    events = ctx.events.query(
        since=since,
        types=types,
        case_id=case_id.strip().upper() if case_id else None,
        escalation_id=escalation_id.strip().upper() if escalation_id else None,
        env=env_filter(ctx, env),
        limit=min(limit * 10, 20000) if actor_q else limit,
    )
    if actor_q:
        events = [e for e in events if actor_q in (e.actor or "").lower()][:limit]
    return {"events": [event_json(e) for e in events], "count": len(events), "limit": limit}


# ---------------------------------------------------------------------------
# Cases
# ---------------------------------------------------------------------------


def _parse_statuses(status: str | None) -> list[CaseStatus]:
    if not status:
        return []
    out = []
    for token in (s.strip().upper() for s in status.split(",") if s.strip()):
        try:
            out.append(CaseStatus(token))
        except ValueError as exc:
            raise HTTPException(422, {"error": f"Unknown status: {token}", "code": "validation_error"}) from exc
    return out


def _matches_query(case: Case, q: str) -> bool:
    hay = " ".join(
        str(v or "")
        for v in (case.case_id, case.alert_name, case.record_key, case.product, case.exposure_tag, case.issue_name,
                  case.source_ref, case.counterpart_case_id, " ".join(case.escalation_ids))
    ).lower()
    return all(part in hay for part in q.lower().split())


@router.get("/cases")
def list_cases(
    status: str | None = Query(None, description="Comma-separated CaseStatus values"),
    source: str | None = Query(None, description="Comma-separated sources"),
    track: str | None = None,
    priority: str | None = None,
    q: str | None = None,
    days: int | None = Query(None, ge=1, le=365),
    limit: int = Query(200, ge=1, le=5000),
    ctx: AgentContext = Depends(get_ctx),
    user: User = Depends(require_viewer),
) -> dict[str, Any]:
    statuses = _parse_statuses(status)
    sources = [s.strip() for s in (source or "").split(",") if s.strip()]
    since = ctx.now() - timedelta(days=days) if days else None
    post_filter = bool(track or priority or q or len(sources) > 1)
    cases = ctx.store.list_cases(
        statuses=statuses or None,
        since=since,
        limit=100000 if post_filter else limit,
        source=sources[0] if len(sources) == 1 else None,
    )
    if len(sources) > 1:
        cases = [c for c in cases if c.source in sources]
    if track:
        wanted = {t.strip().upper() for t in track.split(",")}
        cases = [c for c in cases if (c.track or "NONE").upper() in wanted]
    if priority:
        wanted = {p.strip().upper() for p in priority.split(",")}
        cases = [c for c in cases if (c.priority or "").upper() in wanted]
    if q and q.strip():
        cases = [c for c in cases if _matches_query(c, q.strip())]
    cases.sort(key=lambda c: c.created_at, reverse=True)
    total = len(cases)
    return {"cases": [case_summary(c) for c in cases[:limit]], "total": total, "limit": limit}


def _case_events(ctx: AgentContext, case: Case, escalation_ids: list[str]) -> list[AgentEvent]:
    events = {e.event_id: e for e in ctx.events.query(case_id=case.case_id, limit=2000)}
    for esc_id in escalation_ids:
        for e in ctx.events.query(escalation_id=esc_id, limit=1000):
            events.setdefault(e.event_id, e)
    return sorted(events.values(), key=lambda e: e.event_ts)


def _summary_or_none(ctx: AgentContext, case_id: str | None) -> dict[str, Any] | None:
    if not case_id:
        return None
    other = ctx.store.get_case(case_id)
    return case_summary(other) if other else {"case_id": case_id, "missing": True}


@router.get("/cases/{case_id}")
def get_case(case_id: str, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_viewer)) -> dict[str, Any]:
    case = _get_case(ctx, case_id)
    escalations = ctx.store.list_escalations(case_id=case.case_id, limit=100)
    esc_ids = list(dict.fromkeys(case.escalation_ids + [e.escalation_id for e in escalations]))
    events = _case_events(ctx, case, esc_ids)
    latest = case.latest
    a = latest.result.assessment if latest else None
    revertible = (
        [c.field for c in latest.result.corrections if c.applied and not c.reverted_by] if latest else []
    )
    return {
        "case": case.model_dump(mode="json"),
        "summary": case_summary(case),
        "events": [event_json(e) for e in events],
        "escalations": [escalation_json(e, case) for e in escalations],
        "counterpart": _summary_or_none(ctx, case.counterpart_case_id),
        "related": _summary_or_none(ctx, a.related_case_id if a else None),
        "superseded_by_case": _summary_or_none(ctx, case.superseded_by),
        "revertible_fields": revertible,
        "can_close": case.status in OPEN_STATUSES,
        "operations": {op: op_available(op) for op in ("review_decision", "revert_correction", "close_case")},
    }


# ---------------------------------------------------------------------------
# Suppressed
# ---------------------------------------------------------------------------


@router.get("/suppressed")
def get_suppressed(
    days: int = Query(7, ge=1, le=180),
    env: str | None = None,
    ctx: AgentContext = Depends(get_ctx),
    user: User = Depends(require_viewer),
) -> dict[str, Any]:
    since, until = window(days, now=ctx.now())
    rows = []
    for c in ctx.store.list_cases(statuses=[CaseStatus.SUPPRESSED], since=since, limit=100000):
        s = case_summary(c)
        reviewed = bool(c.review and c.review.decision == "suppress")
        s["reason"] = ("im_review" if reviewed else s["suppression_reason"]) or "unspecified"
        s["suppressed_by"] = c.review.decided_by if reviewed and c.review else "agent"
        s["review_reason"] = c.review.reason if reviewed and c.review else None
        rows.append(s)
    rows.sort(key=lambda r: r["received_at"], reverse=True)
    reasons = Counter(r["reason"] for r in rows)
    events = ctx.events.query(since=since, until=until, types=[E.TRIAGE_SUPPRESSED, E.REVIEW_SUPPRESSED], env=env_filter(ctx, env))
    event_reasons = Counter(str((e.payload or {}).get("reason") or "unspecified") for e in events if e.event_type == E.TRIAGE_SUPPRESSED)
    return {
        "window": {"days": days, "since": since, "until": until},
        "cases": rows,
        "reasons": [{"reason": k, "count": v} for k, v in reasons.most_common()],
        "event_reasons": [{"reason": k, "count": v} for k, v in event_reasons.most_common()],
        "review_suppressed": sum(1 for e in events if e.event_type == E.REVIEW_SUPPRESSED),
    }


# ---------------------------------------------------------------------------
# Review queue
# ---------------------------------------------------------------------------


class ReviewDecisionBody(BaseModel):
    decision: Literal["forward", "bounce", "suppress"]
    reason: str | None = Field(None, max_length=2000)
    fields: dict[str, Any] | None = None


@router.get("/review-queue")
def get_review_queue(ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_viewer)) -> dict[str, Any]:
    now = ctx.now()
    rows = []
    for c in ctx.store.list_cases(statuses=[CaseStatus.NEEDS_REVIEW], limit=1000):
        s = case_summary(c)
        latest = c.latest
        if latest:
            s["proposed_corrections"] = [x.model_dump(mode="json") for x in latest.result.corrections if not x.applied]
            s["applied_corrections"] = [x.model_dump(mode="json") for x in latest.result.applied_corrections]
            s["issue_list"] = [i.model_dump(mode="json") for i in latest.result.issues]
            s["normalized"] = latest.result.normalized
            s["waiting_min"] = round((now - latest.received_at).total_seconds() / 60, 1)
        rows.append(s)
    rows.sort(key=lambda r: r.get("waiting_min") or 0, reverse=True)
    im = ctx.im_on_shift()
    return {
        "cases": rows,
        "im_on_shift": im.model_dump(mode="json"),
        "op_available": op_available("review_decision"),
        "review_reminder_min": ctx.config.thresholds.review_reminder_min,
    }


@router.post("/review-queue/{case_id}")
def post_review_decision(
    case_id: str,
    body: ReviewDecisionBody,
    ctx: AgentContext = Depends(get_ctx),
    user: User = Depends(require_analyst),
) -> dict[str, Any]:
    case = _get_case(ctx, case_id)
    if case.status != CaseStatus.NEEDS_REVIEW:
        raise HTTPException(409, {"error": f"{case.case_id} is {case.status.value}, not waiting for review", "code": "conflict"})
    fields = {k: v for k, v in (body.fields or {}).items() if k}
    unknown = [k for k in fields if ctx.config.alert_template.field(k) is None]
    if unknown:
        raise HTTPException(422, {"error": f"Unknown alert field(s): {', '.join(unknown)}", "code": "validation_error"})
    if fields and body.decision != "forward":
        raise HTTPException(422, {"error": "Field overrides only apply when forwarding", "code": "validation_error"})
    payload = {
        "case_id": case.case_id,
        "decision": body.decision,
        "reason": (body.reason or "").strip() or None,
        "fields": fields,
        "actor": user.email,
        "via": "console",
    }
    result = run_op(ctx, "review_decision", payload, user)
    updated = ctx.store.get_case(case.case_id)
    return {**result, "case": case_summary(updated) if updated else None}


# ---------------------------------------------------------------------------
# Reverts + closing
# ---------------------------------------------------------------------------


class RevertBody(BaseModel):
    field: str = Field(..., min_length=1, max_length=100)


class CloseBody(BaseModel):
    reason: str = Field(..., min_length=1, max_length=1000)


@router.post("/cases/{case_id}/revert")
def post_revert(case_id: str, body: RevertBody, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_analyst)) -> dict[str, Any]:
    case = _get_case(ctx, case_id)
    latest = case.latest
    applied = [c for c in (latest.result.corrections if latest else []) if c.applied and not c.reverted_by]
    if not any(c.field == body.field for c in applied):
        raise HTTPException(409, {"error": f"{case.case_id} has no applied correction on {body.field} to revert", "code": "conflict"})
    result = run_op(ctx, "revert_correction", {"case_id": case.case_id, "field": body.field, "actor": user.email}, user)
    updated = ctx.store.get_case(case.case_id)
    return {**result, "case": case_summary(updated) if updated else None}


@router.post("/cases/{case_id}/close")
def post_close(case_id: str, body: CloseBody, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_analyst)) -> dict[str, Any]:
    case = _get_case(ctx, case_id)
    if case.status not in OPEN_STATUSES:
        raise HTTPException(409, {"error": f"{case.case_id} is already {case.status.value}", "code": "conflict"})
    result = run_op(ctx, "close_case", {"case_id": case.case_id, "reason": body.reason.strip(), "actor": user.email}, user)
    updated = ctx.store.get_case(case.case_id)
    return {**result, "case": case_summary(updated) if updated else None}


# ---------------------------------------------------------------------------
# Parity (Path B in-house vs Burson)
# ---------------------------------------------------------------------------


def _diff_pairs(diffs: Any) -> list[tuple[str, Any, Any]]:
    """parity.matched diffs as (field, burson, inhouse): `{field: [burson, inhouse]}` (CONTRACTS §15)."""
    out = []
    for field, vals in (diffs or {}).items():
        if isinstance(vals, (list, tuple)) and len(vals) == 2:
            out.append((field, vals[0], vals[1]))
        elif isinstance(vals, dict):
            out.append((field, vals.get("burson"), vals.get("inhouse")))
        else:
            out.append((field, vals, None))
    return out


def _oriented_diffs(diffs: Any) -> list[dict[str, Any]]:
    return [{"field": f, "burson": b, "inhouse": i} for f, b, i in _diff_pairs(diffs)]


@router.get("/parity")
def get_parity(
    days: int = Query(14, ge=1, le=180),
    env: str | None = None,
    ctx: AgentContext = Depends(get_ctx),
    user: User = Depends(require_viewer),
) -> dict[str, Any]:
    now = ctx.now()
    since, until = window(days, now=now)
    events = ctx.events.query(since=since, until=until, types=[E.PARITY_MATCHED, E.PARITY_UNMATCHED], env=env_filter(ctx, env))
    cache: dict[str, Case | None] = {}

    def get(cid: str | None) -> Case | None:
        if not cid:
            return None
        if cid not in cache:
            cache[cid] = ctx.store.get_case(cid)
        return cache[cid]

    matched: list[dict] = []
    burson_only: list[dict] = []
    inhouse_only: list[dict] = []
    field_counts: Counter[str] = Counter()
    examples: dict[str, list[dict]] = defaultdict(list)
    seen_pairs: set[tuple[str, str]] = set()
    reconciled: set[str] = set()
    for e in sorted(events, key=lambda ev: ev.event_ts):
        p = e.payload or {}
        if e.event_type == E.PARITY_MATCHED:
            a, b = get(e.case_id), get(p.get("counterpart_case_id"))
            ids = tuple(sorted(x for x in (e.case_id, p.get("counterpart_case_id")) if x))
            if ids in seen_pairs:
                continue
            seen_pairs.add(ids)  # type: ignore[arg-type]
            reconciled.update(ids)
            burson = next((c for c in (a, b) if c and c.source == "burson_chat"), None)
            inhouse = next((c for c in (a, b) if c and c.source == "inhouse"), None)
            diffs = _oriented_diffs(p.get("diffs"))
            for d in diffs:
                field_counts[d["field"]] += 1
                if len(examples[d["field"]]) < 5:
                    examples[d["field"]].append({
                        **d,
                        "burson_case_id": burson.case_id if burson else None,
                        "inhouse_case_id": inhouse.case_id if inhouse else None,
                    })
            matched.append({
                "matched_at": e.event_ts,
                "burson": case_summary(burson) if burson else None,
                "inhouse": case_summary(inhouse) if inhouse else None,
                "case_ids": list(ids),
                "diffs": diffs,
            })
        else:
            side = p.get("side")
            c = get(e.case_id)
            if e.case_id:
                reconciled.add(e.case_id)
            row = {"reconciled_at": e.event_ts, "side": side, "case": case_summary(c) if c else {"case_id": e.case_id, "missing": True}}
            (burson_only if side == "burson_only" else inhouse_only).append(row)

    # Alerts still inside the match window (reconciliation hasn't run for them yet).
    pending = []
    for c in ctx.store.list_cases(since=now - PARITY_MATCH_WINDOW - timedelta(hours=1), limit=100000):
        if (c.source in ("burson_chat", "inhouse") and not c.counterpart_case_id and c.case_id not in reconciled
                and c.created_at >= now - PARITY_MATCH_WINDOW and c.status != CaseStatus.SUPPRESSED):
            pending.append(case_summary(c))

    n_matched, n_b, n_i = len(matched), len(burson_only), len(inhouse_only)
    clean_matches = sum(1 for m in matched if not m["diffs"])
    return {
        "window": {"days": days, "since": since, "until": until},
        "summary": {
            "matched": n_matched,
            "burson_only": n_b,
            "inhouse_only": n_i,
            "pending": len(pending),
            "recall": round(n_matched / (n_matched + n_b), 3) if (n_matched + n_b) else None,
            "precision": round(n_matched / (n_matched + n_i), 3) if (n_matched + n_i) else None,
            "full_agreement": round(clean_matches / n_matched, 3) if n_matched else None,
        },
        "field_disagreements": [
            {"field": f, "count": n, "rate": round(n / n_matched, 3) if n_matched else None, "examples": examples[f]}
            for f, n in field_counts.most_common()
        ],
        "matched": list(reversed(matched)),
        "burson_only": list(reversed(burson_only)),
        "inhouse_only": list(reversed(inhouse_only)),
        "pending": pending,
        "match_window_hours": PARITY_MATCH_WINDOW.total_seconds() / 3600,
    }


# ---------------------------------------------------------------------------
# Escalations + outbox
# ---------------------------------------------------------------------------


@router.get("/escalations")
def get_escalations(
    open_only: bool = False,
    case_id: str | None = None,
    analyst: str | None = None,
    limit: int = Query(300, ge=1, le=5000),
    ctx: AgentContext = Depends(get_ctx),
    user: User = Depends(require_viewer),
) -> dict[str, Any]:
    escs = ctx.store.list_escalations(
        case_id=case_id.strip().upper() if case_id else None,
        analyst_email=analyst.strip() if analyst else None,
        open_only=open_only,
        limit=limit,
    )
    cache: dict[str, Case | None] = {}
    rows = []
    for esc in escs:
        if esc.case_id not in cache:
            cache[esc.case_id] = ctx.store.get_case(esc.case_id)
        rows.append(escalation_json(esc, cache[esc.case_id]))
    rows.sort(key=lambda r: r["requested_at"], reverse=True)
    return {"escalations": rows, "count": len(rows), "open": sum(1 for r in rows if r["is_open"])}


@router.get("/outbox")
def get_outbox(
    undelivered_only: bool = False,
    target: str | None = None,
    limit: int = Query(300, ge=1, le=5000),
    ctx: AgentContext = Depends(get_ctx),
    user: User = Depends(require_viewer),
) -> dict[str, Any]:
    now = ctx.now()
    items = ctx.store.list_outbox(undelivered_only=undelivered_only, limit=100000)
    if target:
        items = [i for i in items if i.target == target]
    items.sort(key=lambda i: i.created_at, reverse=True)
    stale_after = timedelta(minutes=3)
    rows = []
    for item in items[:limit]:
        d = item.model_dump(mode="json")
        d["stale"] = item.delivered_at is None and now - item.created_at > stale_after
        d["delivery_s"] = (item.delivered_at - item.created_at).total_seconds() if item.delivered_at else None
        rows.append(d)
    undelivered = [i for i in items if i.delivered_at is None]
    return {
        "items": rows,
        "count": len(items),
        "undelivered": len(undelivered),
        "stale": sum(1 for i in undelivered if now - i.created_at > stale_after),
        "doorbell": ctx.config.outbox.doorbell,
    }


# ---------------------------------------------------------------------------
# Live Test Channel (push a message / react without touching Google Chat)
#
# These endpoints run the real operations against the real store, so they are
# gated: analysts in dev, admins only in prod. They never post to Chat:
# the agent's I/O stays with the Studio flows (docs/CONTRACTS.md §1).
# ---------------------------------------------------------------------------

TEST_SPACE_IDS = {"burson": "spaces/test-burson", "clean": "spaces/test-clean"}  # when config has no space id yet


class TestPushBody(BaseModel):
    text: str = Field(..., min_length=1, max_length=20000)
    channel: Literal["test_burson", "clean_chat"] = "test_burson"
    sender_email: str | None = None
    sender_name: str | None = None


class TestReactBody(BaseModel):
    case_id: str = Field(..., min_length=1, max_length=64)
    emoji: str = Field(..., min_length=1, max_length=16)


def require_test_channel(ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_analyst)) -> User:
    """Test pushes create real cases, drafts and outbox items: in prod only admins may do that."""
    if ctx.config.env == "prod" and not user.has("admin"):
        raise HTTPException(
            403,
            {"error": "The test channel is admin-only in prod (it writes real cases).", "code": "forbidden",
             "required_role": "admin"},
        )
    return user


def _space_fields(ctx: AgentContext, key: str) -> dict[str, str]:
    space = ctx.config.space(key)
    return {
        "space_id": (space.space_id if space and space.space_id else TEST_SPACE_IDS[key]),
        "space_name": (space.display_name if space else key),
    }


@router.post("/test/push")
def post_test_push(
    body: TestPushBody,
    ctx: AgentContext = Depends(get_ctx),
    user: User = Depends(require_test_channel),
) -> dict[str, Any]:
    from uuid import uuid4

    from triage_agent.operations import handle

    # The agent trusts the sender's email for what that person may do (an admin's "approve PROP-n", for one), so only
    # an admin may push a test message as someone else.
    as_other = (body.sender_email or "").strip().lower()
    if as_other and as_other != user.email.strip().lower() and not user.has("admin"):
        raise HTTPException(
            403,
            {"error": "Only an admin may send a test message as someone else.", "code": "forbidden",
             "required_role": "admin"},
        )
    msg_id = f"test-{uuid4().hex[:10]}"
    if body.channel == "test_burson":
        op, space = "triage_message", _space_fields(ctx, "burson")
        sender = {"email": body.sender_email or user.email, "name": body.sender_name or "Test Feed",
                  "type": "HUMAN" if body.sender_email else "BOT"}
    else:
        op, space = "converse", _space_fields(ctx, "clean")
        sender = {"email": body.sender_email or user.email, "name": body.sender_name or user.email.split("@")[0],
                  "type": "HUMAN"}
    resp = handle(
        {"op": op, "payload": {"message": {"message_id": msg_id, "text": body.text, "sender": sender, **space,
                                            "thread_id": f"thread-{msg_id}", "conversation_type": "SPACE"}}},
        ctx,
    )

    cid = resp.outputs.get("case_id")
    case = ctx.store.get_case(cid) if cid else None
    if case and not case.clean_message_ref:  # so a test reaction can find the case like a real clean post would
        case.clean_message_ref = f"clean-{case.case_id}"
        ctx.store.save_case(case)
    escalations = [escalation_json(e, case) for e in ctx.store.list_escalations(case_id=cid, limit=20)] if cid else []
    outputs_dict = dict(resp.outputs)
    if case and case.latest and outputs_dict.get("clean_text"):
        # Show the Burson message as it would read after the applied corrections, plus the agent's thread context.
        original_clean = outputs_dict["clean_text"]
        corrected_burson = body.text.strip()
        for c in case.latest.result.applied_corrections:
            old_s, new_s = str(c.old or "").strip(), str(c.new or "").strip()
            if old_s and new_s and old_s in corrected_burson:
                corrected_burson = corrected_burson.replace(old_s, new_s)
        assessment = case.latest.result.assessment
        outputs_dict["clean_text"] = corrected_burson
        outputs_dict["reply_text"] = (
            f"🤖 SLRR Triage Thread Context ({case.case_id})\n"
            f"• Original Burson Message Receipt Acknowledged: 👍"
            f"{' 📦' if escalations else ''}"
            f"{' ✍️' if (assessment and assessment.ts_recommended) else ''}\n\n"
            f"{original_clean}"
        )
    return {
        "ok": resp.ok,
        "outputs": outputs_dict,
        "data": resp.data,
        "case": case.model_dump(mode="json") if case else None,
        "summary": case_summary(case) if case else None,
        "escalations": escalations,
    }


@router.post("/test/react")
def post_test_react(
    body: TestReactBody,
    ctx: AgentContext = Depends(get_ctx),
    user: User = Depends(require_test_channel),
) -> dict[str, Any]:
    """Record a legend reaction as the signed-in user (never as someone else: drafts land in the reactor's Gmail)."""
    from triage_agent.operations import handle

    case = _get_case(ctx, body.case_id)
    resp = handle(
        {
            "op": "record_reaction",
            "payload": {
                "emoji": body.emoji,
                "reactor_email": user.email,
                "reactor_name": user.name or user.email.split("@")[0],
                "message_text": f"[{case.case_id}]",
                "message_id": case.clean_message_ref or f"clean-{case.case_id}",
                "space": _space_fields(ctx, "clean")["space_name"],
            },
        },
        ctx,
    )
    updated = ctx.store.get_case(case.case_id)
    escalations = [escalation_json(e, updated) for e in ctx.store.list_escalations(case_id=case.case_id, limit=20)]
    return {
        "ok": resp.ok,
        "outputs": resp.outputs,
        "data": resp.data,
        "case": updated.model_dump(mode="json") if updated else None,
        "summary": case_summary(updated) if updated else None,
        "escalations": escalations,
    }


# ---------------------------------------------------------------------------
# Google Chat app endpoint (experimental; see the Phase 0 decision on Studio vs. a Chat app)
#
# Enabled only when TRIAGE_CHAT_APP_AUDIENCE is set. Every call must carry the bearer
# token Google Chat sends (issued by chat@system.gserviceaccount.com for that audience).
# ---------------------------------------------------------------------------

CHAT_APP_ISSUER = "chat@system.gserviceaccount.com"
CHAT_APP_CERTS_URL = f"https://www.googleapis.com/service_accounts/v1/metadata/x509/{CHAT_APP_ISSUER}"


def _verify_chat_app_token(token: str, audience: str) -> dict[str, Any]:
    """Claims of a Google Chat app bearer token, or raise. Audience is the project number or the endpoint URL."""
    from google.auth.transport import requests as ga_requests
    from google.oauth2 import id_token

    request = ga_requests.Request()
    try:  # project-number audience: signed by the Chat system account
        claims = id_token.verify_token(token, request, audience=audience, certs_url=CHAT_APP_CERTS_URL)
    except Exception:  # noqa: BLE001 - endpoint-URL audience: a Google-signed OIDC token for the same account
        claims = id_token.verify_oauth2_token(token, request, audience=audience)
    if CHAT_APP_ISSUER not in (claims.get("iss"), claims.get("email")):
        raise ValueError("token was not issued for Google Chat")
    return claims


def require_chat_app(request: Request) -> dict[str, Any]:
    import os

    audience = os.environ.get("TRIAGE_CHAT_APP_AUDIENCE", "").strip()
    if not audience:
        raise _not_found("Chat app endpoint (set TRIAGE_CHAT_APP_AUDIENCE to enable it)")
    auth = request.headers.get("Authorization", "")
    token = auth[7:].strip() if auth.lower().startswith("bearer ") else ""
    if not token:
        raise HTTPException(401, {"error": "Missing Google Chat bearer token", "code": "unauthenticated"})
    try:
        return _verify_chat_app_token(token, audience)
    except Exception as exc:  # noqa: BLE001 - any verification failure is a 401
        raise HTTPException(401, {"error": f"Invalid Google Chat token: {exc}", "code": "unauthenticated"}) from exc


@router.post("/chat-webhook")
def post_chat_webhook(
    event: dict[str, Any],
    ctx: AgentContext = Depends(get_ctx),
    _claims: dict[str, Any] = Depends(require_chat_app),
) -> dict[str, Any]:
    """Google Chat app HTTP endpoint: MESSAGE -> triage_message / converse, REACTION -> record_reaction."""
    from triage_agent.operations import handle

    ev_type = str(event.get("type") or "MESSAGE").upper()
    msg = event.get("message") or {}
    space = event.get("space") or msg.get("space") or {}
    space_id = str(space.get("name") or "")
    space_name = str(space.get("displayName") or "")
    user_info = event.get("user") or msg.get("sender") or {}
    sender_email = str(user_info.get("email") or "").strip().lower()
    sender_name = str(user_info.get("displayName") or sender_email.split("@")[0])
    if not sender_email:  # never act on behalf of an assumed identity
        raise HTTPException(400, {"error": "Chat event has no sender email", "code": "validation_error"})

    burson_sp = ctx.config.space("burson")
    is_real_burson = bool(
        burson_sp
        and (space_id == burson_sp.space_id
             or space_name.strip().lower() == (burson_sp.display_name or "").strip().lower())
    )
    silent_burson = is_real_burson and ctx.config.burson_feedback.silent_in_burson_space

    if ev_type == "REACTION_CREATED" or "reaction" in event:
        rx = event.get("reaction") or {}
        emoji = str((rx.get("emoji") or {}).get("unicode") or event.get("emoji") or "")
        if not emoji:
            return {}
        resp = handle(
            {"op": "record_reaction",
             "payload": {"emoji": emoji, "reactor_email": sender_email, "reactor_name": sender_name,
                         "message_text": str(msg.get("text") or ""), "message_id": str(msg.get("name") or ""),
                         "space": space_name or space_id}},
            ctx,
        )
        reply = resp.outputs.get("reply_text") or resp.outputs.get("summary") or ""
        return {"text": reply} if (reply and not silent_burson) else {}

    text = str(msg.get("argumentText") or msg.get("text") or "").strip()
    if not text:
        return {}
    from triage_agent.qa import parser

    parsed = parser.parse(ctx.config, text)
    looks_like_alert, _ = parser.detect(ctx.config, ChatMessage(text=text), parsed)
    resp = handle(
        {"op": "triage_message" if looks_like_alert else "converse",
         "payload": {"message": {"message_id": str(msg.get("name") or "chat-msg"), "text": text,
                                 "sender": {"email": sender_email, "name": sender_name, "type": "HUMAN"},
                                 "space_id": space_id, "space_name": space_name,
                                 "thread_id": str((msg.get("thread") or {}).get("name") or "chat-thread"),
                                 "conversation_type": "SPACE"}}},
        ctx,
    )
    if silent_burson:
        return {}
    reply = (resp.outputs.get("clean_text") or resp.outputs.get("dm_text") or resp.outputs.get("reply_text")
             or resp.outputs.get("summary") or "")
    return {"text": reply} if reply else {}
