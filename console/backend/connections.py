"""Integrations: every tool the agent uses, connected in one place.

Each tool lists the few values it needs, whether they are set, and a live check of the access the Console's account
has. The page's Set up button fills, creates and checks in one press. The fill writes what the running service can see
for itself (the project, the region, its own address, the one Agent Runtime, the dataset that holds the agent's tables)
and the temp check app's setup (config/temp_check_app.yaml: its tables of posts and Brandwatch values), so only what a
person alone knows is left to enter.
Values are saved to the same settings the rest of the Console edits; a check's result is kept until its values change.

BigQuery is one card: the agent's own dataset, and every table the app reads listed once with what reads it. A table
several settings name is one row, and changing it there changes each of them. A table's location is read from BigQuery
by the check, never typed. The catalog also carries what is left to do across every tool, and each GRANT line once.
"""

from __future__ import annotations

import copy
import hashlib
import json
import logging
import os
from dataclasses import dataclass
from datetime import timedelta
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
    watch: tuple[str, ...] = ()  # settings a check depends on besides its fields: a check is forgotten when one changes


TABLES_PATH = "platform.temp_check.sources"
EARLY_PATH = "platform.early.sources"
WATCH_PATH = "platform.campaigns.watch_sources"
OWN_PATH = "platform.own_alerts.sources"
# What decides which tables BigQuery's check asks for, and where: a check is forgotten when one of these changes.
TABLE_SETTINGS = (TABLES_PATH, EARLY_PATH, WATCH_PATH, OWN_PATH, "inhouse.enabled", "inhouse.mark_delivered", "inhouse.outbox_view", "inhouse.alert_log_table",
                  "inhouse.location", "inhouse.sonar_location", "sonar_lookup.enabled", "sonar_lookup.table", "sonar_lookup.slrr_table",
                  "sonar_lookup.alert_log_table", "sonar_lookup.location", "platform.costs.billing_export_table")


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
        Tool("bigquery", "BigQuery", "The app's own dataset, and every table it reads.", True,
             (F("platform.bigquery.dataset", "Dataset", True, options="datasets", help="The app's own dataset. What it creates goes here."),
              F("platform.bigquery.location", "Location", help="For a new dataset. Read from BigQuery once the dataset exists."),
              F("platform.bigquery.project", "Project", help="Blank: the Cloud project.")),
             ("Event log", "Temp checks", "Early Detection", "Watches", "Agent alerts", "Our own alerts", "Find missing links", "Workforce forecast", "Costs"),
             "BigQuery Data Editor on its own dataset, BigQuery Job User on the project, and BigQuery Data Viewer on each dataset it reads.",
             "/settings/bigquery", "/api/bigquery/provision", watch=TABLE_SETTINGS),
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
              F("platform.temp_check.brandwatch_api_base", "API address"),
              F("platform.temp_check.event_query_prefix", "Event query names start with", help="The queries offered in the temp check's search box and used for the concern level."),
              F("platform.temp_check.standing_query_name", "Standing query names start with",
                help="The active queries named this way are searched when an issue has no query of its own yet."),
              F("platform.temp_check.standing_query_skip", "Leave out standing queries named with", help="A word: a standing query whose name has it is not searched.")),
             ("Temp checks",), "A Brandwatch API token, kept in Secret Manager.", "/settings/temp_check"),
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


# -- the tables the app reads, each listed once --------------------------------------------------------------------------------
@dataclass(frozen=True)
class Slot:
    """One setting that names a table."""

    path: str  # the setting that holds the table's id
    name: str  # what the table is
    what: str
    use: str = ""  # the feature that reads the table from this setting; none: the setting only follows the table
    on: bool = False  # that feature is ON
    location: str = ""  # the setting that holds the table's location, when one does
    post: str = ""  # the key of the table of posts: what reads it is chosen per table


@dataclass
class Row:
    slots: list[Slot]
    table: str

    @property
    def id(self) -> str:
        return self.slots[0].path


