"""Golden set: every correction, review decision and IM assessment, kept as a labelled example.

One record per case, rebuilt from the case each time something happens to it (a triage, a review decision, a
revert, a 👎, an assessment entered in the Console), so it is always the case's current truth:

    as_received   the alert's fields as it arrived (corrections undone)
    agent         what the agent decided the first time: verdict, corrections, class, confidence
    human         what the IMs did: review decision, values they set, corrections they reverted, their assessment
    label         unlabeled | confirmed (IM agreed) | corrected (IM changed or overrode something)

export_yaml() writes the labelled records in the shape evals/golden/*.yaml uses, so they can be dropped into the
eval harness. Switch: Settings → Feature flags → golden_set_capture.
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import TYPE_CHECKING, Any, Literal

import yaml
from pydantic import BaseModel, Field

from .events import PlatformEvent
from .models import Case, IssueSource

if TYPE_CHECKING:  # pragma: no cover
    from .context import AgentContext

log = logging.getLogger(__name__)

COLLECTION = "golden"
CAPTURE_OPS = frozenset({"triage_message", "review_decision", "revert_correction", "record_reaction", "start_escalation",
                         "record_assessment", "close_case", "ingest_inhouse", "ingest_email"})


class Assessment(BaseModel):
    """An IM's own judgment of one alert, entered in the Review Feed."""

    actor: str
    at: datetime
    agree: bool
    verdict: str | None = None  # the verdict the IM says is right, when they disagree
    fields: dict[str, Any] = Field(default_factory=dict)  # field -> the value the IM says is right
    note: str = ""


class GoldenRecord(BaseModel):
    case_id: str
    source: str = ""
    alert_text: str = ""
    as_received: dict[str, Any] = Field(default_factory=dict)
    agent: dict[str, Any] = Field(default_factory=dict)
    human: dict[str, Any] = Field(default_factory=dict)
    assessments: list[Assessment] = Field(default_factory=list)
    label: Literal["unlabeled", "confirmed", "corrected"] = "unlabeled"
    expected: dict[str, Any] = Field(default_factory=dict)  # the outcome a rerun should reproduce
    created_at: datetime
    updated_at: datetime
    env: str = "dev"


def _jsonable(value: Any) -> Any:
    if hasattr(value, "isoformat"):
        return value.isoformat()
    if isinstance(value, (list, tuple)):
        return [_jsonable(v) for v in value]
    if isinstance(value, dict):
        return {str(k): _jsonable(v) for k, v in value.items()}
    return value


def _as_received(case: Case) -> dict[str, Any]:
    first = case.attempts[0].result
    fields = dict(first.normalized)
    for c in reversed(first.corrections):
        if c.applied or c.reverted_by:
            fields[c.field] = c.old
    return _jsonable({k: v for k, v in fields.items() if v not in (None, "", [])})


def get(ctx: "AgentContext", case_id: str) -> GoldenRecord | None:
    row = ctx.store.get_doc(COLLECTION, case_id)
    return GoldenRecord.model_validate(row) if row else None


def capture(ctx: "AgentContext", case_id: str | None, *, force: bool = False) -> GoldenRecord | None:
    """Rebuild the golden record of one case. No-op while the switch is OFF (unless `force`)."""
    if not case_id or not (force or ctx.config.platform.flag("golden_set_capture")):
        return None
    case = ctx.store.get_case(case_id)
    if case is None or not case.attempts:
        return None
    now = ctx.now()
    existing = get(ctx, case_id)
    record = existing or GoldenRecord(case_id=case_id, created_at=now, updated_at=now, env=case.env)
    first, latest = case.attempts[0], case.attempts[-1]
    record.source = case.source
    record.alert_text = (first.message.text or "")[:12000]
    record.as_received = _as_received(case)
    if not record.agent:  # the agent's first call is kept as it was made
        r = first.result
        record.agent = _jsonable({
            "verdict": r.verdict.value, "confidence": r.confidence, "model": r.model, "rules_version": r.rules_version,
            "track": r.assessment.track if r.assessment else None,
            "issue_status": r.assessment.issue_status if r.assessment else None,
            "classification": (r.extra or {}).get("classification"),
            "field_confidence": (r.extra or {}).get("field_confidence"),
            "citations": [c.get("ref") for c in (r.extra or {}).get("citations") or []],
            "corrections": [{"field": c.field, "old": c.old, "new": c.new, "confidence": c.confidence, "source": c.source.value,
                             "applied": c.applied, "reason": c.reason} for c in r.corrections],
            "review_reasons": r.review_reasons,
        })
    result = latest.result
    set_by_im = {c.field: c.new for c in result.corrections if c.applied and c.reason.startswith("set by")}
    confirmed = [c.field for c in result.corrections if c.applied and "(confirmed by" in c.reason]
    reverted = {c.field: c.old for c in result.corrections if c.reverted_by}
    record.human = _jsonable({
        "review": case.review.model_dump(mode="json") if case.review else None,
        "set": set_by_im, "confirmed_proposals": confirmed, "reverted": reverted,
        "verdict_overridden_by": case.verdict_overridden_by,
        "actions": [{"code": a.code, "actor": a.actor, "at": a.at} for a in case.actions],
        "closed_reason": case.closed_reason, "status": case.status.value, "attempts": len(case.attempts),
    })
    disagreed = [a for a in record.assessments if not a.agree]
    changed = bool(set_by_im or reverted or case.verdict_overridden_by or disagreed
                   or (case.review and case.review.decision in ("bounce", "suppress")))
    touched = bool(case.review or case.actions or record.assessments or confirmed)
    record.label = "corrected" if changed else ("confirmed" if touched else "unlabeled")
    expected_fields = {**{c.field: c.new for c in result.corrections if c.applied and not c.reverted_by}}
    for a in record.assessments:
        expected_fields.update(a.fields)
    verdict = next((a.verdict for a in reversed(record.assessments) if a.verdict), None) or result.verdict.value
    record.expected = _jsonable({
        "verdict": verdict, "track": result.assessment.track if result.assessment else None,
        "issue_status": result.assessment.issue_status if result.assessment else None,
        "suppression_reason": result.assessment.suppression_reason if result.assessment else None,
        "corrections": expected_fields,
    })
    record.updated_at = now
    ctx.store.put_doc(COLLECTION, case_id, record.model_dump(mode="json"))
    if existing is None or existing.label != record.label:
        try:
            ctx.emit(PlatformEvent.GOLDEN_RECORDED, case_id=case_id, payload={"label": record.label, "new": existing is None})
        except Exception:  # noqa: BLE001
            log.warning("golden event failed", exc_info=True)
    return record


