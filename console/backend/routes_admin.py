"""Console API for administration: platform settings, switches, secrets, BigQuery, delivery (Pub/Sub),
AI instructions, safety checks, the audit log, costs and the setup checklist."""

from __future__ import annotations

import copy
import csv
import io
import os
from datetime import timedelta
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, Field, ValidationError

from triage_agent import audit, bq_admin, prompts, pubsub, safety, secret_admin
from triage_agent.config import PlatformConfig, switch_off
from triage_agent.context import AgentContext
from triage_agent.events import EventType as E
from triage_agent.events import PlatformEvent as P

from .auth import User, get_ctx, require_admin, require_lead, require_viewer
from .routes_settings import _NOTHING, _save, _validate, default_config, format_errors, merge_patch, unknown_keys

router = APIRouter(prefix="/api", tags=["admin"])

# Each Settings page: its name, what it is for in one sentence, and the group it is listed under (routes_settings.GROUPS).
PART_INFO: dict[str, tuple[str, str, str]] = {
    "flags": ("Switches", "What the agent may do on its own. Every switch starts OFF.", "day"),
    "safety": ("Safety and Testing", "While Testing is ON every email goes only to your test addresses. Also where the agent may post and who it may email.", "day"),
    "notifications": ("Alert pop-ups", "Which alerts pop up in the Console, and for how long.", "day"),
    "stories": ("Stories", "How alerts are grouped into stories and what the story map shows.", "decide"),
    "classification": ("Alert classes", "The kinds of alert the agent sorts each one into, and the documents each kind reads.", "decide"),
    "knowledge": ("How documents are read", "How the agent splits, searches and refreshes the documents on the Knowledge page.", "decide"),
    "temp_check": ("Temp check", "Where temp checks read posts from, and when the agent runs one on its own.", "decide"),
    "forecasting": ("Staffing forecast", "How alert volume is forecast and turned into the people needed each hour.", "decide"),
    "campaigns": ("Campaigns and watches", "Where campaigns are kept, and how often and how widely watches look.", "decide"),
    "chat_agent": ("Console chat agent", "The assistant on the Chat agent page.", "decide"),
    "decisions": ("Gemini Decisions", "The decision maker: the key it uses, how often it may be asked, and the bars its answers are held to.", "decide"),
    "early": ("Early Detection", "Which post tables are read, how like posts are grouped into stories, and when a story is raised.", "decide"),
    "own_alerts": ("Agent alerts", "Alerts the agent raises itself: what it reads, how personal details are taken out, and how a post or story is reviewed and raised.", "decide"),
    "access": ("Who can open the Console", "The sign-in domains that may read the Console.", "people"),
    "gcp": ("Google Cloud project", "The project and region the Console runs in.", "tech"),
    "pubsub": ("Delivery", "How the agent's posts go out, how often a failed one is tried again, and when it stops trying.", "tech"),
    "bigquery": ("BigQuery", "Where events and reports are kept.", "tech"),
    "costs": ("Costs", "The prices used to estimate what the agent spends.", "tech"),
    "telemetry": ("Logs and record keeping", "How much is logged and how long records are kept.", "tech"),
}


def _reject(exc: Exception, status: int = 409) -> HTTPException:
    return HTTPException(status, {"error": str(exc), "code": "rejected"})


def _part(name: str) -> str:
    if name not in PlatformConfig.model_fields:
        raise HTTPException(404, {"error": f"Unknown settings part '{name}'", "code": "not_found"})
    return name


# -- platform settings, one part at a time --------------------------------------------------------------------------------
@router.get("/platform")
def platform_index(ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_viewer)) -> dict[str, Any]:
    overrides = (ctx.store.get_config_overrides() or {}).get("platform") or {}
    return {"parts": [{"key": k, "label": PART_INFO[k][0], "description": PART_INFO[k][1], "group": PART_INFO[k][2],
                       "overridden": k in overrides} for k in PART_INFO if k in PlatformConfig.model_fields],
            "config_version": ctx.config_version, "can_edit": user.has("admin")}


