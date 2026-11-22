"""Settings endpoints: effective config per top-level section, validated edits, history.

Edits are stored as a minimal JSON merge patch (RFC 7386) against the YAML defaults, per
section, in `store.save_config_overrides` (config.load_config deep-merges them back). The
merged result is validated with AgentConfig before saving, and `config.updated` is emitted.
"""

from __future__ import annotations

import copy
import os
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field, ValidationError

from triage_agent.config import AgentConfig, deep_merge, load_default_dict
from triage_agent.context import AgentContext
from triage_agent.events import EventType as E

from .auth import User, get_ctx, require_admin, require_viewer

router = APIRouter(prefix="/api", tags=["settings"])

NOT_EDITABLE = {"version", "env"}
STRUCTURED_SECTIONS = ("thresholds", "corrections", "burson_feedback", "outbox", "handover", "metrics", "models")
TABLE_SECTIONS = ("distribution", "actions")

SECTION_INFO: dict[str, tuple[str, str]] = {
    "timezone": ("Display timezone", "Timezone for times in chat messages and the Console."),
    "case_id_prefix": ("Case id prefix", "Prefix of case ids (TRG-1042)."),
    "escalation_id_prefix": ("Escalation id prefix", "Prefix of escalation ids (ESC-1207)."),
    "agent": ("Agent identity", "The Triage Agent account and message prefix."),
    "spaces": ("Chat spaces", "Spaces the agent reads from and posts to."),
    "analysts": ("Analysts & roles", "Console roles: admin, lead, analyst."),
    "shifts": ("Shifts", "Named IM shifts (handover timing)."),
    "alert_template": ("Alert template", "How Burson alerts are parsed and validated."),
    "collection": ("Collection Requirements", "Exposure tags, sensitive topics, exclusions, tiers and SLAs."),
    "distribution": ("Distribution", "Product alert POCs and non-product groups."),
    "protocols": ("Protocols", "YouTube, Doodle and leadership escalation protocols."),
    "actions": ("Emoji actions legend", "What the agent does when an IM reacts on a clean-space alert."),
    "reference_lists": ("Reference lists", "Lookup lists used by validation rules."),
    "thresholds": ("Thresholds", "Confidence thresholds, wait limits and reminder timing."),
    "corrections": ("Corrections", "When the agent auto-applies corrections."),
    "burson_feedback": ("Burson feedback", "How corrections are reported back to Burson."),
    "sonar_lookup": ("Sonar lookup", "Optional ground truth from Sonar data in BigQuery."),
    "inhouse": ("In-house alerts (Path B)", "brand_safety_alerting outbox ingestion and parity mode."),
    "outbox": ("Outbox", "How queued posts reach the Studio Outbox flow."),
    "handover": ("Handover", "Shift handover summaries."),
    "metrics": ("Metrics", "Assumptions behind the time-saved estimate."),
    "models": ("Models", "Gemini models and temperatures."),
    "stakeholders": ("Stakeholders", "Q&A routing directory."),
    "escalation": ("Escalation email", "Brand Social alias, subjects and email templates."),
    "tns": ("Trust & Safety", "go/WD-Triage form, criteria and the Watchdog email loop."),
    "watchdog": ("Watchdog emails", "Watchdog Anti-Abuse Alert email handling."),
    "knowledge": ("Knowledge", "Docs and FAQ used to answer questions."),
    "seed_rosters": ("Seed rosters", "Only used to seed an empty store; edit live rosters on the Rosters page."),
}

_NOTHING = object()


def config_sections() -> list[str]:
    return [k for k in AgentConfig.model_fields if k not in NOT_EDITABLE]


def editor_kind(section: str) -> str:
    if section in STRUCTURED_SECTIONS:
        return "structured"
    if section in TABLE_SECTIONS:
        return "table"
    return "json"


def merge_patch(base: Any, target: Any) -> Any:
    """Minimal RFC 7386 merge patch turning `base` into `target` (_NOTHING when equal)."""
    if isinstance(base, dict) and isinstance(target, dict):
        patch: dict[str, Any] = {}
        for key in base:
            if key not in target:
                patch[key] = None
        for key, value in target.items():
            if key in base:
                sub = merge_patch(base[key], value)
                if sub is not _NOTHING:
                    patch[key] = sub
            else:
                patch[key] = value
        return patch if patch else _NOTHING
    return _NOTHING if base == target else target


