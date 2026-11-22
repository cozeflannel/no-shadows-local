"""QA pipeline shared by every intake path.

run_qa():   parse result -> rule checks -> mechanical corrections -> Gemini
            assessment -> correction policy -> Collection Requirements -> verdict
reassess(): re-evaluate a stored result after an IM decision (forward with
            overrides, revert a correction) without calling Gemini again.
"""

import logging
import time
from datetime import datetime
from typing import TYPE_CHECKING, Any

from ..config import AgentConfig
from ..llm import LLMError
from ..models import Correction, Issue, IssueSource, ParsedAlert, Severity, TriageResult, Verdict
from .. import cases as case_mod
from .llm_assess import PROMPT_VERSION, Enrichment, assess
from .parser import normalize_value
from .requirements import evaluate
from .rules import check_cross_fields, check_fields, deterministic_corrections

if TYPE_CHECKING:  # pragma: no cover
    from ..context import AgentContext

log = logging.getLogger(__name__)

# Fields whose problems can change the alert/suppress decision.
ALERTABILITY_FIELDS = {"total_engagement", "likes", "comments", "shares", "exposure_tag", "priority", "risk_tags",
                       "kof", "kof_lists", "issue_status", "product", "location"}
# Mechanical renames applied even when corrections.mode == "propose".
CANONICAL_REASONS = {"merged/renamed exposure tag", "canonical Sensitive Topic names", "distribution product name", "network name"}


def _apply_policy(config: AgentConfig, c: Correction) -> Correction:
    pol = config.corrections
    spec = config.alert_template.field(c.field)
    if c.field in pol.never_auto_correct:
        c.applied = False
    elif c.source == IssueSource.RULE and c.reason in CANONICAL_REASONS:
        c.applied = True
    elif pol.mode == "propose":
        c.applied = False
    elif c.source == IssueSource.LLM:
        c.applied = bool(spec and spec.correctable) and c.confidence >= pol.auto_apply_min_confidence
    else:
        c.applied = c.confidence >= pol.auto_apply_min_confidence
    return c


def _coerce(config: AgentConfig, field: str, value: Any) -> Any:
    spec = config.alert_template.field(field)
    return normalize_value(spec, value, config.timezone) if spec and isinstance(value, str) else value


def _restore_types(config: AgentConfig, normalized: dict[str, Any]) -> dict[str, Any]:
    """Stored results come back from JSON with datetimes as ISO strings; make them datetimes again."""
    fields = dict(normalized)
    for name, value in normalized.items():
        spec = config.alert_template.field(name)
        if spec and spec.type in ("datetime", "date") and isinstance(value, str):
            fields[name] = normalize_value(spec, value, config.timezone)
    return fields


def _enrichment_from(result: TriageResult | None) -> Enrichment:
    a = result.assessment if result else None
    if not a:
        return Enrichment()
    return Enrichment(
        sundar_mention=a.sundar_mention, non_us_markets=[m for m in a.non_us_markets if not m.startswith("language:")],
        secondary_products=a.secondary_products, owned_post=a.owned_post, owned_profile_url=a.owned_profile_url,
        video_timestamp=a.video_timestamp, bias_allegation=a.bias_allegation,
    )


