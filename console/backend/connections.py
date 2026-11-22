"""Integrations: every tool the agent uses, connected in one place.

Each tool lists the few values it needs, whether they are set, and a live check of the access the Console's account
has. Find and fill writes what the running service can see for itself (the project, the region, its own address, the
one Agent Runtime, the dataset that holds the agent's tables), so only what a person alone knows is left to enter.
Values are saved to the same settings the rest of the Console edits; a check's result is kept until its values change.
"""

from __future__ import annotations

import copy
import hashlib
import json
import logging
import os
import time
from dataclasses import dataclass
from typing import Any, Callable

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field, ValidationError

from triage_agent import audit, bq_admin, chatapi, chatlog, knowledge, pubsub, secret_admin
from triage_agent.config import switch_off, switch_title
from triage_agent.context import AgentContext

from . import gmail_oauth
from .auth import User, get_ctx, require_admin, require_viewer
from .routes_settings import format_errors, save_sections

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["connections"])
TEST_KV = "connection:test:"


@dataclass(frozen=True)
class F:
    path: str  # where the value lives in the settings; a Chat space is spaces.<key>.url
    label: str
    required: bool = False  # the tool is not connected without it
    help: str = ""
    options: str = ""  # a list the project can supply: datasets | topics | subscriptions | runtimes | secrets
    alt: str = ""  # a second place that counts as set (a space's id)
    choices: tuple[str, ...] = ()


@dataclass(frozen=True)
class Tool:
    key: str
    name: str
    what: str
    required: bool  # the agent cannot work without it
    fields: tuple[F, ...]
    uses: tuple[str, ...]
    access: str  # what the Console's account needs, in a sentence
    settings: str = ""  # where its tuning values live
    create: str = ""  # the route that creates what it needs, when the Console can


def _spaces(ctx: AgentContext) -> tuple[F, ...]:
    return tuple(F(f"spaces.{s.key}.url", f"{s.display_name} space", required=s.key in ("burson", "clean"), alt=f"spaces.{s.key}.space_id",
                   help="The space's link from Chat.") for s in ctx.config.spaces)