@router.get("/platform/{part}")
def platform_get(part: str, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_viewer)) -> dict[str, Any]:
    part = _part(part)
    model = PlatformConfig.model_fields[part].annotation
    _, defaults = default_config()
    return {"part": part, "label": PART_INFO[part][0], "description": PART_INFO[part][1],
            "value": ctx.config.platform.model_dump(mode="json")[part], "default": defaults["platform"][part],
            "schema": model.model_json_schema(), "config_version": ctx.config_version, "can_edit": user.has("admin")}


class PartBody(BaseModel):
    value: dict[str, Any]
    note: str | None = Field(None, max_length=500)
    base_version: str | None = None


@router.put("/platform/{part}")
def platform_put(part: str, body: PartBody, request: Request, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_admin)) -> dict[str, Any]:
    return save_part(part, body, request, ctx, user)


def save_part(part: str, body: PartBody, request: Request, ctx: AgentContext, user: User, *, label: str = "", action: str = "") -> dict[str, Any]:
    """Saves one part of the platform settings and puts the change on the record. A page with its own save (Routing)
    passes its own name and audit action."""
    part = _part(part)
    if body.base_version and body.base_version != ctx.config_version:
        raise HTTPException(409, {"error": "The settings changed since you loaded them. Reload and apply your edit again.",
                                  "code": "conflict", "config_version": ctx.config_version})
    base, defaults = default_config()
    current = ctx.config.platform.model_dump(mode="json")
    before = copy.deepcopy(current[part])
    current[part] = {**defaults["platform"][part], **body.value}  # a setting left out goes back to its default
    patch = merge_patch(defaults["platform"], current)
    overrides = copy.deepcopy(ctx.store.get_config_overrides() or {})
    if patch is _NOTHING:
        overrides.pop("platform", None)
    else:
        overrides["platform"] = patch
    try:
        candidate = _validate(base, overrides)
    except ValidationError as exc:
        errors = format_errors(exc, "platform")
        for err in errors:
            if err["loc"] and err["loc"][0] == part:
                err["loc"] = err["loc"][1:]
        raise HTTPException(422, {"error": f"Invalid {label or PART_INFO.get(part, (part, ''))[0]} settings", "code": "validation_error", "errors": errors}) from exc
    unknown = unknown_keys(body.value, candidate.model_dump(mode="json")["platform"][part], [])
    if unknown:
        raise HTTPException(422, {"error": f"Unknown setting(s): {', '.join('.'.join(p) for p in unknown[:5])}", "code": "validation_error",
                                  "errors": [{"loc": p, "msg": "Unknown setting", "type": "unknown_key"} for p in unknown]})
    label = label or PART_INFO.get(part, (part, ''))[0]
    note = (body.note or "").strip() or f"{label} updated in the Console"
    saved = _save(request, ctx, user, "platform", overrides, note, reset=False)
    after = saved["value"][part]
    changed = sorted(k for k in set(before) | set(after) if before.get(k) != after.get(k))
    fresh = request.app.state.console.ctx
    audit.record(fresh, actor=user.email, action=action or f"settings.{part}", surface="console", target_type="setting", target_id=part,
                 summary=f"Changed {label}: {', '.join(changed) or 'no change'}",
                 detail={"changed": {k: {"before": before.get(k), "after": after.get(k)} for k in changed[:30]}})
    return {"ok": True, "part": part, "value": after, "config_version": saved["config_version"], "changed": changed}