def run_qa(ctx: "AgentContext", parsed: ParsedAlert, *, source: str, received_at: datetime,
           record_key: str | None = None) -> TriageResult:
    t0 = time.monotonic()
    cfg, now = ctx.config, ctx.now()
    checks_run = ["parse", "rules"]
    fields = dict(parsed.fields)

    # 0. Optional ground truth: fill blanks from the in-house record of the same post
    if ctx.sonar is not None:
        for name, value in ctx.sonar.missing_fields(fields).items():
            fields[name] = _coerce(cfg, name, value)
        checks_run.append("sonar")

    # 1. Mechanical corrections (policy decides which are applied)
    _, det = deterministic_corrections(cfg, fields)
    corrections = [_apply_policy(cfg, c) for c in det]
    for c in corrections:
        if c.applied:
            fields[c.field] = c.new

    # 2. Gemini judgment checks + enrichment
    enrichment: Enrichment | None = None
    llm_issues: list[Issue] = []
    confidences: list[float] = []
    model = None
    try:
        result = assess(ctx, fields, parsed.extra)
    except LLMError as exc:
        log.warning("Gemini assessment unavailable: %s", exc)
        result = None
        llm_issues.append(Issue(field=None, rule="llm_unavailable", severity=Severity.WARNING, source=IssueSource.LLM,
                                fix="Gemini checks were unavailable: verify tag, product and risk tags manually."))
    if result is not None:
        checks_run.append("llm")
        model = cfg.models.triage
        enrichment = result.enrichment
        specs = {c.id: c for c in cfg.alert_template.llm_checks}
        for check in result.checks:
            spec = specs.get(check.id)
            confidences.append(check.confidence)
            if check.ok or spec is None:
                continue
            target = spec.correctable_field
            if target and check.proposed_value not in (None, ""):
                new = _coerce(cfg, target, check.proposed_value)
                if new != fields.get(target):
                    c = _apply_policy(cfg, Correction(field=target, old=fields.get(target), new=new, reason=check.finding[:200],
                                                     confidence=check.confidence, source=IssueSource.LLM))
                    corrections.append(c)
                    if c.applied:
                        fields[target] = new
                    continue
            severity = spec.severity
            if severity == Severity.BLOCKING and check.confidence < cfg.thresholds.llm_block_min_confidence:
                severity = Severity.WARNING  # low-confidence complaints don't hold the alert
            llm_issues.append(Issue(field=target or (spec.fields[0] if spec.fields else None), rule=f"llm:{check.id}",
                                    severity=severity, found=None, fix=check.finding[:300] or None,
                                    source=IssueSource.LLM, confidence=check.confidence))
        # Removed distro with several targets (e.g. Central AI): Gemini reclassifies
        distro = cfg.distribution.product(fields.get("product"))
        recl = enrichment.product_reclassification
        if distro and distro.deprecated and len(distro.redirect_to) > 1 and recl and recl in distro.redirect_to:
            c = _apply_policy(cfg, Correction(field="product", old=fields.get("product"), new=recl, confidence=0.9,
                                              reason=f"{distro.name} distro removed; reclassified", source=IssueSource.LLM))
            corrections.append(c)
            if c.applied:
                fields["product"] = recl

    return finalize(ctx, parsed_extra=parsed.extra, flags=parsed.flags, fields=fields, corrections=corrections,
                    extra_issues=llm_issues, enrichment=enrichment, received_at=received_at, record_key=record_key,
                    confidences=confidences, checks_run=checks_run, model=model, started=t0, now=now)


def finalize(ctx: "AgentContext", *, parsed_extra: dict, flags: dict, fields: dict, corrections: list[Correction],
             extra_issues: list[Issue], enrichment: Enrichment | None, received_at: datetime, record_key: str | None,
             confidences: list[float], checks_run: list[str], model: str | None, started: float, now: datetime,
             forced_alertable: bool = False, pinned: dict[str, Any] | None = None) -> TriageResult:
    """Requirements + remaining issues + verdict (shared by run_qa and reassess)."""
    cfg = ctx.config
    tag = cfg.collection.tag(fields.get("exposure_tag"))
    history = case_mod.novelty_history(ctx, tag.name if tag else fields.get("exposure_tag"), received_at,
                                       exclude_record_key=record_key)
    req = evaluate(cfg, fields, received_at=received_at, extra=parsed_extra, enrichment=enrichment, history=history,
                   history_complete=case_mod.history_complete(ctx, received_at), flags=flags, pinned=pinned)
    checks_run = [*checks_run, "requirements"]
    fields = req.fields
    for c in req.corrections:
        corrections.append(_apply_policy(cfg, c))
        if not corrections[-1].applied:  # keep the stated value when the derived fix isn't applied
            fields[c.field] = c.old

    # Remaining rule issues are computed on the final fields.
    issues = check_fields(cfg, fields, now) + check_cross_fields(cfg, fields) + extra_issues + req.warnings
    blocking = [i for i in issues if i.severity == Severity.BLOCKING]
    never = set(cfg.corrections.never_auto_correct)

    def unfixable(i: Issue) -> bool:
        if i.source == IssueSource.LLM:
            return False
        spec = cfg.alert_template.field(i.field) if i.field else None
        return i.field is None or i.field in never or spec is None or not spec.correctable

    hard = [i for i in blocking if unfixable(i)]
    soft = [i for i in blocking if not unfixable(i)]
    proposed = [c for c in corrections if not c.applied]
    applied = [c for c in corrections if c.applied]
    confidence = min([1.0, *confidences, *(c.confidence for c in applied if c.source == IssueSource.LLM)])
    a = req.assessment

    reasons = list(req.review_reasons)
    reasons += [f"{c.field}: proposed \"{c.new}\" ({c.confidence:.2f}) — {c.reason}" for c in proposed]
    reasons += [f"{i.field or 'alert'}: {i.fix or i.rule}" for i in soft]
    if confidence < cfg.thresholds.needs_review_below:
        reasons.append(f"low overall confidence ({confidence:.2f})")

    alert_field_trouble = any(i.field in ALERTABILITY_FIELDS for i in blocking) or any(c.field in ALERTABILITY_FIELDS for c in proposed)
    if forced_alertable:
        verdict = Verdict.CORRECTED if applied else Verdict.PASS
    elif not a.alertable and not alert_field_trouble:
        verdict = Verdict.SUPPRESSED
    elif hard:
        verdict = Verdict.FAIL
    elif reasons or not a.alertable:
        if not a.alertable:
            reasons.append(f"would be suppressed ({a.suppression_reason}) but the deciding fields need review")
        verdict = Verdict.NEEDS_REVIEW
    elif applied:
        verdict = Verdict.CORRECTED
    else:
        verdict = Verdict.PASS

    return TriageResult(
        verdict=verdict, confidence=round(confidence, 3), issues=issues, corrections=corrections, assessment=a,
        record_key=record_key, normalized=fields, checks_run=checks_run, review_reasons=reasons if verdict == Verdict.NEEDS_REVIEW else [],
        extra=parsed_extra or {}, flags=flags or {}, model=model, rules_version=f"{cfg.collection.version}/{PROMPT_VERSION}",
        latency_ms=int((time.monotonic() - started) * 1000),
    )