def tools(ctx: AgentContext) -> list[Tool]:
    return [
        Tool("gcp", "Google Cloud", "The project and region everything runs in.", True,
             (F("platform.gcp.project", "Project", True), F("platform.gcp.region", "Region", True),
              F("platform.gcp.console_url", "This Console's address", help="Used in links the agent posts.")),
             ("Everything",), "Nothing to grant: the Console runs in this project."),
        Tool("gemini", "Gemini", "Reads each alert, drafts emails and answers in Chat.", True,
             (F("models.triage", "Model for alerts", True), F("models.drafting", "Model for drafts", True),
              F("models.converse", "Model for answers", True), F("models.location", "Where Gemini runs", True),
              F("platform.knowledge.embedding_model", "Embedding model", help="Stories and knowledge match by meaning when set.")),
             ("Triage", "Email drafts", "Chat answers", "Stories"), "Vertex AI User on the project.", "/settings/models"),
        Tool("runtime", "Agent Runtime", "The deployed agent the Chat flows call.", True,
             (F("platform.gcp.agent_runtime_resource", "Agent Runtime", True, options="runtimes"),),
             ("Chat", "Scheduled work"), "Vertex AI User on the project."),
        Tool("chat", "Google Chat", "The spaces the QA chatbot reads and posts in.", True,
             (F("agent.email", "The QA chatbot's account", True, help="The Google account the QA chatbot reads and posts as."), *_spaces(ctx)),
             ("Alerts in", "Posts out"), "The QA chatbot's account is a member of each space.", "/settings/spaces"),
        Tool("bigquery", "BigQuery", "Keeps events and audit entries, and runs forecasts and watches.", True,
             (F("platform.bigquery.dataset", "Dataset", True, options="datasets", help="The agent's own dataset."),
              F("platform.bigquery.location", "Location"), F("platform.bigquery.project", "Project", help="Blank: the Cloud project.")),
             ("Event log", "Workforce forecast", "Watches", "Costs"), "BigQuery Data Editor on the dataset and BigQuery Job User on the project.",
             "/settings/bigquery", "/api/bigquery/provision"),
        Tool("delivery", "Delivery", "How the agent's posts and emails go out, with retries.", False,
             (F("outbox.doorbell", "How Chat is told a post is waiting", True, choices=("none", "sheet", "email"), help="A row in a sheet, an email, or none."),
              F("platform.pubsub.outbound_topic", "Outbound topic", options="topics"),
              F("platform.pubsub.dead_letter_topic", "Dead-letter topic", options="topics"),
              F("platform.pubsub.outbound_subscription", "Outbound subscription", options="subscriptions"),
              F("platform.pubsub.dead_letter_subscription", "Dead-letter subscription", options="subscriptions"),
              F("platform.pubsub.worker_url", "Worker address"), F("platform.pubsub.push_service_account", "Account that calls the worker")),
             ("Posts to Chat", "Trying again when a post fails"), "Pub/Sub Editor on the project.", "/settings/pubsub", "/api/delivery/provision"),
        Tool("secrets", "Secret Manager", "Holds tokens. Settings keep a secret's name, never its value.", False,
             (F("platform.gcp.secret_prefix", "Name prefix", help="Only secrets whose name starts with this are shown."),),
             ("Brandwatch token",), "Secret Manager Admin on the project.", "/settings/secrets"),
        Tool("gmail", "Gmail", "Each IM's Social Alert drafts are created in their own mailbox.", False, (),
             ("Email drafts",), "Each person connects their own mailbox from the top bar."),
        Tool("drive", "Google Drive", "Reads knowledge docs and keeps temp check write-ups.", False,
             (F("platform.temp_check.docs_folder_id", "Folder for write-ups", True, help="The folder's id from its link."),),
             ("Temp checks", "Knowledge"), "The Console's account is an Editor of the folder."),
        Tool("brandwatch", "Brandwatch", "Mention volumes and posts for temp checks.", False,
             (F("platform.temp_check.brandwatch_project_id", "Project id", True),
              F("platform.temp_check.brandwatch_token_secret", "Token secret", True, options="secrets", help="The secret that holds the API token."),
              F("platform.temp_check.brandwatch_api_base", "API address")),
             ("Temp checks",), "A Brandwatch API token, kept in Secret Manager.", "/settings/temp_check"),
        Tool("inhouse", "Sonar and DSD tables", "The tables in-house detection reads.", False,
             (F("inhouse.sonar_table", "Sonar table", True), F("inhouse.outbox_view", "Story selection view", True),
              F("inhouse.alert_log_table", "Alert log table", True), F("inhouse.project", "Project that runs the queries", True),
              F("inhouse.location", "Location"), F("inhouse.sonar_location", "Sonar location")),
             ("In-house detection", "Comparison with Burson"), "BigQuery Data Viewer on each table's dataset.", "/settings/config.inhouse"),
        Tool("campaigns", "Campaigns service", "Campaign briefs and the watches built on them.", False,
             (F("platform.campaigns.firestore_project", "Project", True), F("platform.campaigns.firestore_database", "Database", True),
              F("platform.campaigns.watch_ai_connection", "BigQuery connection for AI functions")),
             ("Campaigns", "Watches"), "Cloud Datastore User on the campaigns project.", "/settings/campaigns"),
    ]


def tool(ctx: AgentContext, key: str) -> Tool:
    for t in tools(ctx):
        if t.key == key:
            return t
    raise HTTPException(404, {"error": f"No integration '{key}'", "code": "not_found"})


# -- reading and writing a value by its path -------------------------------------------------------------------------------------
def _step(node: Any, part: str) -> Any:
    if isinstance(node, list):
        return next((item for item in node if isinstance(item, dict) and item.get("key") == part), None)
    return node.get(part) if isinstance(node, dict) else None


def read(settings: dict[str, Any], path: str) -> Any:
    node: Any = settings
    for part in path.split("."):
        node = _step(node, part)
        if node is None:
            return None
    return node


def write(settings: dict[str, Any], path: str, value: Any) -> None:
    parts = path.split(".")
    node: Any = settings
    for part in parts[:-1]:
        nxt = _step(node, part)
        if nxt is None:
            raise KeyError(path)
        node = nxt
    if not isinstance(node, dict):
        raise KeyError(path)
    node[parts[-1]] = value


def _is_set(settings: dict[str, Any], f: F) -> bool:
    return any(str(read(settings, p) or "").strip() not in ("", "none") for p in (f.path, f.alt) if p)


# -- state ---------------------------------------------------------------------------------------------------------------------
def _fingerprint(settings: dict[str, Any], t: Tool) -> str:
    return hashlib.sha256(json.dumps([[f.path, read(settings, f.path)] for f in t.fields], default=str).encode()).hexdigest()[:16]