# -- the deployed agent ------------------------------------------------------------------------------------------------
def query_agent_runtime(resource: str, op: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Call the deployed agent the way the Studio flows do (:query)."""
    import google.auth
    from google.auth.transport.requests import AuthorizedSession

    creds, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
    region = resource.split("/locations/")[1].split("/")[0]
    resp = AuthorizedSession(creds).post(f"https://{region}-aiplatform.googleapis.com/v1/{resource}:query", timeout=60,
                                         json={"class_method": "query", "input": {"op": op, "payload": payload, "context": {"flow": "console"}}})
    if resp.status_code != 200:
        raise RuntimeError(f"HTTP {resp.status_code}: {resp.text[:300]}")
    return resp.json().get("output") or {}


@router.get("/agent-runtime")
def agent_runtime(ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_viewer)) -> dict[str, Any]:
    """Is the deployed agent answering, and is it on the same settings as the Console?"""
    resource = ctx.config.platform.gcp.agent_runtime_resource
    out: dict[str, Any] = {"resource": resource, "console_config_version": ctx.config_version, "reachable": False, "error": ""}
    if not resource:
        out["error"] = "No Agent Runtime is named in Settings, Project."
        return out
    if "/locations/" not in resource or "/reasoningEngines/" not in resource:
        out["error"] = "The resource should look like projects/NUMBER/locations/REGION/reasoningEngines/ID."
        return out
    try:
        answer = query_agent_runtime(resource, "health", {})
    except Exception as exc:  # noqa: BLE001 - shown on the page
        out["error"] = str(exc)[:400]
        return out
    data = answer.get("data") or {}
    out.update({"reachable": bool(answer.get("ok")), "agent_config_version": data.get("config_version"), "env": data.get("env"),
                "same_settings": data.get("config_version") == ctx.config_version, "error": answer.get("error") or ""})
    return out


# -- secrets -----------------------------------------------------------------------------------------------------------
class SecretBody(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    value: str = Field(..., min_length=1, max_length=65536)


class VersionBody(BaseModel):
    value: str = Field(..., min_length=1, max_length=65536)


class StateBody(BaseModel):
    state: Literal["ENABLED", "DISABLED", "DESTROYED"]


def _secrets(ctx: AgentContext, write: bool = False) -> Any:
    if write and not ctx.flag("secret_admin"):
        raise HTTPException(403, {"error": switch_off("Adding secrets from the Console", "secret_admin"), "code": "rejected"})
    try:
        return secret_admin.get_gateway(ctx)
    except Exception as exc:  # noqa: BLE001
        raise _reject(exc) from exc


def _secret_refs(ctx: AgentContext) -> dict[str, str]:
    """Which settings name a secret, so the page can show what each one is for."""
    cfg = ctx.config.platform
    refs = {cfg.temp_check.brandwatch_token_secret: "Brandwatch token (Temp check)"}
    oauth = os.environ.get("TRIAGE_OAUTH_CLIENT", "").rsplit("/", 1)[-1]
    if oauth:
        refs[oauth] = "Gmail OAuth client"
    return {k: v for k, v in refs.items() if k}


@router.get("/secrets")
def secrets_list(ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_admin)) -> dict[str, Any]:
    gw = _secrets(ctx)
    prefix = ctx.config.platform.gcp.secret_prefix
    try:
        rows = gw.list(prefix)
    except Exception as exc:  # noqa: BLE001
        raise _reject(exc) from exc
    refs = _secret_refs(ctx)
    for row in rows:
        row["used_for"] = refs.get(row["name"], "")
        row["gmail_token"] = row["name"].startswith("gmail-token-")
    missing = [{"name": n, "used_for": what} for n, what in refs.items() if n not in {r["name"] for r in rows}]
    return {"secrets": rows, "prefix": prefix, "missing": missing, "can_write": ctx.flag("secret_admin"),
            "backend": "Secret Manager" if os.environ.get("TRIAGE_BACKEND", "local") == "gcp" else "local file"}


@router.post("/secrets")
def secrets_create(body: SecretBody, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_admin)) -> dict[str, Any]:
    gw = _secrets(ctx, write=True)
    try:
        name = secret_admin.check_name(ctx, body.name)
        gw.create(name, body.value)
    except Exception as exc:  # noqa: BLE001
        raise _reject(exc, 422) from exc
    ctx.emit(P.SECRET_CHANGED, actor=user.email, space="console", payload={"name": name, "change": "created"})
    audit.record(ctx, actor=user.email, action="secret.create", surface="console", target_type="secret", target_id=name,
                 summary=f"Created secret {name} (value not recorded)")
    return {"ok": True, "name": name}


@router.get("/secrets/{name}/versions")
def secrets_versions(name: str, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_admin)) -> dict[str, Any]:
    gw = _secrets(ctx)
    try:
        return {"name": name, "versions": gw.versions(secret_admin.check_name(ctx, name))}
    except Exception as exc:  # noqa: BLE001
        raise _reject(exc, 422) from exc


@router.post("/secrets/{name}/versions")
def secrets_add_version(name: str, body: VersionBody, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_admin)) -> dict[str, Any]:
    gw = _secrets(ctx, write=True)
    try:
        out = gw.add_version(secret_admin.check_name(ctx, name), body.value)
    except Exception as exc:  # noqa: BLE001
        raise _reject(exc, 422) from exc
    ctx.emit(P.SECRET_CHANGED, actor=user.email, space="console", payload={"name": name, "change": "new_version", "version": out["version"]})
    audit.record(ctx, actor=user.email, action="secret.add_version", surface="console", target_type="secret", target_id=name,
                 summary=f"Added version {out['version']} to {name} (value not recorded)")
    return {"ok": True, **out}


@router.post("/secrets/{name}/versions/{version}")
def secrets_set_state(name: str, version: str, body: StateBody, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_admin)) -> dict[str, Any]:
    gw = _secrets(ctx, write=True)
    try:
        out = gw.set_version_state(secret_admin.check_name(ctx, name), version, body.state)
    except Exception as exc:  # noqa: BLE001
        raise _reject(exc, 422) from exc
    ctx.emit(P.SECRET_CHANGED, actor=user.email, space="console", payload={"name": name, "change": body.state.lower(), "version": version})
    audit.record(ctx, actor=user.email, action="secret.version_state", surface="console", target_type="secret", target_id=name,
                 summary=f"{name} version {version}: {body.state}")
    return {"ok": True, **out}


# -- BigQuery ----------------------------------------------------------------------------------------------------------
class DatasetBody(BaseModel):
    dataset: str = Field(..., min_length=1, max_length=300)
    location: str = Field("", max_length=40)
    description: str = Field("", max_length=1000)


class TableBody(BaseModel):
    table_id: str
    fields: list[dict[str, Any]]
    description: str = Field("", max_length=1000)
    partition_field: str = ""
    clustering: list[str] = Field(default_factory=list)


class TableUpdateBody(BaseModel):
    fields: list[dict[str, Any]] | None = None
    description: str | None = Field(None, max_length=1000)


class ViewBody(BaseModel):
    sql: str = Field(..., min_length=1, max_length=100000)
    description: str = Field("", max_length=1000)


class MappingBody(BaseModel):
    tables: dict[str, str]


def _bq(ctx: AgentContext) -> bq_admin.BigQueryGateway:
    try:
        return bq_admin.get_gateway(ctx)
    except Exception as exc:  # noqa: BLE001
        raise _reject(exc) from exc


def _bq_change(ctx: AgentContext, user: User, action: str, target: str, summary: str) -> None:
    ctx.emit(P.BIGQUERY_CHANGED, actor=user.email, space="console", payload={"action": action, "target": target})
    audit.record(ctx, actor=user.email, action=f"bigquery.{action}", surface="console", target_type="bigquery", target_id=target, summary=summary)


@router.get("/bigquery/status")
def bq_status(ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_viewer)) -> dict[str, Any]:
    cfg = ctx.config.platform.bigquery
    out: dict[str, Any] = {"settings": cfg.model_dump(mode="json"), "connected": False, "error": "", "can_admin": ctx.flag("bigquery_admin"),
                           "logical_tables": [{"key": k, "description": v["description"]} for k, v in bq_admin.STANDARD_TABLES.items()]
                           + [{"key": "volume", "description": "Optional: an hourly volume table of your own for the forecast (events is used otherwise)."}],
                           "events_table": bq_admin.table(ctx, "events") if (cfg.tables.get("events") or os.environ.get("TRIAGE_BQ_TABLE")) else ""}
    try:
        out.update({"connected": True, **bq_admin.get_gateway(ctx).test()})
    except Exception as exc:  # noqa: BLE001 - shown on the page with what to set
        out["error"] = str(exc)[:400]
    return out


@router.get("/bigquery/datasets")
def bq_datasets(ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_admin)) -> dict[str, Any]:
    try:
        return {"datasets": _bq(ctx).list_datasets()}
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise _reject(exc) from exc


@router.post("/bigquery/datasets")
def bq_create_dataset(body: DatasetBody, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_admin)) -> dict[str, Any]:
    gw = _bq(ctx)
    try:
        if not ctx.flag("bigquery_admin"):
            raise bq_admin.NotAllowed("Changing BigQuery from the Console is switched off (Switches → bigquery_admin).")
        out = gw.create_dataset(body.dataset, body.location or ctx.config.platform.bigquery.location, body.description)
    except Exception as exc:  # noqa: BLE001
        raise _reject(exc, 422) from exc
    _bq_change(ctx, user, "create_dataset", body.dataset, f"Created dataset {body.dataset}")
    return {"ok": True, "dataset": out}


@router.get("/bigquery/datasets/{dataset}/tables")
def bq_tables(dataset: str, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_admin)) -> dict[str, Any]:
    gw = _bq(ctx)
    try:
        return {"dataset": gw.get_dataset(dataset), "tables": gw.list_tables(dataset)}
    except Exception as exc:  # noqa: BLE001
        raise _reject(exc, 404) from exc


@router.get("/bigquery/tables/{table_id}")
def bq_table(table_id: str, preview: int = Query(0, ge=0, le=100), ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_admin)) -> dict[str, Any]:
    gw = _bq(ctx)
    try:
        out: dict[str, Any] = {"table": gw.get_table(table_id), "field_types": list(bq_admin.FIELD_TYPES)}
        if preview:
            out["rows"] = gw.preview(table_id, preview)
        return out
    except Exception as exc:  # noqa: BLE001
        raise _reject(exc, 404) from exc


@router.post("/bigquery/tables")
def bq_create_table(body: TableBody, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_admin)) -> dict[str, Any]:
    gw = _bq(ctx)
    try:
        bq_admin.require_admin(ctx, body.table_id)
        out = gw.create_table(body.table_id, body.fields, description=body.description, partition_field=body.partition_field,
                              clustering=body.clustering)
    except Exception as exc:  # noqa: BLE001
        raise _reject(exc, 422) from exc
    _bq_change(ctx, user, "create_table", body.table_id, f"Created table {body.table_id} ({len(body.fields)} columns)")
    return {"ok": True, "table": out}


@router.put("/bigquery/tables/{table_id}")
def bq_update_table(table_id: str, body: TableUpdateBody, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_admin)) -> dict[str, Any]:
    gw = _bq(ctx)
    try:
        bq_admin.require_admin(ctx, table_id)
        out = gw.update_table(table_id, fields=body.fields, description=body.description)
    except Exception as exc:  # noqa: BLE001
        raise _reject(exc, 422) from exc
    _bq_change(ctx, user, "update_table", table_id, f"Changed {table_id}" + (" (schema)" if body.fields is not None else " (description)"))
    return {"ok": True, "table": out}


@router.put("/bigquery/views/{view_id}")
def bq_save_view(view_id: str, body: ViewBody, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_admin)) -> dict[str, Any]:
    gw = _bq(ctx)
    try:
        bq_admin.require_admin(ctx, view_id)
        out = gw.save_view(view_id, body.sql, body.description)
    except Exception as exc:  # noqa: BLE001
        raise _reject(exc, 422) from exc
    _bq_change(ctx, user, "save_view", view_id, f"Saved view {view_id}")
    return {"ok": True, "table": out}


@router.post("/bigquery/provision")
def bq_provision(request: Request, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_admin)) -> dict[str, Any]:
    """Create the agent's own tables in its dataset (missing ones only) and map them."""
    try:
        steps = bq_admin.ensure_standard_tables(ctx)
    except Exception as exc:  # noqa: BLE001
        raise _reject(exc, 422) from exc
    mapping = dict(ctx.config.platform.bigquery.tables)
    for step in steps:
        if step.get("name") and not mapping.get(step["name"]):
            mapping[step["name"]] = step["step"]
    value = ctx.config.platform.bigquery.model_dump(mode="json")
    value["tables"] = mapping
    platform_put("bigquery", PartBody(value=value, note="Mapped the agent's tables after creating them"), request, ctx, user)
    _bq_change(ctx, user, "provision", ctx.config.platform.bigquery.dataset, "Created the agent's tables: " + ", ".join(f"{s['step']} ({s['detail']})" for s in steps))
    return {"ok": True, "steps": steps, "tables": mapping}


# -- delivery (Pub/Sub) --------------------------------------------------------------------------------------------------
class DiscardBody(BaseModel):
    reason: str = Field("", max_length=300)


@router.get("/delivery")
def delivery(ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_viewer)) -> dict[str, Any]:
    try:
        described = pubsub.describe(ctx)
    except Exception as exc:  # noqa: BLE001
        described = {"enabled": pubsub.enabled(ctx), "error": str(exc)[:300], "resources": []}
    recent = [r for r in ctx.store.list_docs(pubsub.OUTBOUND, limit=120) if "action" in r][:80]
    outbox = ctx.store.list_outbox(undelivered_only=True, limit=200)
    now = ctx.now()
    return {"status": described, "settings": ctx.config.platform.pubsub.model_dump(mode="json"),
            "outbox_doorbell": ctx.config.outbox.doorbell,
            "dead_letters": pubsub.list_dead_letters(ctx, include_resolved=False), "resolved": pubsub.list_dead_letters(ctx, include_resolved=True)[:50],
            "recent": recent, "counts": {s: sum(1 for r in recent if r.get("status") == s) for s in ("published", "delivered", "failed", "dead_lettered")},
            "outbox_waiting": [{"outbox_id": i.outbox_id, "target": i.target, "case_id": i.case_id, "source": i.source, "created_at": i.created_at,
                                "waiting_min": round((now - i.created_at).total_seconds() / 60, 1), "text": i.text[:300]} for i in outbox[:100]]}