def reassess(ctx: "AgentContext", previous: TriageResult, *, received_at: datetime, overrides: dict[str, Any] | None = None,
             accept_proposed: bool = False, revert_field: str | None = None, actor: str = "IM",
             forced_alertable: bool = False) -> TriageResult:
    """Re-run requirements + verdict on a stored result after an IM decision (no Gemini call)."""
    cfg = ctx.config
    fields = _restore_types(cfg, previous.normalized)
    corrections = [c.model_copy() for c in previous.corrections]
    for c in corrections:
        if revert_field and c.field == revert_field and c.applied and not c.reverted_by:
            c.reverted_by = actor
            c.applied = False
            fields[c.field] = c.old
        elif accept_proposed and not c.applied and not c.reverted_by and c.field not in (overrides or {}):
            c.applied = True
            c.reason = f"{c.reason} (confirmed by {actor})".strip()
            fields[c.field] = c.new
    for name, value in (overrides or {}).items():
        new = _coerce(cfg, name, value)
        if fields.get(name) != new:
            corrections.append(Correction(field=name, old=fields.get(name), new=new, reason=f"set by {actor}",
                                          confidence=1.0, source=IssueSource.RULE, applied=True))
            fields[name] = new
    # Derived corrections are recomputed by finalize(); drop the stale ones.
    derived = {"issue_status", "engagement_level", "alert_name"}
    corrections = [c for c in corrections if not (c.field in derived and c.source == IssueSource.RULE and c.reason
                                                  and not c.reason.startswith("set by") and not c.reverted_by)]
    for name in derived:
        orig = next((c.old for c in previous.corrections if c.field == name and c.source == IssueSource.RULE), None)
        if orig is not None and name not in (overrides or {}):
            fields[name] = orig
    llm_issues = [i for i in previous.issues if i.source == IssueSource.LLM]
    # Reverted fixes stay reverted: derivation must not re-apply them (IM overrides win over a revert).
    pinned = {c.field: c.old for c in corrections if c.reverted_by and c.field not in (overrides or {})}
    return finalize(ctx, parsed_extra=previous.extra, flags=previous.flags, fields=fields, corrections=corrections,
                    extra_issues=llm_issues, enrichment=_enrichment_from(previous), received_at=received_at,
                    record_key=previous.record_key, confidences=[1.0], checks_run=["reassess"], model=previous.model,
                    started=time.monotonic(), now=ctx.now(), forced_alertable=forced_alertable, pinned=pinned)
