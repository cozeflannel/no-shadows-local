"""Deterministic checks (field + cross-field rules) and rule-based corrections.

Corrections here are mechanical (confidence 1.0): canonical names for merged
tags / renamed products, engagement arithmetic, the network implied by the
link's domain. Judgment calls (is this the right exposure tag?) are Gemini's
job (llm_assess.py); Collection-Requirements-derived fields (issue status,
engagement level, track prefix) are set in requirements.py.
"""

import re
from datetime import datetime, timedelta
from typing import Any
from urllib.parse import urlparse

from ..config import AgentConfig, FieldSpec
from ..models import Correction, Issue, IssueSource, Severity
from .record_key import domain_of

NETWORK_ALIASES = {
    "twitter": "X", "x (twitter)": "X", "x/twitter": "X", "x.com": "X", "fb": "Facebook", "ig": "Instagram",
    "insta": "Instagram", "yt": "YouTube", "tiktok": "TikTok", "linkedin": "LinkedIn", "truthsocial": "Truth Social",
    "truth": "Truth Social", "blue sky": "Bluesky", "bsky": "Bluesky",
}


def _missing(value: Any) -> bool:
    return value is None or value == "" or value == []


def _fix(spec: FieldSpec, text: str) -> str:
    return f"{text} {spec.fix_hint}".strip() if spec.fix_hint else text


def check_fields(config: AgentConfig, fields: dict[str, Any], now: datetime) -> list[Issue]:
    issues: list[Issue] = []
    col, dist = config.collection, config.distribution
    for spec in config.alert_template.fields:
        value = fields.get(spec.name)
        label = spec.labels[0] if spec.labels else spec.name
        if _missing(value):
            if spec.required:
                issues.append(Issue(field=spec.name, rule="required", fix=spec.fix_hint or f"Add the {label}."))
            continue
        t = spec.type
        if t == "integer" and not isinstance(value, int):
            issues.append(Issue(field=spec.name, rule="not_a_number", found=str(value), fix=f"{label} must be a number."))
            continue
        if t == "url":
            p = urlparse(str(value))
            if p.scheme not in ("http", "https") or not p.netloc or "." not in p.netloc:
                issues.append(Issue(field=spec.name, rule="invalid_url", found=str(value)[:200], fix=_fix(spec, f"{label} must be a full link.")))
                continue
        if t in ("datetime", "date"):
            if not isinstance(value, datetime):
                issues.append(Issue(field=spec.name, rule="invalid_datetime", found=str(value), severity=Severity.WARNING,
                                    fix=f"{label} should be a date/time like 2026-10-12 13:05 ET."))
                continue
            if spec.not_in_future and value > now + timedelta(minutes=10):
                issues.append(Issue(field=spec.name, rule="in_future", found=value.isoformat(), fix=f"{label} is in the future."))
            if spec.max_age_days and value < now - timedelta(days=spec.max_age_days):
                issues.append(Issue(field=spec.name, rule="too_old", found=value.isoformat(), severity=Severity.WARNING,
                                    fix=f"{label} is older than {spec.max_age_days} days."))
        if t == "enum" and spec.allowed and str(value) not in spec.allowed:
            issues.append(Issue(field=spec.name, rule="not_allowed", found=str(value), expected=", ".join(spec.allowed),
                                severity=Severity.BLOCKING if spec.required else Severity.WARNING,
                                fix=f"{label} must be one of: {', '.join(spec.allowed)}."))
        if spec.reference_list == "exposure_tags" and col.tag(str(value)) is None:
            issues.append(Issue(field=spec.name, rule="unknown_exposure_tag", found=str(value), source=IssueSource.REFERENCE,
                                fix="Use one exposure tag from the March 2026 Collection Requirements."))
        elif spec.reference_list == "products":
            for v in value if isinstance(value, list) else [value]:
                if dist.product(str(v)) is None:
                    issues.append(Issue(field=spec.name, rule="unknown_product", found=str(v), source=IssueSource.REFERENCE,
                                        severity=Severity.WARNING, fix=_fix(spec, "Use a product name from the distribution list.")))
        elif spec.reference_list and spec.reference_list not in ("sensitive_topics",):
            ref = config.reference_lists.get(spec.reference_list)
            options = ref if isinstance(ref, list) else (list(ref) if isinstance(ref, dict) else [])
            if options and str(value).lower() not in (str(o).lower() for o in options):
                issues.append(Issue(field=spec.name, rule="not_in_reference", found=str(value), source=IssueSource.REFERENCE,
                                    severity=Severity.WARNING, fix=f"{label} isn't in the {spec.reference_list} list."))
        if spec.pattern and isinstance(value, str) and not re.fullmatch(spec.pattern, value):
            issues.append(Issue(field=spec.name, rule="pattern", found=value[:200], fix=f"{label} has an unexpected format."))
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            if spec.min is not None and value < spec.min:
                issues.append(Issue(field=spec.name, rule="below_min", found=str(value), expected=f">= {spec.min:g}"))
            if spec.max is not None and value > spec.max:
                issues.append(Issue(field=spec.name, rule="above_max", found=str(value), expected=f"<= {spec.max:g}"))
        if isinstance(value, str):
            if spec.min_length and len(value) < spec.min_length:
                issues.append(Issue(field=spec.name, rule="too_short", found=value, severity=Severity.WARNING,
                                    fix=f"{label} looks incomplete."))
            if spec.max_length and len(value) > spec.max_length:
                issues.append(Issue(field=spec.name, rule="too_long", severity=Severity.WARNING))
    return issues