@router.post("/delivery/provision")
def delivery_provision(ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_admin)) -> dict[str, Any]:
    try:
        steps = pubsub.provision(ctx)
    except Exception as exc:  # noqa: BLE001
        raise _reject(exc, 422) from exc
    audit.record(ctx, actor=user.email, action="delivery.provision", surface="console", target_type="pubsub", target_id="outbound",
                 summary="Created the topics and subscriptions: " + ", ".join(f"{s['step']} ({'ok' if s['ok'] else 'failed'})" for s in steps))
    return {"ok": all(s["ok"] for s in steps), "steps": steps}


@router.post("/delivery/dead-letters/{action_id}/replay")
def delivery_replay(action_id: str, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_lead)) -> dict[str, Any]:
    try:
        state = pubsub.replay(ctx, action_id, user.email)
    except KeyError as exc:
        raise HTTPException(404, {"error": "Unknown dead letter", "code": "not_found"}) from exc
    except Exception as exc:  # noqa: BLE001
        raise _reject(exc) from exc
    return {"ok": True, "state": state.model_dump(mode="json")}


@router.post("/delivery/dead-letters/{action_id}/discard")
def delivery_discard(action_id: str, body: DiscardBody, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_lead)) -> dict[str, Any]:
    try:
        pubsub.discard(ctx, action_id, user.email, body.reason)
    except KeyError as exc:
        raise HTTPException(404, {"error": "Unknown dead letter", "code": "not_found"}) from exc
    return {"ok": True}


