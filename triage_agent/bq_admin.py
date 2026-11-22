"""BigQuery for the Console: run queries, and list / create / edit datasets, tables and views.

Everything about the connection comes from Settings → BigQuery (project, location, dataset, table mapping, the cap on
bytes billed, the datasets the Console may change). Nothing is created unless an admin asks for it in the Console and
the `bigquery_admin` switch is ON; every change is audited by the caller.
"""

from __future__ import annotations

import logging
import os
import re
from datetime import date, datetime
from typing import TYPE_CHECKING, Any

from .config import switch_off

if TYPE_CHECKING:  # pragma: no cover
    from .context import AgentContext

log = logging.getLogger(__name__)

TABLE_ID = re.compile(r"^[A-Za-z0-9_-]+\.[A-Za-z0-9_]+\.[A-Za-z0-9_$-]+$")
NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,299}$")
FIELD_TYPES = ("STRING", "INT64", "FLOAT64", "NUMERIC", "BOOL", "TIMESTAMP", "DATE", "DATETIME", "TIME", "JSON", "BYTES", "GEOGRAPHY")
# The agent's own tables: Settings → BigQuery → "Create the agent's tables" makes any that are missing.
STANDARD_TABLES: dict[str, dict[str, Any]] = {
    "events": {
        "description": "Every agent event (triage, corrections, reviews, emails, audit, Chat tracking, AI usage).",
        "partition": "event_ts", "cluster": ["event_type", "case_id"],
        "schema": [("event_id", "STRING", "REQUIRED"), ("event_ts", "TIMESTAMP", "REQUIRED"), ("event_type", "STRING", "REQUIRED"),
                   ("env", "STRING", "NULLABLE"), ("case_id", "STRING", "NULLABLE"), ("escalation_id", "STRING", "NULLABLE"),
                   ("actor", "STRING", "NULLABLE"), ("space", "STRING", "NULLABLE"), ("message_ref", "STRING", "NULLABLE"),
                   ("attempt", "INT64", "NULLABLE"), ("verdict", "STRING", "NULLABLE"), ("error_codes", "STRING", "REPEATED"),
                   ("latency_ms", "INT64", "NULLABLE"), ("model", "STRING", "NULLABLE"), ("prompt_version", "STRING", "NULLABLE"),
                   ("config_version", "STRING", "NULLABLE"), ("payload", "JSON", "NULLABLE")],
    },
    "forecasts": {
        "description": "Hourly volume forecasts written by the workforce forecast run.",
        "partition": "forecast_ts", "cluster": ["run_id"],
        "schema": [("run_id", "STRING", "REQUIRED"), ("created_at", "TIMESTAMP", "REQUIRED"), ("method", "STRING", "REQUIRED"),
                   ("forecast_ts", "TIMESTAMP", "REQUIRED"), ("forecast_value", "FLOAT64", "NULLABLE"),
                   ("lower_bound", "FLOAT64", "NULLABLE"), ("upper_bound", "FLOAT64", "NULLABLE"),
                   ("confidence_level", "FLOAT64", "NULLABLE")],
    },
    "early_posts": {
        "description": "Early Detection: each post read from the post tables, with the numbers Vertex AI gave it (its embedding).",
        "partition": "seen", "cluster": ["post_id"],
        "schema": [("post_id", "STRING", "REQUIRED"), ("source", "STRING", "NULLABLE"), ("platform", "STRING", "NULLABLE"),
                   ("author", "STRING", "NULLABLE"), ("text", "STRING", "NULLABLE"), ("url", "STRING", "NULLABLE"),
                   ("posted", "TIMESTAMP", "NULLABLE"), ("seen", "TIMESTAMP", "REQUIRED"), ("followers", "INT64", "NULLABLE"),
                   ("engagement", "FLOAT64", "NULLABLE"), ("embedding", "FLOAT64", "REPEATED")],
    },
    "early_members": {
        "description": "Early Detection: which story each post belongs to.",
        "partition": "joined", "cluster": ["story_id"],
        "schema": [("post_id", "STRING", "REQUIRED"), ("story_id", "STRING", "REQUIRED"), ("sim", "FLOAT64", "NULLABLE"),
                   ("joined", "TIMESTAMP", "REQUIRED")],
    },
    "early_signals": {
        "description": "Early Detection: each time a story reached the bar (story), grew (update) or was raised early (early).",
        "partition": "raised", "cluster": ["story_id"],
        "schema": [("signal_id", "STRING", "REQUIRED"), ("story_id", "STRING", "REQUIRED"), ("kind", "STRING", "REQUIRED"),
                   ("raised", "TIMESTAMP", "REQUIRED"), ("accounts", "INT64", "NULLABLE"), ("posts", "INT64", "NULLABLE"),
                   ("platforms", "STRING", "NULLABLE"), ("first_posted", "TIMESTAMP", "NULLABLE"), ("last_posted", "TIMESTAMP", "NULLABLE")],
    },
    "golden": {
        "description": "Golden examples: alerts the Incident Managers confirmed or corrected.",
        "partition": "updated_at", "cluster": ["label"],
        "schema": [("case_id", "STRING", "REQUIRED"), ("label", "STRING", "REQUIRED"), ("source", "STRING", "NULLABLE"),
                   ("alert_text", "STRING", "NULLABLE"), ("as_received", "JSON", "NULLABLE"), ("agent", "JSON", "NULLABLE"),
                   ("human", "JSON", "NULLABLE"), ("expected", "JSON", "NULLABLE"), ("updated_at", "TIMESTAMP", "REQUIRED")],
    },
}