def _gmail_facts(ctx: AgentContext) -> dict[str, Any]:
    mod = gmail_oauth.gmail_module()
    mode = (os.environ.get("TRIAGE_GMAIL") or "fake").strip().lower()
    emails = sorted({a.email.lower() for a in ctx.config.analysts})
    connected = 0
    if mod is not None:
        for email in emails:
            try:
                connected += 1 if gmail_oauth._is_connected(ctx, mod, email) else 0
            except Exception:  # noqa: BLE001 - counted as not connected
                pass
    return {"available": mod is not None, "mode": mode, "oauth_client": bool(os.environ.get("TRIAGE_OAUTH_CLIENT")),
            "people": len(emails), "connected": connected}


def state_of(ctx: AgentContext, t: Tool, settings: dict[str, Any] | None = None) -> dict[str, Any]:
    settings = settings if settings is not None else ctx.config.model_dump(mode="json")
    fields = [{"path": f.path, "label": f.label, "required": f.required, "help": f.help, "options": f.options, "choices": list(f.choices),
               "value": read(settings, f.path), "set": _is_set(settings, f)} for f in t.fields]
    needed = [f for f in fields if f["required"]]
    missing = [f["label"] for f in needed if not f["set"]]
    kept = ctx.store.get_kv(TEST_KV + t.key) or {}
    test = {k: kept.get(k) for k in ("ok", "message", "details", "at", "by")} if kept.get("fingerprint") == _fingerprint(settings, t) else None
    facts: list[dict[str, Any]] = []
    if t.key == "gmail":
        g = _gmail_facts(ctx)
        usable = g["available"] and (g["mode"] == "fake" or g["oauth_client"])
        facts = [{"label": "People connected", "value": f"{g['connected']} of {g['people']}"},
                 {"label": "Sign-in", "value": "simulated (TRIAGE_GMAIL=fake)" if g["mode"] == "fake" else ("set up" if g["oauth_client"] else "not set up")}]
        if not usable:
            missing = ["A Google sign-in client for Gmail (set at deploy)"]
    signin = t.key == "chat"
    if signin:
        signed = chatapi.signed_in(ctx)
        facts = [{"label": "QA chatbot signed in to Chat", "value": f"Yes, as {ctx.config.agent.email}" if signed else "No"}]
    if missing:
        state = "incomplete" if t.required or any(f["set"] for f in needed) else "not_connected"
    elif test is None:
        state = "ready"
    else:
        state = "connected" if test["ok"] else "failing"
    steps = ([{"key": "values", "title": "Choose its values" if any(f["options"] for f in fields) else "Enter its values"}] if fields else
             [{"key": "people", "title": "Each person connects their own mailbox"}])
    if signin:
        steps.append({"key": "signin", "title": "Sign in as the QA chatbot"})
    if t.create:
        steps.append({"key": "create", "title": "Create what is missing"})
    steps.append({"key": "test", "title": "Check access"})
    return {"key": t.key, "name": t.name, "what": t.what, "required": t.required, "uses": list(t.uses), "access": t.access,
            "settings": t.settings, "create": t.create, "fields": fields, "missing": missing, "state": state, "test": test,
            "facts": facts, "steps": steps}


def catalog(ctx: AgentContext) -> dict[str, Any]:
    settings = ctx.config.model_dump(mode="json")
    rows = [state_of(ctx, t, settings) for t in tools(ctx)]
    needed = [r for r in rows if r["required"]]
    return {"connections": rows, "backend": os.environ.get("TRIAGE_BACKEND", "local"),
            "summary": {"required": len(needed), "ready": sum(1 for r in needed if r["state"] in ("ready", "connected")),
                        "connected": sum(1 for r in rows if r["state"] == "connected"),
                        "failing": sum(1 for r in rows if r["state"] == "failing"), "total": len(rows)}}


@router.get("/connections")
def get_connections(ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_viewer)) -> dict[str, Any]:
    return {**catalog(ctx), "is_admin": user.has("admin")}


# -- saving --------------------------------------------------------------------------------------------------------------------
class ValuesBody(BaseModel):
    values: dict[str, Any] = Field(default_factory=dict)


def _apply(request: Request, ctx: AgentContext, user: User, changes: dict[str, Any], note: str) -> AgentContext:
    settings = ctx.config.model_dump(mode="json")
    for path, value in changes.items():
        try:
            write(settings, path, value.strip() if isinstance(value, str) else value)
        except KeyError as exc:
            raise HTTPException(422, {"error": f"There is no setting at {path}", "code": "validation_error"}) from exc
    sections = sorted({p.split(".")[0] for p in changes})
    try:
        return save_sections(request, ctx, user, {s: settings[s] for s in sections}, note)
    except ValidationError as exc:
        raise HTTPException(422, {"error": "That value was not accepted", "code": "validation_error", "errors": format_errors(exc, "")}) from exc


