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

from . import model_catalog
from .auth import User, get_ctx, require_admin, require_viewer

router = APIRouter(prefix="/api", tags=["settings"])

NOT_EDITABLE = {"version", "env"}
STRUCTURED_SECTIONS = ("thresholds", "corrections", "burson_feedback", "outbox", "handover", "metrics", "models")
TABLE_SECTIONS = ("distribution", "actions")

# The groups Settings lists its pages under, in order.
GROUPS: list[dict[str, str]] = [
    {"key": "day", "title": "Day to day"},
    {"key": "decide", "title": "How the agent decides"},
    {"key": "people", "title": "Who gets what"},
    {"key": "tech", "title": "Connections and upkeep"},
    {"key": "sheet", "title": "Sheet-based bot"},
]

# Each section: its name, what it is for in one sentence, and its group.
SECTION_INFO: dict[str, tuple[str, str, str]] = {
    "timezone": ("Time zone", "The time zone times are shown in.", "day"),
    "shifts": ("Shift names and hours", "The named shifts a handover summary is written for.", "day"),
    "handover": ("Shift handover", "The summary posted when a shift ends.", "day"),
    "actions": ("Emoji legend", "What the agent does when an IM reacts to an alert with each emoji.", "day"),
    "alert_template": ("Alert format", "The fields a Burson alert must have, and how each one is checked.", "decide"),
    "collection": ("Collection Requirements", "Exposure tags, sensitive topics, what is left out, and the time allowed on each platform.", "decide"),
    "thresholds": ("How sure the agent must be", "The confidence it needs before acting, how long it waits, and when it reminds people.", "decide"),
    "corrections": ("Auto-correct", "Which mistakes in an alert the agent fixes on its own.", "decide"),
    "protocols": ("Escalation protocols", "YouTube, Doodle and leadership: who is told, and when.", "decide"),
    "tns": ("Trust & Safety", "The T&S form, when T&S should see an alert, and the confirmation emails that come back.", "decide"),
    "reference_lists": ("Lists the checks use", "Names the checks compare an alert against.", "decide"),
    "sonar_lookup": ("Find missing links", "Look for a missing link or author in the listening data before asking Burson.", "decide"),
    "inhouse": ("Our own alerts", "Alerts taken straight from the team's tables, next to Burson's.", "decide"),
    "knowledge": ("Built-in answers", "Common questions the agent can answer. Documents are added on the Knowledge page.", "decide"),
    "models": ("Gemini models", "Which Gemini model does each job.", "decide"),
    "metrics": ("Time-saved estimate", "The minutes per alert used to estimate time saved.", "decide"),
    "analysts": ("People and roles", "Who has a role. Add and change people under Admin, People.", "people"),
    "distribution": ("Who gets each alert email", "For each product: the contacts and groups a Social Alert goes to.", "people"),
    "stakeholders": ("Who answers which question", "Teams, their topics and their contacts, used to send a question to the right people.", "people"),
    "escalation": ("Social Alert email", "The sender name, subject, signature and templates of the Social Alert email.", "people"),
    "burson_feedback": ("What Burson is told", "How a fix is reported back to Burson.", "people"),
    "watchdog": ("Watchdog emails", "How Watchdog Anti-Abuse emails are handled.", "people"),
    "agent": ("The agent's account", "The account the agent posts as, and the mark at the start of its messages.", "tech"),
    "spaces": ("Chat spaces", "The spaces the agent reads and posts in. Connect them under Integrations, Google Chat.", "tech"),
    "outbox": ("Waiting to post", "How posts that are waiting to go out reach Chat.", "tech"),
    "case_id_prefix": ("Alert number prefix", "The letters before each alert's number (TRG-1042).", "tech"),
    "escalation_id_prefix": ("Email number prefix", "The letters before each Social Alert email's number (ESC-1207).", "tech"),
    "seed_rosters": ("Starting rosters", "Used once, when no roster exists yet. Change rosters on the Rosters page.", "tech"),
    "platform": ("Everything under the other headings", "Kept for the record. Each part has its own page.", "tech"),
    "burson_qa": ("Sheet-based bot", "Settings of the sheet-based Burson QA bot. A change here reaches that bot only when its script is rebuilt.", "sheet"),
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
                "label": SECTION_INFO.get(key, (key.replace("_", " ").capitalize(), "", "tech"))[0],
                "description": SECTION_INFO.get(key, ("", "", "tech"))[1],
                "group": SECTION_INFO.get(key, ("", "", "tech"))[2],
                "kind": editor_kind(key),
                "overridden": key in overrides,
            }
            for key in config_sections()
        ],
        "groups": GROUPS,
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


@router.get("/settings/available-models")
def get_available_models(refresh: bool = False, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_viewer)) -> dict[str, Any]:
    """The Gemini models each model setting can pick from: what Vertex AI offers this project (kept for an hour), or a
    fallback list with the reason. `refresh` (admins) reads the list again now. Its path cannot clash with a section's:
    a section's name has no hyphen."""
    return model_catalog.choices(ctx, refresh=refresh and user.has("admin"), admin=user.has("admin"))


@router.get("/settings/{section}")
def get_section(section: str, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_viewer)) -> dict[str, Any]:
    section = _section_or_404(section)
    _, defaults = default_config()
    overrides = ctx.store.get_config_overrides() or {}
    try:
        from pydantic import TypeAdapter

        schema = TypeAdapter(AgentConfig.model_fields[section].annotation).json_schema()
    except Exception:  # noqa: BLE001 - the JSON editor still works without it
        schema = None
    return {
        "section": section,
        "kind": editor_kind(section),
        "schema": schema,
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
        "value": ctx.config.model_dump(mode="json").get(section),
        "overridden": section in overrides,
        "config_version": ctx.config_version,
    }


def save_sections(request: Request, ctx: AgentContext, user: User, target: dict[str, Any], note: str) -> AgentContext:
    """Save whole sections of the effective settings (as JSON), kept as their difference from the defaults.

    Raises pydantic's ValidationError when the result would not be a valid configuration; nothing is saved then.
    """
    base, defaults = default_config()
    overrides = copy.deepcopy(ctx.store.get_config_overrides() or {})
    for section, value in target.items():
        patch = merge_patch(defaults.get(section), value)
        if patch is _NOTHING:
            overrides.pop(section, None)
        else:
            overrides[section] = patch
    _validate(base, overrides)
    _save(request, ctx, user, ", ".join(sorted(target)), overrides, note, reset=False)
    return request.app.state.console.ctx


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