class NotConnected(RuntimeError):
    """BigQuery can't be reached with the current settings; the message says what to set."""


class NotAllowed(RuntimeError):
    """The Console may not change this object (switch OFF, or the dataset isn't on the allow-list)."""


def check_table_id(table_id: str) -> str:
    table_id = (table_id or "").strip().strip("`")
    if not TABLE_ID.match(table_id):
        raise ValueError(f"'{table_id}' is not a table id: use project.dataset.table")
    return table_id


class BigQueryGateway:
    def __init__(self, project: str, location: str = "", max_bytes: int = 0):
        try:
            from google.cloud import bigquery
        except ImportError as exc:  # pragma: no cover
            raise NotConnected("The BigQuery client library is not installed.") from exc
        self._bq = bigquery
        self.project, self.location, self.max_bytes = project, location, max_bytes
        try:
            self.client = bigquery.Client(project=project or None, location=location or None)
        except Exception as exc:  # noqa: BLE001 - no credentials / no project
            raise NotConnected(f"BigQuery isn't connected: {exc}") from exc
        self.project = self.project or self.client.project

    # -- queries ---------------------------------------------------------------------------------------------------
    def _params(self, params: dict[str, Any] | None) -> list[Any]:
        bq = self._bq
        out = []
        for name, value in (params or {}).items():
            if isinstance(value, (list, tuple)):
                kind = "INT64" if value and all(isinstance(v, int) and not isinstance(v, bool) for v in value) else "STRING"
                out.append(bq.ArrayQueryParameter(name, kind, list(value)))
            elif isinstance(value, bool):
                out.append(bq.ScalarQueryParameter(name, "BOOL", value))
            elif isinstance(value, int):
                out.append(bq.ScalarQueryParameter(name, "INT64", value))
            elif isinstance(value, float):
                out.append(bq.ScalarQueryParameter(name, "FLOAT64", value))
            elif isinstance(value, datetime):
                out.append(bq.ScalarQueryParameter(name, "TIMESTAMP", value))
            elif isinstance(value, date):
                out.append(bq.ScalarQueryParameter(name, "DATE", value))
            else:
                out.append(bq.ScalarQueryParameter(name, "STRING", None if value is None else str(value)))
        return out

    def query(self, sql: str, params: dict[str, Any] | None = None, *, location: str | None = None,
              max_rows: int = 10000, labels: dict[str, str] | None = None) -> list[dict[str, Any]]:
        config = self._bq.QueryJobConfig(query_parameters=self._params(params), labels=labels or {"app": "triage-agent"})
        if self.max_bytes:
            config.maximum_bytes_billed = self.max_bytes
        job = self.client.query(sql, job_config=config, location=location or self.location or None)
        rows = []
        for row in job.result(max_results=max_rows):
            rows.append({k: _plain(v) for k, v in row.items()})
        return rows

    def dry_run(self, sql: str, params: dict[str, Any] | None = None, *, location: str | None = None) -> int:
        """Bytes the query would scan (nothing runs)."""
        config = self._bq.QueryJobConfig(query_parameters=self._params(params), dry_run=True, use_query_cache=False)
        job = self.client.query(sql, job_config=config, location=location or self.location or None)
        return int(job.total_bytes_processed or 0)

    def test(self) -> dict[str, Any]:
        rows = self.query("SELECT 1 AS ok, SESSION_USER() AS identity")
        return {"ok": True, "project": self.project, "location": self.location or "default", "identity": rows[0].get("identity")}

    # -- catalog ---------------------------------------------------------------------------------------------------
    def list_datasets(self) -> list[dict[str, Any]]:
        out = []
        for ds in self.client.list_datasets():
            out.append({"dataset": ds.dataset_id, "project": ds.project, "full_id": f"{ds.project}.{ds.dataset_id}"})
        return sorted(out, key=lambda d: d["dataset"])

    def get_dataset(self, dataset: str) -> dict[str, Any]:
        ds = self.client.get_dataset(dataset)
        return {"dataset": ds.dataset_id, "project": ds.project, "location": ds.location, "description": ds.description or "",
                "created": _plain(ds.created), "modified": _plain(ds.modified),
                "default_table_expiration_ms": ds.default_table_expiration_ms}

    def create_dataset(self, dataset: str, location: str, description: str = "") -> dict[str, Any]:
        if not NAME.match(dataset):
            raise ValueError("A dataset name uses letters, digits and underscores, and starts with a letter.")
        ds = self._bq.Dataset(f"{self.project}.{dataset}")
        ds.location = location or self.location or "US"
        ds.description = description
        self.client.create_dataset(ds, exists_ok=False)
        return self.get_dataset(f"{self.project}.{dataset}")

    def update_dataset(self, dataset: str, description: str) -> dict[str, Any]:
        ds = self.client.get_dataset(dataset)
        ds.description = description
        self.client.update_dataset(ds, ["description"])
        return self.get_dataset(dataset)

    def list_tables(self, dataset: str) -> list[dict[str, Any]]:
        out = []
        for t in self.client.list_tables(dataset):
            out.append({"table": t.table_id, "type": t.table_type, "full_id": f"{t.project}.{t.dataset_id}.{t.table_id}"})
        return sorted(out, key=lambda t: t["table"])

    def get_table(self, table_id: str) -> dict[str, Any]:
        t = self.client.get_table(check_table_id(table_id))
        tp = t.time_partitioning
        return {
            "full_id": f"{t.project}.{t.dataset_id}.{t.table_id}", "type": t.table_type, "description": t.description or "",
            "rows": t.num_rows, "bytes": t.num_bytes, "created": _plain(t.created), "modified": _plain(t.modified),
            "location": t.location, "schema": [_field(f) for f in t.schema],
            "partition_field": (tp.field if tp else None), "partition_type": (tp.type_ if tp else None),
            "clustering": list(t.clustering_fields or []), "view_query": t.view_query or "",
        }

    def _schema(self, fields: list[dict[str, Any]]) -> list[Any]:
        out = []
        seen = set()
        for f in fields:
            name, kind = str(f.get("name") or "").strip(), str(f.get("type") or "STRING").upper()
            mode = str(f.get("mode") or "NULLABLE").upper()
            if not NAME.match(name):
                raise ValueError(f"'{name}' is not a column name (letters, digits, underscores; starts with a letter).")
            if name.lower() in seen:
                raise ValueError(f"Column '{name}' is listed twice.")
            seen.add(name.lower())
            if kind not in FIELD_TYPES:
                raise ValueError(f"Column '{name}': type {kind} is not one of {', '.join(FIELD_TYPES)}.")
            if mode not in ("NULLABLE", "REQUIRED", "REPEATED"):
                raise ValueError(f"Column '{name}': mode must be NULLABLE, REQUIRED or REPEATED.")
            out.append(self._bq.SchemaField(name, kind, mode=mode, description=str(f.get("description") or "")[:1024] or None))
        if not out:
            raise ValueError("A table needs at least one column.")
        return out

    def create_table(self, table_id: str, fields: list[dict[str, Any]], *, description: str = "", partition_field: str = "",
                     clustering: list[str] | None = None) -> dict[str, Any]:
        table = self._bq.Table(check_table_id(table_id), schema=self._schema(fields))
        table.description = description
        if partition_field:
            table.time_partitioning = self._bq.TimePartitioning(type_=self._bq.TimePartitioningType.DAY, field=partition_field)
        if clustering:
            table.clustering_fields = clustering[:4]
        self.client.create_table(table, exists_ok=False)
        return self.get_table(table_id)

    def update_table(self, table_id: str, *, fields: list[dict[str, Any]] | None = None, description: str | None = None) -> dict[str, Any]:
        """Add columns and edit descriptions. BigQuery does not let a column be dropped, renamed or retyped here:
        an existing column must be listed with its own type and mode."""
        t = self.client.get_table(check_table_id(table_id))
        changed = []
        if fields is not None:
            new = self._schema(fields)
            current = {f.name.lower(): f for f in t.schema}
            given = {f.name.lower(): f for f in new}
            for name, old in current.items():
                if name not in given:
                    raise ValueError(f"Column '{old.name}' can't be removed here.")
                if given[name].field_type != old.field_type or given[name].mode != old.mode:
                    raise ValueError(f"Column '{old.name}' can't change type or mode ({old.field_type} {old.mode}).")
            for f in new:
                if f.name.lower() not in current and f.mode == "REQUIRED":
                    raise ValueError(f"New column '{f.name}' can't be REQUIRED: the table already has rows without it.")
            t.schema = new
            changed.append("schema")
        if description is not None:
            t.description = description
            changed.append("description")
        if changed:
            self.client.update_table(t, changed)
        return self.get_table(table_id)

    def save_view(self, view_id: str, sql: str, description: str = "") -> dict[str, Any]:
        view_id = check_table_id(view_id)
        self.dry_run(sql)  # a view that doesn't compile is refused before anything is written
        view = self._bq.Table(view_id)
        view.view_query = sql
        view.description = description
        try:
            existing = self.client.get_table(view_id)
        except Exception:  # noqa: BLE001 - not found: create it
            self.client.create_table(view)
            return self.get_table(view_id)
        if existing.table_type != "VIEW":
            raise ValueError(f"{view_id} is a {existing.table_type.lower()}, not a view.")
        existing.view_query = sql
        existing.description = description
        self.client.update_table(existing, ["view_query", "description"])
        return self.get_table(view_id)

    def preview(self, table_id: str, limit: int = 20) -> list[dict[str, Any]]:
        table_id = check_table_id(table_id)
        t = self.client.get_table(table_id)
        if t.table_type == "VIEW":
            return self.query(f"SELECT * FROM `{table_id}` LIMIT {int(limit)}", max_rows=limit)
        return [{k: _plain(v) for k, v in row.items()} for row in self.client.list_rows(t, max_results=limit)]

    def insert_rows(self, table_id: str, rows: list[dict[str, Any]]) -> None:
        errors = self.client.insert_rows_json(check_table_id(table_id), rows)
        if errors:
            raise RuntimeError(f"BigQuery insert failed: {errors[:3]}")