@router.put("/connections/{key}")
def put_connection(key: str, body: ValuesBody, request: Request, ctx: AgentContext = Depends(get_ctx),
                   user: User = Depends(require_admin)) -> dict[str, Any]:
    t = tool(ctx, key)
    own = {p for f in t.fields for p in (f.path, f.alt) if p}
    foreign = sorted(set(body.values) - own)
    if foreign or not body.values:
        raise HTTPException(422, {"error": f"{t.name} does not hold {', '.join(foreign)}" if foreign else "Nothing to save", "code": "validation_error"})
    before = ctx.config.model_dump(mode="json")
    fresh = _apply(request, ctx, user, body.values, f"{t.name} connected in the Console")
    after = fresh.config.model_dump(mode="json")
    changed = sorted(p for p in body.values if read(before, p) != read(after, p))
    audit.record(fresh, actor=user.email, action="connection.save", surface="console", target_type="connection", target_id=t.key,
                 summary=f"{t.name}: set {', '.join(changed) or 'nothing new'}",
                 detail={"changed": {p: {"before": read(before, p), "after": read(after, p)} for p in changed}})
    return {"ok": True, "changed": changed, "connection": state_of(fresh, tool(fresh, key))}


@router.delete("/connections/{key}")
def disconnect(key: str, request: Request, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_admin)) -> dict[str, Any]:
    from .routes_settings import default_config

    t = tool(ctx, key)
    if t.required:
        raise HTTPException(422, {"error": f"{t.name} is needed for the agent to work. Change its values instead.", "code": "validation_error"})
    if not t.fields:
        raise HTTPException(422, {"error": f"{t.name} is connected per person: each person disconnects their own.", "code": "validation_error"})
    defaults = default_config()[1]
    fresh = _apply(request, ctx, user, {f.path: read(defaults, f.path) for f in t.fields}, f"{t.name} disconnected in the Console")
    fresh.store.put_kv(TEST_KV + t.key, {})
    audit.record(fresh, actor=user.email, action="connection.disconnect", surface="console", target_type="connection", target_id=t.key,
                 summary=f"{t.name}: disconnected (its values are back to their defaults)")
    return {"ok": True, "connection": state_of(fresh, tool(fresh, key))}


# -- live checks ---------------------------------------------------------------------------------------------------------------
def _on_cloud() -> bool:
    return os.environ.get("TRIAGE_BACKEND", "local") == "gcp"


def _detail(label: str, run: Callable[[], str]) -> dict[str, Any]:
    try:
        return {"label": label, "ok": True, "message": run()}
    except Exception as exc:  # noqa: BLE001 - the reason is the result
        return {"label": label, "ok": False, "message": str(exc)[:400]}


LOCAL = "This Console runs on its local store (TRIAGE_BACKEND=local): Google Cloud is not reached from here."


def _need_cloud() -> None:
    if not _on_cloud():
        raise RuntimeError(LOCAL)


def _identity() -> tuple[Any, str]:
    import google.auth

    return google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])


def _check_gcp(ctx: AgentContext) -> list[dict[str, Any]]:
    g = ctx.config.platform.gcp

    def project() -> str:
        _need_cloud()
        creds, found = _identity()
        if found and found != g.project:
            raise RuntimeError(f"The Console runs in {found}, and Settings name {g.project}.")
        return f"{g.project}, as {getattr(creds, 'service_account_email', '') or 'the service account'}"

    return [_detail("Project", project), {"label": "Region", "ok": bool(g.region), "message": g.region or "not set"}]


def _check_gemini(ctx: AgentContext) -> list[dict[str, Any]]:
    m = ctx.config.models
    simulated = " (simulated: TRIAGE_LLM=fake)" if (os.environ.get("TRIAGE_LLM") or "").lower() == "fake" else ""
    out, asked = [], {}
    for label, model in (("Model for alerts", m.triage), ("Model for drafts", m.drafting), ("Model for answers", m.converse)):
        if model not in asked:
            def ask(model: str = model) -> str:
                started = time.monotonic()
                answer = ctx.llm.generate_text(model=model, system="This is a connection test.", prompt="Reply with the single word OK.",
                                               temperature=0.0, purpose="connection.test")
                if not str(answer or "").strip():
                    raise RuntimeError(f"{model} returned nothing.")
                return f"{model} answered in {int((time.monotonic() - started) * 1000)} ms{simulated}"
            asked[model] = _detail(label, ask)
        out.append({**asked[model], "label": label})
    if ctx.config.platform.knowledge.embedding_model:
        def embed() -> str:
            vectors = knowledge.embed(ctx, ["connection test"])
            if not vectors:
                raise RuntimeError(f"{ctx.config.platform.knowledge.embedding_model} returned no vector.")
            return f"{len(vectors[0])} dimensions"
        out.append(_detail("Embedding model", embed))
    return out