def _slots(settings: dict[str, Any]) -> list[Slot]:
    from triage_agent import inhouse

    own, look = settings.get("inhouse") or {}, settings.get("sonar_lookup") or {}
    out = [Slot(f"{TABLES_PATH}.{t['key']}.table", t.get("label") or t["key"], t.get("what") or "", location=f"{TABLES_PATH}.{t['key']}.location", post=t["key"])
           for t in read(settings, TABLES_PATH) or []]
    alerts, links = bool(own.get("enabled")), bool(look.get("enabled"))
    out += [
        Slot("inhouse.outbox_view", "Story selection view", "Where the team's own alerts are read from.", "Our own alerts", alerts,
             "inhouse." + inhouse.view_location_setting(str(own.get("outbox_view") or ""))),
        Slot("inhouse.alert_log_table", "Alert log", "Every alert the team logged.", "Our own alerts", alerts and bool(own.get("mark_delivered")), "inhouse.location"),
        Slot("sonar_lookup.slrr_table", "Alert log", "Every alert the team logged.", "Find missing links", links),
        Slot("inhouse.sonar_table", "Sonar", "Sonar's record of each post."),
        Slot("sonar_lookup.table", "Sonar", "Sonar's record of each post.", "Find missing links", links, "sonar_lookup.location"),
    ]
    if str(look.get("alert_log_table") or "").strip():
        out.append(Slot("sonar_lookup.alert_log_table", "Second alert log", "A second log looked in for a missing link.", "Find missing links", links))
    out.append(Slot("platform.costs.billing_export_table", "Billing export", "Google Cloud's billing export, for the Costs page.", "Costs", True))
    return out


def _table_rows(settings: dict[str, Any]) -> list[Row]:
    """Every table the app reads, once: each table of posts is a row, and a setting that names the same table joins it."""
    rows: list[Row] = []
    for slot in _slots(settings):
        table = str(read(settings, slot.path) or "").strip()
        same = None if slot.post else next((r for r in rows if table and r.table == table), None)
        if same is not None:
            same.slots.append(slot)
        elif table or slot.use or slot.post:  # an empty setting nothing reads from is not a row
            rows.append(Row([slot], table))
    return rows


def _reads(settings: dict[str, Any], row: Row) -> list[str]:
    if not row.table:
        return []
    out: list[str] = []
    for slot in row.slots:
        if slot.post:
            t = read(settings, f"{TABLES_PATH}.{slot.post}") or {}
            out += [name for name, on in (("Temp checks", t.get("enabled")), ("Early Detection", slot.post in (read(settings, EARLY_PATH) or [])),
                                          ("Watches", slot.post in (read(settings, WATCH_PATH) or [])),
                                          ("Agent alerts", slot.post in (read(settings, OWN_PATH) or []))) if on]
        elif slot.use and slot.on:
            out.append(slot.use)
    return list(dict.fromkeys(out))


def _row_location(settings: dict[str, Any], row: Row) -> str:
    return next((v for v in (str(read(settings, slot.location) or "").strip() for slot in row.slots if slot.location) if v), "")


def table_list(settings: dict[str, Any], test: dict[str, Any] | None) -> list[dict[str, Any]]:
    checked = {d["row"]: d for d in (test or {}).get("details") or [] if d.get("row")}
    out = []
    for row in _table_rows(settings):
        first = row.slots[0]
        post = None
        if first.post:
            t = read(settings, f"{TABLES_PATH}.{first.post}") or {}
            post = {"key": first.post, "temp_checks": bool(t.get("enabled")), "early": first.post in (read(settings, EARLY_PATH) or []),
                    "watches": first.post in (read(settings, WATCH_PATH) or []), "own": first.post in (read(settings, OWN_PATH) or [])}
        was = checked.get(row.id)
        out.append({"id": row.id, "name": first.name, "what": first.what, "table": row.table, "set": bool(row.table), "location": _row_location(settings, row),
                    "post": post, "reads": _reads(settings, row), "status": {"ok": was["ok"], "message": was["message"]} if was else None})
    return out