def _plain(value: Any) -> Any:
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, bytes):
        return f"<{len(value)} bytes>"
    if isinstance(value, (list, tuple)):
        return [_plain(v) for v in value]
    if isinstance(value, dict):
        return {k: _plain(v) for k, v in value.items()}
    if type(value).__name__ == "Decimal":
        return float(value)
    return value


def _field(f: Any) -> dict[str, Any]:
    return {"name": f.name, "type": f.field_type, "mode": f.mode, "description": f.description or ""}


def get_gateway(ctx: "AgentContext") -> BigQueryGateway:
    """The gateway for the current settings (kept on the context until the BigQuery settings change)."""
    cfg = ctx.config.platform
    project = cfg.bigquery.project or cfg.gcp.project or os.environ.get("TRIAGE_PROJECT_ID") or os.environ.get("GOOGLE_CLOUD_PROJECT") or ""
    key = (project, cfg.bigquery.location, cfg.bigquery.max_bytes_billed)
    if ctx.bq is not None and getattr(ctx.bq, "_settings_key", key) == key:
        return ctx.bq
    gateway = BigQueryGateway(project, cfg.bigquery.location, cfg.bigquery.max_bytes_billed)
    gateway._settings_key = key  # type: ignore[attr-defined]
    ctx.bq = gateway
    return gateway