def _check_runtime(ctx: AgentContext) -> list[dict[str, Any]]:
    from .routes_admin import query_agent_runtime

    resource = ctx.config.platform.gcp.agent_runtime_resource

    def health() -> str:
        if "/locations/" not in resource or "/reasoningEngines/" not in resource:
            raise RuntimeError("It should look like projects/NUMBER/locations/REGION/reasoningEngines/ID.")
        _need_cloud()
        answer = query_agent_runtime(resource, "health", {})
        if not answer.get("ok"):
            raise RuntimeError(answer.get("error") or "The agent did not answer its health check.")
        theirs = (answer.get("data") or {}).get("config_version")
        if theirs != ctx.config_version:
            raise RuntimeError(f"It answers, on older settings ({theirs}). It picks up the Console's settings within a minute; deploy again if it does not.")
        return "Answering, on the same settings as the Console."

    return [_detail("Agent Runtime", health)]


def _check_chat(ctx: AgentContext) -> list[dict[str, Any]]:
    bot = ctx.config.agent.email
    out = [{"label": "The QA chatbot's account", "ok": bool(bot), "message": bot or "not set"}]
    spaces = [s for s in ctx.config.spaces if s.space_id or s.url]
    now = ctx.now()
    if not chatapi.signed_in(ctx):
        out.append({"label": "Signed in to Chat", "ok": False, "message": "The QA chatbot is not signed in to Chat. Use Sign in as the QA chatbot, then check again."})
        for s in spaces:  # what the Chat flows have handed over so far
            seen = chatlog.search(ctx, space_key=s.key, limit=1)
            if seen:
                out.append({"label": f"{s.display_name} space", "ok": True, "message": f"Last message handed over {int((now - seen[0].ts).total_seconds() / 60)} min ago."})
        return out
    out.append({"label": "Signed in to Chat", "ok": True, "message": f"As {bot}."})
    try:
        client = chatapi.client_for(ctx)
    except Exception as exc:  # noqa: BLE001 - the sign-in was withdrawn, or Google can't be reached
        return [*out[:1], {"label": "Signed in to Chat", "ok": False, "message": str(exc)[:300]}]
    for s in spaces:
        name = chatapi.space_name(s.space_id, s.url)
        try:
            info = client.get_space(name)
            latest = client.latest_message(name, now)
        except chatapi.ChatError as exc:
            message = f"Add {bot} to this space, then check again. Chat said: {exc}" if exc.status in (403, 404) else f"Chat said: {exc}"
            out.append({"label": f"{s.display_name} space", "ok": False, "message": message})
            continue
        when = f"Latest message {int((now - latest['create_time']).total_seconds() / 60)} min ago." if latest else "No message in it yet."
        who = "People outside Google can join this space." if info["external"] else "Only Google people can join."
        out.append({"label": f"{s.display_name} space", "ok": True, "message": f"{when} {who}"})
    return out


def _check_bigquery(ctx: AgentContext) -> list[dict[str, Any]]:
    cfg = ctx.config.platform.bigquery
    state: dict[str, Any] = {}

    def signed_in() -> str:
        _need_cloud()
        state["gw"] = bq_admin.get_gateway(ctx)
        info = state["gw"].test()
        state["who"] = info.get("identity")
        return f"Queries run in {info['project']} as {info.get('identity')}."

    out = [_detail("Queries", signed_in)]
    if "gw" not in state:
        return out
    gw = state["gw"]
    dataset = cfg.dataset if "." in cfg.dataset else f"{gw.project}.{cfg.dataset}"
    out.append(_detail("Dataset", lambda: f"{dataset} in {gw.get_dataset(dataset).get('location', 'its location')}."))
    events = bq_admin.table(ctx, "events")
    if events:
        out.append(_detail("Events table", lambda: f"{events}: {gw.get_table(events).get('rows') or 0} rows."))
    else:
        out.append({"label": "Events table", "ok": False, "message": "Not created yet. Use Create what is missing."})
    return out