# -- state ---------------------------------------------------------------------------------------------------------------------
def _fingerprint(settings: dict[str, Any], t: Tool) -> str:
    paths = [f.path for f in t.fields] + list(t.watch)
    return hashlib.sha256(json.dumps([[path, read(settings, path)] for path in paths], default=str).encode()).hexdigest()[:16]


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
    test = ({**{k: kept.get(k) for k in ("ok", "message", "details", "at", "by")}, "grants": kept.get("grants") or []}
            if kept.get("fingerprint") == _fingerprint(settings, t) else None)
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
    out = {"key": t.key, "name": t.name, "what": t.what, "required": t.required, "uses": list(t.uses), "access": t.access,
           "settings": t.settings, "create": t.create, "fields": fields, "missing": missing, "state": state, "test": test,
           "facts": facts, "steps": steps}
    if t.key == "bigquery":
        steps.append({"key": "tables", "title": "The tables it reads"})
        out["tables"] = table_list(settings, test)
    steps.append({"key": "test", "title": "Check access"})
    return out


def _todo(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """What is left for a person, across every tool: a value to set, or what a check found. A tool that is optional
    and untouched is not on the list."""
    out: list[dict[str, Any]] = []
    for r in rows:
        line = {"tool": r["key"], "name": r["name"], "required": r["required"]}
        if r["required"] or r["state"] != "not_connected":
            out += [{**line, "text": f"Set {label}"} for label in r["missing"]]
        if r["test"] and not r["test"]["ok"]:
            failed = [f"{d['label']}: no access. Send the line below to the dataset's owners." if d.get("grant") else f"{d['label']}: {d['message']}"
                      for d in r["test"]["details"] if not d["ok"]]
            out += [{**line, "text": text} for text in failed or [r["test"]["message"]]]
    return out


def catalog(ctx: AgentContext) -> dict[str, Any]:
    settings = ctx.config.model_dump(mode="json")
    rows = [state_of(ctx, t, settings) for t in tools(ctx)]
    needed = [r for r in rows if r["required"]]
    return {"connections": rows, "backend": "gcp" if _on_cloud() else "local", "todo": _todo(rows),
            "grants": [g for r in rows for g in (r["test"] or {}).get("grants") or []],
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


class TableChange(BaseModel):
    id: str = Field(max_length=200)
    table: str = Field("", max_length=300)


class ReadsChange(BaseModel):
    key: str = Field(max_length=80)
    temp_checks: bool
    early: bool
    watches: bool
    own: bool | None = None  # agent alerts; left out: its tables stay as they are


class TablesBody(BaseModel):
    tables: list[TableChange] = Field(default_factory=list, max_length=60)
    reads: list[ReadsChange] = Field(default_factory=list, max_length=60)


def _refuse(text: str) -> HTTPException:
    return HTTPException(422, {"error": text, "code": "validation_error"})


@router.put("/connections/bigquery/tables")
def put_tables(body: TablesBody, request: Request, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_admin)) -> dict[str, Any]:
    """Change a table the app reads, in every setting that names it, and choose what reads each table of posts."""
    if not body.tables and not body.reads:
        raise _refuse("Nothing to save")
    before = ctx.config.model_dump(mode="json")
    rows = {r.id: r for r in _table_rows(before)}
    changes: dict[str, Any] = {}
    for change in body.tables:
        row = rows.get(change.id)
        if row is None:
            raise _refuse(f"BigQuery reads no table set at {change.id}")
        table = change.table.strip().strip("`")
        if table:
            try:
                table = bq_admin.check_table_id(table)
            except ValueError as exc:
                raise _refuse(str(exc)) from exc
        changes.update({slot.path: table for slot in row.slots})
    posts = {t["key"] for t in read(before, TABLES_PATH) or []}
    lists = {path: list(read(before, path) or []) for path in (EARLY_PATH, WATCH_PATH, OWN_PATH)}
    for choice in body.reads:
        if choice.key not in posts:
            raise _refuse(f"There is no table of posts '{choice.key}'")
        changes[f"{TABLES_PATH}.{choice.key}.enabled"] = choice.temp_checks
        for path, on in ((EARLY_PATH, choice.early), (WATCH_PATH, choice.watches), (OWN_PATH, choice.own)):
            if on is None:
                continue
            if on and choice.key not in lists[path]:
                lists[path].append(choice.key)
            elif not on:
                lists[path] = [k for k in lists[path] if k != choice.key]
    if body.reads:
        changes.update(lists)
    t = tool(ctx, "bigquery")
    fresh = _apply(request, ctx, user, changes, "BigQuery tables changed in the Console")
    after = fresh.config.model_dump(mode="json")
    changed = sorted(path for path in changes if read(before, path) != read(after, path))
    audit.record(fresh, actor=user.email, action="connection.save", surface="console", target_type="connection", target_id=t.key,
                 summary=f"{t.name}: set {', '.join(changed) or 'nothing new'}"[:300],
                 detail={"changed": {path: {"before": read(before, path), "after": read(after, path)} for path in changed}})
    return {"ok": True, "changed": changed, "connection": state_of(fresh, tool(fresh, "bigquery"))}


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
    """What each model's real calls say. Gemini is not sent a test prompt: the calls the agent makes are the evidence."""
    from triage_agent.prompts import call_evidence

    m = ctx.config.models
    out: list[dict[str, Any]] = []
    for label, model in (("Model for alerts", m.triage), ("Model for drafts", m.drafting), ("Model for answers", m.converse)):
        out.append(_detail(label, lambda model=model: call_evidence(ctx, model)))
    if ctx.config.platform.knowledge.embedding_model:
        out.append(_detail("Embedding model", lambda: knowledge.embedding_evidence(ctx)))
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
            if chatapi.WRONG_PROJECT in str(exc):  # the sign-in's project, not this space: adding the account would not help
                message = chatapi.WRONG_PROJECT
            else:
                message = f"Add {bot} to this space, then check again. Chat said: {exc}" if exc.status in (403, 404) else f"Chat said: {exc}"
            out.append({"label": f"{s.display_name} space", "ok": False, "message": message})
            continue
        when = f"Latest message {int((now - latest['create_time']).total_seconds() / 60)} min ago." if latest else "No message in it yet."
        who = "People outside Google can join this space." if info["external"] else "Only Google people can join."
        out.append({"label": f"{s.display_name} space", "ok": True, "message": f"{when} {who}"})
    return out


GRANT = 'GRANT `roles/bigquery.dataViewer` ON SCHEMA `{project}`.`{dataset}` TO "serviceAccount:{who}"'


def _check_bigquery(ctx: AgentContext) -> list[dict[str, Any]]:
    """The agent's own dataset, then every table something reads: where it lives, and an estimate of its read. Both
    are free to ask. A line may carry `grant` (what the table's owners run) and `set` (a location read from BigQuery)."""
    cfg = ctx.config.platform.bigquery
    state: dict[str, Any] = {}

    def signed_in() -> str:
        _need_cloud()
        state["gw"] = bq_admin.get_gateway(ctx)
        info = state["gw"].test()
        state["who"] = str(info.get("identity") or "")
        return f"Queries run in {info['project']} as {info.get('identity')}."

    out = [_detail("Queries", signed_in)]
    if "gw" not in state:
        return out
    gw = state["gw"]
    dataset = cfg.dataset if "." in cfg.dataset else f"{gw.project}.{cfg.dataset}"

    def own_dataset() -> str:
        state["where"] = str(gw.get_dataset(dataset).get("location") or "")
        return f"{dataset} in {state['where'] or 'its location'}."

    out.append(_detail("Dataset", own_dataset))
    if state.get("where") and state["where"] != cfg.location:
        out[-1]["set"] = {"platform.bigquery.location": state["where"]}
    events = bq_admin.table(ctx, "events")
    if events:
        out.append(_detail("Events table", lambda: f"{events}: {gw.get_table(events).get('rows') or 0} rows."))
    else:
        out.append({"label": "Events table", "ok": False, "message": "Not created yet. Use Create what is missing."})
    return out + _check_tables(ctx, gw, state["who"])


def _check_tables(ctx: AgentContext, gw: Any, who: str) -> list[dict[str, Any]]:
    from triage_agent import tempcheck

    settings = ctx.config.model_dump(mode="json")
    posts = {t.key: t for t in ctx.config.platform.temp_check.sources}
    now = ctx.now()
    claimed: dict[str, tuple[str, str]] = {}  # a location setting -> (the location, the table that set it)
    out: list[dict[str, Any]] = []
    for row in _table_rows(settings):
        if not _reads(settings, row):
            continue
        first = row.slots[0]
        line: dict[str, Any] = {"label": first.name, "row": row.id, "ok": False}
        out.append(line)

        def denied(exc: Exception, table: str = row.table) -> bool:
            if "Access Denied" not in str(exc) and "403" not in str(exc):
                return False
            project, name = table.split(".")[:2]
            line["grant"] = GRANT.format(project=project, dataset=name, who=who)
            line["message"] = f"Access denied. The dataset's owners run: {line['grant']}"
            return True

        try:
            table = bq_admin.check_table_id(row.table)
        except ValueError as exc:
            line["message"] = str(exc)
            continue
        where = ""
        try:
            where = str(gw.get_table(table).get("location") or "")
        except Exception as exc:  # noqa: BLE001 - the reason is the result
            if denied(exc):
                continue
            if "404" in str(exc) or "Not found" in str(exc):
                line["message"] = f"BigQuery has no table {table}."
                continue
        stored = _row_location(settings, row)
        try:
            if first.post:
                sql = ("SELECT platform, author, text, url, posted, followers, eng, sentiment, language, shares, replies, seen, one\n"
                       f"FROM (\n    {tempcheck.read_of(posts[first.post])}\n)\nLIMIT 1")
                size = gw.dry_run(sql, {"t_from": now - timedelta(days=1), "t_to": now}, location=where or stored or None)
                line["message"] = f"Readable. A day's read scans {size / tempcheck.GB:.1f} GB."
            else:
                gw.dry_run(f"SELECT * FROM `{table}` LIMIT 1", location=where or stored or None)
                line["message"] = "Readable."
        except Exception as exc:  # noqa: BLE001 - the reason is the result
            if not denied(exc):
                line["message"] = f"BigQuery would not take this table's read: {str(exc)[:300]}"
            continue
        line["ok"] = True
        wanted = {slot.location for slot in row.slots if slot.location and (slot.on or slot.post)} if where else set()
        for path in sorted(wanted):
            other = claimed.setdefault(path, (where, first.name))
            if other[0] != where:
                line["ok"] = False
                line["message"] = f"It is in {where} and {other[1]} is in {other[0]}. The two are read together, so they have to be in one location."
            elif str(read(settings, path) or "").strip() != where:
                line.setdefault("set", {})[path] = where
        if line["ok"] and line.get("set"):
            line["message"] += f" Its location is now set to {where}."
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
            {"label": "People connected", "ok": g["connected"] > 0,
             "message": f"{g['connected']} of {g['people']}" + ("" if g["connected"] else ". Each person presses Connect Gmail at the top of the page.")}]


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
    "delivery": _check_delivery, "secrets": _check_secrets, "gmail": _check_gmail, "drive": _check_drive,
    "brandwatch": _check_brandwatch, "campaigns": _check_campaigns,
}