# -- AI instructions (prompts and models) ----------------------------------------------------------------------------------
class PromptBody(BaseModel):
    system: str = Field("", max_length=60000)
    model: str = Field("", max_length=120)
    temperature: float | None = Field(None, ge=0, le=2)
    note: str = Field("", max_length=500)
    activate: bool = True


class ActivateBody(BaseModel):
    version: int | None = None


@router.get("/prompts")
def prompts_list(ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_viewer)) -> dict[str, Any]:
    return {"purposes": prompts.known_purposes(ctx), "models": ctx.config.models.model_dump(mode="json"), "can_edit": user.has("admin")}


@router.get("/prompts/{purpose}")
def prompts_get(purpose: str, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_viewer)) -> dict[str, Any]:
    versions = prompts.list_versions(ctx, purpose)
    return {"purpose": purpose, "description": prompts.PURPOSES.get(purpose, ""), "default_system": prompts.default_system(ctx, purpose),
            "versions": [v.model_dump(mode="json") for v in versions],
            "active_version": next((v.version for v in versions if v.active), None)}


@router.post("/prompts/{purpose}")
def prompts_publish(purpose: str, body: PromptBody, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_admin)) -> dict[str, Any]:
    if not (body.system.strip() or body.model.strip() or body.temperature is not None):
        raise HTTPException(422, {"error": "Change the instructions, the model or the temperature.", "code": "validation_error"})
    version = prompts.publish(ctx, purpose=purpose, system=body.system, model=body.model, temperature=body.temperature, note=body.note,
                              actor=user.email, activate=body.activate)
    return {"ok": True, "version": version.model_dump(mode="json")}