def _check_inhouse(ctx: AgentContext) -> list[dict[str, Any]]:
    cfg = ctx.config.inhouse
    out: list[dict[str, Any]] = []
    who = ""
    try:
        _need_cloud()
        gw = bq_admin.get_gateway(ctx)
        who = str(gw.test().get("identity") or "")
    except Exception as exc:  # noqa: BLE001
        return [{"label": "Queries", "ok": False, "message": str(exc)[:400]}]
    for label, table_id, location in (("Sonar table", cfg.sonar_table, cfg.sonar_location), ("Story selection view", cfg.outbox_view, cfg.location),
                                      ("Alert log table", cfg.alert_log_table, cfg.location)):
        def scan(table_id: str = table_id, location: str = location) -> str:
            try:
                size = gw.dry_run(f"SELECT * FROM `{bq_admin.check_table_id(table_id)}` LIMIT 1", location=location or None)
            except Exception as exc:  # noqa: BLE001
                text = str(exc)
                if "Access Denied" in text or "403" in text:
                    dataset = ".".join(table_id.split(".")[:2])
                    raise RuntimeError(f"Access denied. The dataset's owners run: GRANT `roles/bigquery.dataViewer` ON SCHEMA "
                                       f"`{dataset.replace('.', '`.`')}` TO \"serviceAccount:{who}\"") from exc
                raise
            return f"Readable ({size:,} bytes for a full read)."
        out.append(_detail(label, scan))
    return out


def _check_delivery(ctx: AgentContext) -> list[dict[str, Any]]:
    ps = ctx.config.platform.pubsub
    out = [{"label": "How Chat is told a post is waiting", "ok": ctx.config.outbox.doorbell != "none", "message": ctx.config.outbox.doorbell}]
    if not ps.outbound_topic:
        return out + [{"label": "Pub/Sub", "ok": True, "message": "No topic is named: posts go out through the doorbell alone."}]

    def described() -> list[dict[str, Any]]:
        _need_cloud()
        return pubsub.describe(ctx)["resources"]

    try:
        for r in described():
            out.append({"label": f"{r['kind'].capitalize()} {r['name']}", "ok": bool(r.get("exists")),
                        "message": "Exists." if r.get("exists") else (r.get("error") or "Not found. Use Create what is missing.")})
    except Exception as exc:  # noqa: BLE001
        out.append({"label": "Pub/Sub", "ok": False, "message": str(exc)[:400]})
    out.append({"label": "Switch", "ok": ctx.config.platform.flags.pubsub_delivery,
                "message": f'"{switch_title("pubsub_delivery")}" is ON.' if ctx.config.platform.flags.pubsub_delivery else switch_off("Retrying through Pub/Sub", "pubsub_delivery")})
    return out


def _check_secrets(ctx: AgentContext) -> list[dict[str, Any]]:
    def listed() -> str:
        found = secret_admin.get_gateway(ctx).list(ctx.config.platform.gcp.secret_prefix)
        return f"{len(found)} secret(s) readable."

    return [_detail("Secrets", listed)]


def _check_gmail(ctx: AgentContext) -> list[dict[str, Any]]:
    g = _gmail_facts(ctx)
    return [{"label": "Sign-in", "ok": g["available"] and (g["mode"] == "fake" or g["oauth_client"]),
             "message": "Simulated (TRIAGE_GMAIL=fake): drafts stay in memory." if g["mode"] == "fake" else
             ("Set up." if g["oauth_client"] else "No Google sign-in client is set (TRIAGE_OAUTH_CLIENT at deploy).")},
            {"label": "People connected", "ok": g["connected"] > 0, "message": f"{g['connected']} of {g['people']}"}]


def _check_drive(ctx: AgentContext) -> list[dict[str, Any]]:
    folder = ctx.config.platform.temp_check.docs_folder_id

    def can_write() -> str:
        _need_cloud()
        import google.auth
        from googleapiclient.discovery import build

        creds, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/drive.readonly"])
        info = build("drive", "v3", credentials=creds, cache_discovery=False).files().get(
            fileId=folder, fields="id,name,capabilities(canAddChildren)", supportsAllDrives=True).execute()
        if not (info.get("capabilities") or {}).get("canAddChildren"):
            raise RuntimeError(f"The Console's account can read '{info.get('name')}' and cannot add files. Share the folder with it as Editor.")
        return f"'{info.get('name')}': write-ups can be saved here."

    return [_detail("Folder for write-ups", can_write)]


def _check_brandwatch(ctx: AgentContext) -> list[dict[str, Any]]:
    def token() -> str:
        from triage_agent.tempcheck import Brandwatch

        bw = Brandwatch(ctx)
        body = bw.get(f"/projects/{bw.project}/queries?pageSize=1")
        return f"Token accepted. {body.get('resultsTotal', len(body.get('results') or []))} saved queries in the project."

    return [_detail("API token", token)]


