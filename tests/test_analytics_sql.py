"""Static checks: BigQuery DDL/views stay in sync with models.AgentEvent and metrics.KPI_DEFINITIONS."""

import re
from pathlib import Path

from triage_agent.events import EventType
from triage_agent.metrics import KPI_DEFINITIONS
from triage_agent.models import AgentEvent

ANALYTICS = Path(__file__).resolve().parent.parent / "analytics"
DDL = (ANALYTICS / "01_agent_events.sql").read_text()
VIEWS = (ANALYTICS / "02_metric_views.sql").read_text()


def test_ddl_columns_match_agent_event():
    cols = re.findall(r"^\s{2}(\w+)\s+(?:STRING|TIMESTAMP|INT64|ARRAY<STRING>|JSON)", DDL, flags=re.M)
    assert cols == list(AgentEvent.model_fields), cols
    assert "PARTITION BY DATE(event_ts)" in DDL and "CLUSTER BY event_type, case_id" in DDL


def test_every_kpi_key_is_mapped_in_sql():
    mapped = set(re.findall(r"\['(\w+)'\]", VIEWS))
    missing = set(KPI_DEFINITIONS) - mapped
    extra = mapped - set(KPI_DEFINITIONS)
    assert not missing, f"KPIs missing from v_event_kpis: {sorted(missing)}"
    assert not extra, f"Unknown KPI keys in SQL: {sorted(extra)}"


def test_sql_event_types_are_real():
    literals = set(re.findall(r"'([a-z_]+\.[a-z_]+)'", VIEWS))
    unknown = literals - set(EventType.all())
    assert not unknown, f"Event types in SQL that don't exist: {sorted(unknown)}"


def test_placeholders_are_consistent():
    for sql in (DDL, VIEWS):
        assert "${PROJECT}.${DATASET}" in sql
        assert not re.search(r"`(?!\$\{PROJECT\})[\w-]+\.[\w-]+\.[\w-]+`", sql), "hard-coded table reference"