def unknown_keys(value: Any, dumped: Any, path: list[str]) -> list[list[str]]:
    """Keys in `value` that the validated config dropped (typos would otherwise be ignored silently)."""
    if isinstance(value, dict) and isinstance(dumped, dict):
        out: list[list[str]] = []
        for k, v in value.items():
            if k not in dumped:
                out.append(path + [str(k)])
            else:
                out += unknown_keys(v, dumped[k], path + [str(k)])
        return out
    if isinstance(value, list) and isinstance(dumped, list):
        out = []
        for i, (v, d) in enumerate(zip(value, dumped)):
            out += unknown_keys(v, d, path + [str(i)])
        return out
    return []


def _validate(base: dict[str, Any], overrides: dict[str, Any]) -> AgentConfig:
    data = deep_merge(base, overrides)
    env = os.environ.get("TRIAGE_ENV")
    if env:
        data["env"] = env
    # The config models refuse unknown keys; put_section names them itself (unknown_keys), as before.
    return AgentConfig.model_validate(data, extra="ignore")


def default_config() -> tuple[dict[str, Any], dict[str, Any]]:
    """(raw YAML defaults, validated defaults dumped as JSON)."""
    base = load_default_dict()
    return base, AgentConfig.model_validate(base).model_dump(mode="json")


def format_errors(exc: ValidationError, section: str) -> list[dict[str, Any]]:
    out = []
    for err in exc.errors(include_url=False, include_context=False, include_input=False):
        loc = [str(x) if not isinstance(x, int) else x for x in err.get("loc", ())]
        if loc and loc[0] == section:
            loc = loc[1:]
        out.append({"loc": loc, "msg": err.get("msg", "invalid"), "type": err.get("type", "")})
    return out


def _section_or_404(section: str) -> str:
    if section in NOT_EDITABLE:
        raise HTTPException(422, {"error": f"'{section}' can't be edited in the Console", "code": "validation_error"})
    if section not in AgentConfig.model_fields:
        raise HTTPException(404, {"error": f"Unknown config section '{section}'", "code": "not_found"})
    return section


def _last_update(ctx: AgentContext) -> dict[str, Any] | None:
    history = ctx.store.config_history(limit=1)
    if not history:
        return None
    h = history[0]
    return {"updated_by": h.get("updated_by"), "updated_at": h.get("updated_at"), "note": h.get("note")}


@router.get("/settings")
def get_settings(ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_viewer)) -> dict[str, Any]:
    overrides = ctx.store.get_config_overrides() or {}
    return {
        "config": ctx.config.model_dump(mode="json"),
        "overrides": overrides,
        "sections": [
            {
                "key": key,
                "label": SECTION_INFO.get(key, (key.replace("_", " ").title(), ""))[0],
                "description": SECTION_INFO.get(key, ("", ""))[1],
                "kind": editor_kind(key),
                "overridden": key in overrides,
            }
            for key in config_sections()
        ],
        "config_version": ctx.config_version,
        "version": ctx.config.version,
        "env": ctx.config.env,
        "last_update": _last_update(ctx),
        "can_edit": user.has("admin"),
    }


@router.get("/settings/history")
def get_settings_history(
    limit: int = Query(30, ge=1, le=200),
    ctx: AgentContext = Depends(get_ctx),
    user: User = Depends(require_viewer),
) -> dict[str, Any]:
    entries = ctx.store.config_history(limit=limit + 1)
    out = []
    for i, entry in enumerate(entries[:limit]):
        current = entry.get("overrides") or {}
        previous = (entries[i + 1].get("overrides") or {}) if i + 1 < len(entries) else {}
        changed = sorted(k for k in set(current) | set(previous) if current.get(k) != previous.get(k))
        out.append({
            "updated_at": entry.get("updated_at"),
            "updated_by": entry.get("updated_by"),
            "note": entry.get("note") or "",
            "sections_changed": changed,
            "changes": {k: {"before": previous.get(k), "after": current.get(k)} for k in changed},
        })
    return {"history": out}