@router.post("/prompts/{purpose}/activate")
def prompts_activate(purpose: str, body: ActivateBody, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_admin)) -> dict[str, Any]:
    try:
        version = prompts.set_active(ctx, purpose, body.version, user.email)
    except KeyError as exc:
        raise HTTPException(404, {"error": str(exc), "code": "not_found"}) from exc
    return {"ok": True, "active_version": version.version if version else None}


# -- safety ------------------------------------------------------------------------------------------------------------
@router.get("/safety")
def safety_status(ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_viewer)) -> dict[str, Any]:
    checks = safety.run_checks(ctx)
    blocked = ctx.events.query(since=ctx.now() - timedelta(days=7), types=[P.SAFETY_BLOCKED], limit=200)
    stand_ins = safety.testing_recipients(ctx.config)
    return {"checks": [c.model_dump() for c in checks], "passed": all(c.passed or c.severity != "blocker" for c in checks),
            "blocked": [{"ts": e.event_ts, "case_id": e.case_id, "actor": e.actor, **(e.payload or {})} for e in blocked],
            "testing": {"on": stand_ins is not None, "recipients": len(stand_ins or [])},
            "stealth": ctx.config.burson_feedback.silent_in_burson_space, "as_of": ctx.now()}


# -- audit log ---------------------------------------------------------------------------------------------------------
def _audit_rows(ctx: AgentContext, actor: str | None, surface: str | None, action: str | None, case_id: str | None,
                status: str | None, q: str | None, days: int, limit: int) -> list[audit.AuditEntry]:
    return audit.search(ctx, actor=actor or None, surface=surface or None, action_prefix=action or None,
                        case_id=(case_id.upper() if case_id else None), status=status or None, q=q,
                        since=ctx.now() - timedelta(days=days), limit=limit)