def _check_campaigns(ctx: AgentContext) -> list[dict[str, Any]]:
    def listed() -> str:
        from triage_agent import campaigns_admin

        _need_cloud()
        return f"{len(campaigns_admin.list_campaigns(ctx))} campaign(s) readable."

    return [_detail("Campaigns", listed)]


CHECKS: dict[str, Callable[[AgentContext], list[dict[str, Any]]]] = {
    "gcp": _check_gcp, "gemini": _check_gemini, "runtime": _check_runtime, "chat": _check_chat, "bigquery": _check_bigquery,
    "inhouse": _check_inhouse, "delivery": _check_delivery, "secrets": _check_secrets, "gmail": _check_gmail, "drive": _check_drive,
    "brandwatch": _check_brandwatch, "campaigns": _check_campaigns,
}


@router.post("/connections/{key}/test")
def test_connection(key: str, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_admin)) -> dict[str, Any]:
    t = tool(ctx, key)
    settings = ctx.config.model_dump(mode="json")
    current = state_of(ctx, t, settings)
    if current["missing"]:
        result = {"ok": False, "message": f"Set these first: {', '.join(current['missing'])}.", "details": [], "at": ctx.now().isoformat(), "by": user.email}
        return {"test": result, "connection": current}
    details = CHECKS[t.key](ctx)
    failed = [d for d in details if not d["ok"]]
    result = {"ok": not failed, "details": details, "at": ctx.now().isoformat(), "by": user.email,
              "message": "Connected." if not failed else f"{failed[0]['label']}: {failed[0]['message']}"}
    ctx.store.put_kv(TEST_KV + t.key, {**result, "fingerprint": _fingerprint(settings, t)})
    audit.record(ctx, actor=user.email, action="connection.test", surface="console", target_type="connection", target_id=t.key,
                 status="ok" if result["ok"] else "error", summary=f"{t.name}: {result['message']}"[:300])
    return {"test": result, "connection": state_of(ctx, t, settings)}


# -- what the project can supply ---------------------------------------------------------------------------------------------------
def _project(ctx: AgentContext) -> str:
    return (ctx.config.platform.gcp.project or os.environ.get("TRIAGE_PROJECT_ID") or os.environ.get("GOOGLE_CLOUD_PROJECT") or "").strip()


def _region(ctx: AgentContext) -> str:
    return (ctx.config.platform.gcp.region or os.environ.get("TRIAGE_REGION") or os.environ.get("GOOGLE_CLOUD_REGION") or "").strip()


def _runtimes(ctx: AgentContext) -> list[str]:
    from google.auth.transport.requests import AuthorizedSession

    project, region = _project(ctx), _region(ctx)
    if not (project and region):
        raise RuntimeError("Set the project and region first.")
    creds, _ = _identity()
    resp = AuthorizedSession(creds).get(f"https://{region}-aiplatform.googleapis.com/v1/projects/{project}/locations/{region}/reasoningEngines",
                                        timeout=30)
    if resp.status_code != 200:
        raise RuntimeError(f"HTTP {resp.status_code}: {resp.text[:200]}")
    return [f"{e['name']}|{e.get('displayName') or ''}" for e in resp.json().get("reasoningEngines") or []]


def _pubsub_names(ctx: AgentContext, kind: str) -> list[str]:
    body = pubsub._Rest().call("GET", f"projects/{pubsub.project_id(ctx)}/{kind}")
    return [str(x.get("name") if isinstance(x, dict) else x).rsplit("/", 1)[-1] for x in body.get(kind) or []]


def options(ctx: AgentContext, name: str) -> list[dict[str, str]]:
    """The values the project already has for a field: [{value, label}]."""
    _need_cloud()
    if name == "datasets":
        gw = bq_admin.get_gateway(ctx)
        return [{"value": d["full_id"], "label": d["dataset"]} for d in gw.list_datasets()]
    if name == "runtimes":
        return [{"value": r.split("|")[0], "label": r.split("|")[1] or r.split("|")[0].rsplit("/", 1)[-1]} for r in _runtimes(ctx)]
    if name in ("topics", "subscriptions"):
        return [{"value": n, "label": n} for n in _pubsub_names(ctx, name)]
    if name == "secrets":
        return [{"value": str(s.get("name")), "label": str(s.get("name"))} for s in secret_admin.get_gateway(ctx).list(ctx.config.platform.gcp.secret_prefix)]
    raise KeyError(name)