@router.get("/settings/{section}")
def get_section(section: str, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_viewer)) -> dict[str, Any]:
    section = _section_or_404(section)
    _, defaults = default_config()
    overrides = ctx.store.get_config_overrides() or {}
    return {
        "section": section,
        "kind": editor_kind(section),
        "value": ctx.config.model_dump(mode="json")[section],
        "default": defaults.get(section),
        "override": overrides.get(section),
        "overridden": section in overrides,
        "config_version": ctx.config_version,
    }


class SectionBody(BaseModel):
    value: Any = None
    note: str | None = Field(None, max_length=500)
    base_version: str | None = None  # config_version the editor loaded (optimistic concurrency)


def _save(request: Request, ctx: AgentContext, user: User, section: str, overrides: dict[str, Any], note: str, reset: bool) -> dict[str, Any]:
    ctx.store.save_config_overrides(overrides, actor=user.email, note=note)
    ctx = request.app.state.console.reload()
    ctx.emit(E.CONFIG_UPDATED, actor=user.email, space="console",
             payload={"section": section, "via": "console", "note": note, "reset": reset})
    return {
        "ok": True,
        "section": section,
        "value": ctx.config.model_dump(mode="json")[section],
        "overridden": section in overrides,
        "config_version": ctx.config_version,
    }


@router.put("/settings/{section}")
def put_section(
    section: str,
    body: SectionBody,
    request: Request,
    ctx: AgentContext = Depends(get_ctx),
    user: User = Depends(require_admin),
) -> dict[str, Any]:
    section = _section_or_404(section)
    if body.value is None:
        raise HTTPException(422, {"error": "A value is required (use DELETE to reset a section to its defaults)", "code": "validation_error"})
    if body.base_version and body.base_version != ctx.config_version:
        raise HTTPException(409, {"error": "The configuration changed since you loaded it. Reload and re-apply your edit.",
                                  "code": "conflict", "config_version": ctx.config_version})
    base, defaults = default_config()
    patch = merge_patch(defaults.get(section), body.value)
    overrides = copy.deepcopy(ctx.store.get_config_overrides() or {})
    if patch is _NOTHING:
        overrides.pop(section, None)
    else:
        overrides[section] = patch
    try:
        candidate = _validate(base, overrides)
    except ValidationError as exc:
        raise HTTPException(422, {"error": f"Invalid {section} settings", "code": "validation_error",
                                  "errors": format_errors(exc, section)}) from exc
    unknown = unknown_keys(body.value, candidate.model_dump(mode="json")[section], [])
    if unknown:
        raise HTTPException(422, {
            "error": f"Unknown {section} setting(s): {', '.join('.'.join(p) for p in unknown[:5])}",
            "code": "validation_error",
            "errors": [{"loc": p, "msg": "Unknown setting (it would be ignored)", "type": "unknown_key"} for p in unknown],
        })
    note = (body.note or "").strip() or f"{section} updated in the Agent Console"
    return _save(request, ctx, user, section, overrides, note, reset=False)


@router.delete("/settings/{section}")
def reset_section(
    section: str,
    request: Request,
    ctx: AgentContext = Depends(get_ctx),
    user: User = Depends(require_admin),
) -> dict[str, Any]:
    section = _section_or_404(section)
    overrides = copy.deepcopy(ctx.store.get_config_overrides() or {})
    if section not in overrides:
        return {"ok": True, "section": section, "value": ctx.config.model_dump(mode="json")[section],
                "overridden": False, "config_version": ctx.config_version}
    overrides.pop(section)
    base, _ = default_config()
    try:
        _validate(base, overrides)
    except ValidationError as exc:
        raise HTTPException(422, {"error": "Resetting this section would leave an invalid configuration", "code": "validation_error",
                                  "errors": format_errors(exc, section)}) from exc
    return _save(request, ctx, user, section, overrides, f"{section} reset to defaults in the Agent Console", reset=True)