@router.post("/connections/{key}/test")
def test_connection(key: str, request: Request, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_admin)) -> dict[str, Any]:
    t = tool(ctx, key)
    settings = ctx.config.model_dump(mode="json")
    current = state_of(ctx, t, settings)
    if current["missing"]:
        result = {"ok": False, "message": f"Set these first: {', '.join(current['missing'])}.", "details": [], "grants": [],
                  "at": ctx.now().isoformat(), "by": user.email}
        return {"test": result, "connection": current}
    details = CHECKS[t.key](ctx)
    read_here = {path: value for d in details for path, value in (d.pop("set", None) or {}).items()}
    if read_here:  # what the check read for itself (a table's location) is written, so nobody types it
        ctx = _apply(request, ctx, user, read_here, f"{t.name}: read by its check")
        settings = ctx.config.model_dump(mode="json")
        audit.record(ctx, actor=user.email, action="connection.save", surface="console", target_type="connection", target_id=t.key,
                     summary=f"{t.name}: its check read {', '.join(f'{path} = {value}' for path, value in sorted(read_here.items()))}"[:300],
                     detail={"read": read_here})
    failed = [d for d in details if not d["ok"]]
    result = {"ok": not failed, "details": details, "at": ctx.now().isoformat(), "by": user.email,
              "grants": sorted({d["grant"] + ";" for d in details if d.get("grant")}),
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


def _offer_app_setup(ctx: AgentContext, settings: dict[str, Any], found: dict[str, Any], offer: Callable[[str, Callable[[], Any], str], None]) -> None:
    """The temp check app's setup (config/temp_check_app.yaml), for the settings that are still empty: its Brandwatch
    values, and its five tables of posts when no table is set. The token's secret is named only when the project holds it."""
    from triage_agent import tempcheck

    app = tempcheck.app_setup()
    for name, value in app["brandwatch"].items():
        def held(value: str = value) -> str:
            if value not in {str(x.get("name")) for x in secret_admin.get_gateway(ctx).list("")}:
                raise RuntimeError(f"the project holds no secret named {value}. Add the Brandwatch token as a secret, then pick it under Brandwatch")
            return value
        if name == "brandwatch_token_secret":
            offer(f"platform.temp_check.{name}", held, "Brandwatch token secret")
        else:
            offer(f"platform.temp_check.{name}", lambda value=value: value, name)
    if app["tables"] and not read(settings, TABLES_PATH):
        settings["platform"]["temp_check"]["sources"] = [t.model_dump(mode="json") for t in app["tables"]]
        found[TABLES_PATH] = ", ".join(t.label or t.key for t in app["tables"])  # the tables' names: what a person reads, in the answer and the audit log
    _offer_own_tables(settings, found, {t.key: t.table for t in app["tables"]})


def _offer_own_tables(settings: dict[str, Any], found: dict[str, Any], app_tables: dict[str, str]) -> None:
    """Agent alerts' tables, while it has none: the temp check app's tables that are set, and the two only it reads
    (config/own_alerts.yaml), which are added to the tables of posts with temp checks OFF. Tables a person set up
    themselves are left alone: nothing is added beside them."""
    from triage_agent.ownalerts import sources as own_sources

    if read(settings, OWN_PATH):
        return
    listed = settings["platform"]["temp_check"]["sources"]
    held = {t["key"]: t for t in listed}
    theirs = [key for key, table in app_tables.items() if key in held and held[key].get("table") == table]
    if not theirs:
        return
    for table in own_sources.app_tables():
        if table.key not in held and table.table not in {t.get("table") for t in listed}:
            listed.append(table.model_dump(mode="json"))
            held[table.key] = listed[-1]
    ticked = theirs + [t.key for t in own_sources.app_tables() if t.key in held]
    settings["platform"]["own_alerts"]["sources"] = ticked
    found[OWN_PATH] = ", ".join(held[key].get("label") or key for key in ticked)
    found.setdefault(TABLES_PATH, ", ".join(t.get("label") or t["key"] for t in listed))


@router.post("/connections/autofill")
def autofill(request: Request, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_admin)) -> dict[str, Any]:
    """The first step of Set up: write every empty value the running service can see for itself, and the temp check
    app's setup (its tables of posts and Brandwatch values). Nothing already set is changed."""
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
    _offer_app_setup(ctx, settings, found, offer)
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
    labels[TABLES_PATH] = ("BigQuery", "Tables of posts")
    labels[OWN_PATH] = ("BigQuery", "Tables agent alerts read")
    return {"filled": [{"path": p, "value": v, "tool": labels.get(p, ("", ""))[0], "label": labels.get(p, ("", p))[1]} for p, v in sorted(found.items())],
            "notes": notes, **after}