@router.get("/connections/{key}/options")
def get_options(key: str, field: str, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_admin)) -> dict[str, Any]:
    t = tool(ctx, key)
    f = next((x for x in t.fields if x.path == field), None)
    if f is None or not f.options:
        raise HTTPException(404, {"error": "Nothing to list for that field", "code": "not_found"})
    try:
        return {"options": options(ctx, f.options), "error": ""}
    except Exception as exc:  # noqa: BLE001 - the field can still be typed
        return {"options": [], "error": str(exc)[:300]}


def _cloud_run_region() -> str:
    import requests

    resp = requests.get("http://metadata.google.internal/computeMetadata/v1/instance/region", headers={"Metadata-Flavor": "Google"}, timeout=3)
    return resp.text.strip().rsplit("/", 1)[-1] if resp.status_code == 200 else ""


@router.post("/connections/autofill")
def autofill(request: Request, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_admin)) -> dict[str, Any]:
    """Find and fill: write every empty value the running service can see for itself. Nothing already set is changed."""
    settings = ctx.config.model_dump(mode="json")
    found: dict[str, Any] = {}
    notes: list[str] = []

    def offer(path: str, finder: Callable[[], Any], what: str) -> None:
        if str(read(settings, path) or "").strip():
            return
        try:
            value = finder()
        except Exception as exc:  # noqa: BLE001 - reported, and the field stays for a person
            notes.append(f"{what}: {str(exc)[:200]}")
            return
        if value:
            found[path] = value
            write(settings, path, value)

    offer("platform.gcp.project", lambda: os.environ.get("TRIAGE_PROJECT_ID") or os.environ.get("GOOGLE_CLOUD_PROJECT") or (_identity()[1] if _on_cloud() else ""), "Project")
    offer("platform.gcp.region", lambda: os.environ.get("TRIAGE_REGION") or os.environ.get("GOOGLE_CLOUD_REGION") or (_cloud_run_region() if os.environ.get("K_SERVICE") else ""), "Region")
    if os.environ.get("K_SERVICE"):
        offer("platform.gcp.console_url", lambda: str(request.base_url).rstrip("/").replace("http://", "https://"), "This Console's address")
    if _on_cloud():
        probe = copy.copy(ctx)
        probe.config = ctx.config.model_validate(settings)

        def one_runtime() -> str:
            names = [r.split("|")[0] for r in _runtimes(probe)]
            if len(names) > 1:
                raise RuntimeError(f"{len(names)} Agent Runtimes exist: choose one under Agent Runtime.")
            return names[0] if names else ""

        def own_dataset() -> str:
            gw = bq_admin.get_gateway(probe)
            holding = []
            for d in gw.list_datasets()[:40]:
                try:
                    gw.get_table(f"{d['full_id']}.agent_events")
                    holding.append(d["full_id"])
                except Exception:  # noqa: BLE001 - this dataset does not hold the agent's tables
                    continue
            if len(holding) > 1:
                raise RuntimeError(f"{len(holding)} datasets hold the agent's tables: choose one under BigQuery.")
            return holding[0] if holding else ""

        offer("platform.gcp.agent_runtime_resource", one_runtime, "Agent Runtime")
        offer("platform.bigquery.dataset", own_dataset, "Dataset")
        if found.get("platform.bigquery.dataset") and not read(settings, "platform.bigquery.tables.events"):
            settings["platform"]["bigquery"]["tables"]["events"] = f"{found['platform.bigquery.dataset']}.agent_events"
            found["platform.bigquery.tables.events"] = settings["platform"]["bigquery"]["tables"]["events"]
    else:
        notes.append(LOCAL)
    fresh = ctx
    if found:
        try:
            fresh = save_sections(request, ctx, user, {s: settings[s] for s in sorted({p.split(".")[0] for p in found})}, "Found and filled in the Console")
        except ValidationError as exc:
            raise HTTPException(422, {"error": "A value that was found was not accepted", "code": "validation_error", "errors": format_errors(exc, "")}) from exc
        audit.record(fresh, actor=user.email, action="connection.autofill", surface="console", target_type="connection", target_id="all",
                     summary=f"Found and filled: {', '.join(sorted(found))}", detail={"filled": found})
    after = catalog(fresh)
    labels = {f.path: (t.name, f.label) for t in tools(fresh) for f in t.fields}
    return {"filled": [{"path": p, "value": v, "tool": labels.get(p, ("", ""))[0], "label": labels.get(p, ("", p))[1]} for p, v in sorted(found.items())],
            "left": [{"tool": c["key"], "name": c["name"], "label": m, "required": c["required"]} for c in after["connections"] for m in c["missing"]],
            "notes": notes, **after}
