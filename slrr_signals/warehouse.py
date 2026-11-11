"""BigQuery access for slrr-signals, the only module that talks to BigQuery.

Queries use named parameters (never text pasted into SQL) and a bytes cap; inserts are streaming inserts with insert ids,
so a retried insert never doubles a row. Tests use FakeWarehouse-style objects with the same two methods.
"""

from __future__ import annotations

import datetime as dt
import json
from typing import Any, Protocol


class Warehouse(Protocol):
    def query(self, sql: str, params: dict[str, Any] | None = None, *, location: str = "US") -> list[dict[str, Any]]: ...

    def insert(self, table: str, rows: list[dict[str, Any]], row_ids: list[str] | None = None) -> None: ...


def _param(name: str, value: Any):
    from google.cloud import bigquery

    if isinstance(value, bool):
        return bigquery.ScalarQueryParameter(name, "BOOL", value)
    if isinstance(value, int):
        return bigquery.ScalarQueryParameter(name, "INT64", value)
    if isinstance(value, float):
        return bigquery.ScalarQueryParameter(name, "FLOAT64", value)
    if isinstance(value, dt.datetime):
        return bigquery.ScalarQueryParameter(name, "TIMESTAMP", value)
    if isinstance(value, (list, tuple)):
        if value and all(isinstance(v, int) and not isinstance(v, bool) for v in value):
            return bigquery.ArrayQueryParameter(name, "INT64", list(value))
        return bigquery.ArrayQueryParameter(name, "STRING", [str(v) for v in value])
    return bigquery.ScalarQueryParameter(name, "STRING", None if value is None else str(value))


def jsonable(row: dict[str, Any]) -> dict[str, Any]:
    """A row as insert_rows_json takes it: times as ISO strings, JSON columns (dicts) as JSON text."""
    out: dict[str, Any] = {}
    for k, v in row.items():
        if isinstance(v, dt.datetime):
            out[k] = v.astimezone(dt.UTC).isoformat()
        elif isinstance(v, dict):
            out[k] = json.dumps(v, default=str)
        elif isinstance(v, (list, tuple)):
            out[k] = [x.isoformat() if isinstance(x, dt.datetime) else x for x in v]
        else:
            out[k] = v
    return out


class BigQueryWarehouse:
    def __init__(self, project: str, *, max_bytes: int, labels: dict[str, str] | None = None):
        from google.cloud import bigquery

        self._bigquery = bigquery
        self.client = bigquery.Client(project=project)
        self.max_bytes = int(max_bytes)
        self.labels = dict(labels or {})

    def query(self, sql: str, params: dict[str, Any] | None = None, *, location: str = "US") -> list[dict[str, Any]]:
        cfg = self._bigquery.QueryJobConfig(
            query_parameters=[_param(k, v) for k, v in (params or {}).items()],
            maximum_bytes_billed=self.max_bytes,
            labels=self.labels,
            use_legacy_sql=False,
        )
        job = self.client.query(sql, job_config=cfg, location=location, timeout=60)
        return [dict(r.items()) for r in job.result(timeout=180)]

    def insert(self, table: str, rows: list[dict[str, Any]], row_ids: list[str] | None = None) -> None:
        if not rows:
            return
        errors = self.client.insert_rows_json(table, [jsonable(r) for r in rows], row_ids=row_ids)
        if errors:
            raise RuntimeError(f"insert into {table} failed: {str(errors)[:600]}")