@router.get("/audit")
def audit_log(actor: str | None = None, surface: str | None = None, action: str | None = None, case_id: str | None = None,
              status: str | None = None, q: str | None = None, days: int = Query(7, ge=1, le=400), limit: int = Query(200, ge=1, le=2000),
              ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_viewer)) -> dict[str, Any]:
    rows = _audit_rows(ctx, actor, surface, action, case_id, status, q, days, limit)
    return {"entries": [r.model_dump(mode="json") for r in rows],
            "surfaces": ["console", "chat_agent", "chat", "agent", "job", "pubsub", "system"],
            "statuses": ["ok", "error", "denied", "blocked"], "count": len(rows)}


@router.get("/audit.csv")
def audit_csv(actor: str | None = None, surface: str | None = None, action: str | None = None, case_id: str | None = None,
              status: str | None = None, q: str | None = None, days: int = Query(30, ge=1, le=400),
              ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_lead)) -> PlainTextResponse:
    out = io.StringIO()
    w = csv.writer(out)
    w.writerow(["time", "actor", "surface", "action", "status", "target_type", "target_id", "case_id", "summary"])
    for r in _audit_rows(ctx, actor, surface, action, case_id, status, q, days, 2000):
        w.writerow([r.ts.isoformat(), r.actor, r.surface, r.action, r.status, r.target_type, r.target_id, r.case_id or "", r.summary])
    ctx.audit(actor=user.email, action="audit.export", surface="console", target_type="audit", summary=f"Exported the audit log ({days} days)")
    return PlainTextResponse(out.getvalue(), media_type="text/csv", headers={"Content-Disposition": 'attachment; filename="audit-log.csv"'})