def check_cross_fields(config: AgentConfig, fields: dict[str, Any]) -> list[Issue]:
    issues: list[Issue] = []
    for rule in config.alert_template.cross_field_rules:
        if rule.kind == "require_if":
            if all(str(fields.get(k, "")).lower() == str(v).lower() for k, v in rule.when.items()):
                for name in rule.require:
                    if _missing(fields.get(name)):
                        issues.append(Issue(field=name, rule=f"{rule.id}", severity=rule.severity, fix=rule.fix or rule.description))
        elif rule.kind == "sum_equals" and rule.target:
            parts = [fields.get(f) for f in rule.fields]
            target = fields.get(rule.target)
            if all(isinstance(p, int) for p in parts) and isinstance(target, int):
                if abs(sum(parts) - target) > rule.tolerance:
                    issues.append(Issue(field=rule.target, rule=rule.id, severity=rule.severity, found=str(target),
                                        expected=str(sum(parts)), fix=rule.fix or rule.description))
        elif rule.kind == "url_domain_matches" and rule.url_field and rule.key_field and rule.domain_map:
            url, key = fields.get(rule.url_field), fields.get(rule.key_field)
            domains = (config.reference_lists.get(rule.domain_map) or {}).get(str(key)) if key else None
            dom = domain_of(url) if url else None
            if dom and domains and not any(dom == d or dom.endswith("." + d) for d in domains):
                issues.append(Issue(field=rule.key_field, rule=rule.id, severity=rule.severity, found=f"{key} vs {dom}",
                                    fix=rule.fix or rule.description))
    return issues


def network_for_domain(config: AgentConfig, domain: str | None) -> str | None:
    if not domain:
        return None
    for network, domains in (config.reference_lists.get("platform_domains") or {}).items():
        if any(domain == d or domain.endswith("." + d) for d in domains):
            return network
    return None


def deterministic_corrections(config: AgentConfig, fields: dict[str, Any]) -> tuple[dict[str, Any], list[Correction]]:
    """Mechanical fixes. Returns (new_fields, corrections). Never touches never_auto_correct fields."""
    col, dist = config.collection, config.distribution
    out = dict(fields)
    corrections: list[Correction] = []
    blocked = set(config.corrections.never_auto_correct)

    def fix(field: str, new: Any, reason: str) -> None:
        if field in blocked or out.get(field) == new:
            return
        corrections.append(Correction(field=field, old=out.get(field), new=new, reason=reason, source=IssueSource.RULE))
        out[field] = new

    tag = col.tag(out.get("exposure_tag")) if isinstance(out.get("exposure_tag"), str) else None
    if tag and out.get("exposure_tag") != tag.name:
        fix("exposure_tag", tag.name, "merged/renamed exposure tag")
    if tag and out.get("priority") and out.get("priority") != tag.priority:
        fix("priority", tag.priority, f"{tag.name} is {tag.priority}")

    risks = out.get("risk_tags")
    if isinstance(risks, list) and risks:
        canon = []
        for r in risks:
            topic = col.topic(r)
            canon.append(topic.name if topic else r)
        canon = list(dict.fromkeys(canon))
        if canon != risks:
            fix("risk_tags", canon, "canonical Sensitive Topic names")

    product = out.get("product")
    if isinstance(product, str) and product:
        distro = dist.product(product)
        if distro and distro.deprecated and len(distro.redirect_to) == 1:
            fix("product", distro.redirect_to[0], f"{distro.name} distro removed; alerts go to {distro.redirect_to[0]}")
        elif distro and not distro.deprecated and distro.name != product:
            fix("product", distro.name, "distribution product name")

    network = out.get("social_network")
    if isinstance(network, str) and network:
        alias = NETWORK_ALIASES.get(network.strip().lower())
        if alias and alias != network:
            fix("social_network", alias, "network name")
    url_network = network_for_domain(config, domain_of(out.get("post_url")))
    if url_network and out.get("social_network") and url_network != out.get("social_network"):
        fix("social_network", url_network, "matches the post link's domain")
    elif url_network and not out.get("social_network"):
        fix("social_network", url_network, "from the post link's domain")

    parts = [out.get(k) for k in ("likes", "comments", "shares")]
    if all(isinstance(p, int) for p in parts):
        total = sum(parts)
        if isinstance(out.get("total_engagement"), int) and out["total_engagement"] != total:
            fix("total_engagement", total, "likes + comments + shares")
        elif out.get("total_engagement") is None:
            fix("total_engagement", total, "likes + comments + shares")
    return out, corrections


# Issues that a correction resolves (rule id -> field). Used to drop stale issues after corrections.
def resolved_by(issue: Issue, corrections: list[Correction]) -> bool:
    fields = {c.field for c in corrections if c.applied}
    if issue.field in fields:
        return True
    if issue.rule.startswith("url_matches") or issue.rule == "url_matches_network":
        return "social_network" in fields
    return False