def table(ctx: "AgentContext", name: str) -> str:
    """The table mapped to a logical name in Settings → BigQuery → tables ('' when not mapped)."""
    value = str(ctx.config.platform.bigquery.tables.get(name) or "").strip()
    if not value and name == "events":
        value = os.environ.get("TRIAGE_BQ_TABLE", "")
    return check_table_id(value) if value else ""


def require_admin(ctx: "AgentContext", full_id: str) -> None:
    """Refuse a change unless the switch is ON and the object's dataset is on the allow-list."""
    cfg = ctx.config.platform
    if not cfg.flags.bigquery_admin:
        raise NotAllowed(switch_off("Changing BigQuery from the Console", "bigquery_admin"))
    parts = full_id.strip("`").split(".")
    dataset = ".".join(parts[:2]) if len(parts) >= 2 else full_id
    allowed = {d.strip().strip("`") for d in cfg.bigquery.admin_allowed_datasets if d.strip()}
    own = cfg.bigquery.dataset.strip()
    if own:
        allowed.add(own if "." in own else f"{parts[0]}.{own}")
    short = dataset.split(".")[-1]
    if dataset not in allowed and short not in allowed:
        raise NotAllowed(f"The Console may not change {dataset}. Add it under Settings → BigQuery → datasets the Console may change.")