def add_assessment(ctx: "AgentContext", case_id: str, *, actor: str, agree: bool, verdict: str | None = None,
                   fields: dict[str, Any] | None = None, note: str = "") -> GoldenRecord:
    """Record an IM's assessment (always kept, whatever the capture switch says: it was entered on purpose)."""
    record = capture(ctx, case_id, force=True)
    if record is None:
        raise KeyError(case_id)
    record.assessments.append(Assessment(actor=actor, at=ctx.now(), agree=agree, verdict=(verdict or None),
                                         fields=_jsonable(fields or {}), note=note[:2000]))
    ctx.store.put_doc(COLLECTION, case_id, record.model_dump(mode="json"))
    ctx.emit(PlatformEvent.ASSESSMENT_RECORDED, actor=actor, case_id=case_id, space="console",
             payload={"agree": agree, "verdict": verdict, "fields": sorted((fields or {}).keys()), "note": bool(note)})
    return capture(ctx, case_id, force=True) or record


def list_records(ctx: "AgentContext", label: str | None = None, limit: int = 500) -> list[GoldenRecord]:
    rows = ctx.store.list_docs(COLLECTION, where={"label": label} if label else None, limit=limit)
    return [GoldenRecord.model_validate(r) for r in rows]


def stats(ctx: "AgentContext") -> dict[str, Any]:
    records = list_records(ctx, limit=5000)
    by_label: dict[str, int] = {"unlabeled": 0, "confirmed": 0, "corrected": 0}
    by_field: dict[str, int] = {}
    agree = disagree = 0
    for r in records:
        by_label[r.label] = by_label.get(r.label, 0) + 1
        for f in {*(r.human.get("set") or {}), *(r.human.get("reverted") or {})}:
            by_field[f] = by_field.get(f, 0) + 1
        for a in r.assessments:
            agree += 1 if a.agree else 0
            disagree += 0 if a.agree else 1
    labelled = by_label["confirmed"] + by_label["corrected"]
    return {"total": len(records), "by_label": by_label, "labelled": labelled,
            "agreement_rate": (by_label["confirmed"] / labelled) if labelled else None,
            "assessments": {"agree": agree, "disagree": disagree},
            "most_corrected_fields": sorted(by_field.items(), key=lambda kv: -kv[1])[:10]}


def export_yaml(ctx: "AgentContext", labels: tuple[str, ...] = ("confirmed", "corrected")) -> str:
    """Labelled records in the eval harness's golden format (evals/golden/*.yaml)."""
    cases = []
    for r in sorted(list_records(ctx, limit=5000), key=lambda r: r.case_id):
        if r.label not in labels:
            continue
        expect = {k: v for k, v in r.expected.items() if v not in (None, {}, [])}
        cases.append({
            "id": r.case_id.lower().replace("-", "_"),
            "description": f"{r.label} by IM ({r.source}); agent said {r.agent.get('verdict')}",
            "alert": r.as_received,
            "expect": expect,
        })
    header = ("# Golden set exported from the Console: alerts the Incident Managers confirmed or corrected.\n"
              "# Same shape as evals/golden/collection_requirements.yaml.\n")
    return header + yaml.safe_dump({"defaults": {}, "cases": cases}, sort_keys=False, allow_unicode=True, width=120)


def source_is_llm(value: Any) -> bool:
    return value == IssueSource.LLM or value == "llm"