# -- costs -------------------------------------------------------------------------------------------------------------
@router.get("/costs")
def costs(days: int = Query(7, ge=1, le=90), ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_viewer)) -> dict[str, Any]:
    cfg = ctx.config.platform.costs
    events = ctx.events.query(since=ctx.now() - timedelta(days=days), types=[P.LLM_USAGE], env=ctx.config.env)
    out: dict[str, Any] = {"days": days, "ai": prompts.usage_summary(events, cfg.model_prices, cfg.currency),
                           "monthly_budget": cfg.monthly_budget, "billing": None, "billing_error": "",
                           "priced_models": sorted(cfg.model_prices)}
    if cfg.billing_export_table:
        try:
            table = bq_admin.check_table_id(cfg.billing_export_table)
            rows = bq_admin.get_gateway(ctx).query(
                f"SELECT service.description AS service, DATE(usage_start_time) AS day, ROUND(SUM(cost), 2) AS cost, ANY_VALUE(currency) AS currency\n"
                f"FROM `{table}` WHERE usage_start_time >= @since GROUP BY 1, 2 ORDER BY day",
                {"since": ctx.now() - timedelta(days=days)}, max_rows=5000)
            by_service: dict[str, float] = {}
            by_day: dict[str, float] = {}
            for r in rows:
                by_service[r["service"]] = round(by_service.get(r["service"], 0) + float(r["cost"] or 0), 2)
                by_day[str(r["day"])] = round(by_day.get(str(r["day"]), 0) + float(r["cost"] or 0), 2)
            out["billing"] = {"currency": rows[0]["currency"] if rows else cfg.currency, "total": round(sum(by_service.values()), 2),
                              "by_service": sorted(({"service": k, "cost": v} for k, v in by_service.items()), key=lambda x: -x["cost"]),
                              "by_day": [{"day": k, "cost": v} for k, v in sorted(by_day.items())]}
        except Exception as exc:  # noqa: BLE001 - the AI usage view still shows
            out["billing_error"] = str(exc)[:300]
    return out


# -- setup checklist ---------------------------------------------------------------------------------------------------
@router.get("/setup")
def setup_status(ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_viewer)) -> dict[str, Any]:
    """What is set up and what is still to do, in the order an admin does it."""
    from triage_agent import knowledge

    cfg = ctx.config
    plat = cfg.platform
    im = ctx.roster("slrr_im")
    from .connections import catalog

    tools = catalog(ctx)["summary"]
    steps = [
        {"key": "integrations", "title": "Connect the tools", "done": tools["ready"] == tools["required"],
         "detail": f"{tools['ready']} of {tools['required']} needed tools are set. Set up fills what the project already has and checks each tool.", "to": "/connections"},
        {"key": "admins", "title": "Add your people", "done": bool(cfg.admin_emails() or plat.access.bootstrap_admins),
         "detail": f"{len(cfg.admin_emails()) + len(plat.access.bootstrap_admins)} admin(s) named", "to": "/admin"},
        {"key": "roster", "title": "Give the IMs shifts", "done": bool(im.people and im.rotation), "detail": f"{len(im.people)} people, {len(im.rotation)} recurring slots", "to": "/workforce"},
        {"key": "distribution", "title": "Check distribution and recipients", "done": any(p.pa for p in cfg.distribution.products), "detail": "Who receives each product's Social Alert.", "to": "/settings/distribution"},
        {"key": "safety", "title": "Review safety settings", "done": all(c.passed for c in safety.run_checks(ctx) if c.severity == "blocker"), "detail": "Leak guard, Testing recipients, allow-lists.", "to": "/settings/safety"},
        {"key": "knowledge", "title": "Add knowledge docs", "done": bool(knowledge.list_docs(ctx)), "detail": "The documents the agent reads and cites.", "to": "/knowledge"},
        {"key": "flags", "title": "Turn on what you want", "done": any(plat.flags.model_dump().values()), "detail": "Every switch starts OFF.", "to": "/settings/flags"},
    ]
    return {"steps": steps, "done": sum(1 for s in steps if s["done"]), "total": len(steps), "is_admin": user.has("admin"),
            "env": cfg.env, "event_types": sorted([*E.all(), *P.all()])}