def ensure_standard_tables(ctx: "AgentContext", only: tuple[str, ...] | None = None) -> list[dict[str, Any]]:
    """Create the agent's own tables in its dataset (missing ones only); mapping them in Settings is left to the caller.
    With `only`, just the tables named."""
    cfg = ctx.config.platform.bigquery
    if not cfg.dataset:
        raise ValueError("Set the agent's dataset first (Settings → BigQuery → Dataset).")
    gw = get_gateway(ctx)
    dataset = cfg.dataset if "." in cfg.dataset else f"{gw.project}.{cfg.dataset}"
    steps: list[dict[str, Any]] = []
    try:
        gw.get_dataset(dataset)
        steps.append({"step": f"dataset {dataset}", "ok": True, "detail": "exists"})
    except Exception:  # noqa: BLE001 - not there yet
        require_admin(ctx, dataset)
        gw.create_dataset(dataset.split(".")[-1], cfg.location)
        steps.append({"step": f"dataset {dataset}", "ok": True, "detail": "created"})
    for name, spec in STANDARD_TABLES.items():
        if only is not None and name not in only:
            continue
        full = f"{dataset}.agent_{name}"
        try:
            gw.get_table(full)
            steps.append({"step": full, "ok": True, "detail": "exists", "name": name})
            continue
        except Exception:  # noqa: BLE001 - create it
            pass
        require_admin(ctx, full)
        gw.create_table(full, [{"name": n, "type": t, "mode": m} for n, t, m in spec["schema"]], description=spec["description"],
                        partition_field=spec["partition"], clustering=spec["cluster"])
        steps.append({"step": full, "ok": True, "detail": "created", "name": name})
    return steps
