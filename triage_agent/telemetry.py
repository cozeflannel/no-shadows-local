"""Structured logging and tracing.

Logs are one JSON object a line on stdout (Cloud Run reads `severity`, `message` and the trace field). Tracing uses
OpenTelemetry when Settings → Telemetry turns it on; spans go to Google Cloud's OTLP endpoint with the service's own
credentials. With tracing off, or when the exporter can't be set up, span() costs nothing.
"""

from __future__ import annotations

import contextlib
import json
import logging
import os
import sys
import time
from typing import Any, Iterator

_CONFIGURED = {"logging": False, "tracing": False}
_tracer: Any = None
OTLP_ENDPOINT = "https://telemetry.googleapis.com/v1/traces"


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        entry: dict[str, Any] = {
            "severity": record.levelname,
            "message": record.getMessage(),
            "logger": record.name,
            "time": self.formatTime(record, "%Y-%m-%dT%H:%M:%S%z"),
        }
        for key in ("op", "case_id", "escalation_id", "actor", "purpose", "latency_ms", "request_id", "path", "status"):
            value = getattr(record, key, None)
            if value is not None:
                entry[key] = value
        trace = current_trace()
        if trace:
            project = os.environ.get("TRIAGE_PROJECT_ID") or os.environ.get("GOOGLE_CLOUD_PROJECT") or ""
            entry["logging.googleapis.com/trace"] = f"projects/{project}/traces/{trace[0]}" if project else trace[0]
            entry["logging.googleapis.com/spanId"] = trace[1]
        if record.exc_info:
            entry["stack_trace"] = self.formatException(record.exc_info)
        return json.dumps(entry, default=str, ensure_ascii=False)


def configure_logging(level: str = "INFO", force: bool = False) -> None:
    """JSON logs on stdout for deployed services; local runs keep the plain format unless forced."""
    if _CONFIGURED["logging"] and not force:
        logging.getLogger().setLevel(level)
        return
    deployed = bool(os.environ.get("K_SERVICE") or os.environ.get("CLOUD_RUN_JOB") or os.environ.get("TRIAGE_BACKEND") == "gcp")
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter() if (deployed or force) else logging.Formatter("%(levelname)s %(name)s: %(message)s"))
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(level)
    _CONFIGURED["logging"] = True


def configure_tracing(enabled: bool, sample_rate: float = 0.1, service: str = "") -> bool:
    """Turn tracing on (idempotent). Returns whether spans are being exported."""
    global _tracer
    if not enabled:
        return False
    if _CONFIGURED["tracing"]:
        return _tracer is not None
    _CONFIGURED["tracing"] = True
    try:
        import google.auth
        from google.auth.transport.requests import AuthorizedSession
        from opentelemetry import trace
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor
        from opentelemetry.sdk.trace.sampling import ParentBased, TraceIdRatioBased

        creds, project = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
        project = os.environ.get("TRIAGE_PROJECT_ID") or os.environ.get("GOOGLE_CLOUD_PROJECT") or project or ""
        resource = Resource.create({"service.name": service or os.environ.get("K_SERVICE") or "triage-agent",
                                    "gcp.project_id": project})
        provider = TracerProvider(resource=resource, sampler=ParentBased(TraceIdRatioBased(max(0.0, min(1.0, sample_rate)))))
        exporter = OTLPSpanExporter(endpoint=OTLP_ENDPOINT, session=AuthorizedSession(creds),
                                    headers={"x-goog-user-project": project} if project else None)
        provider.add_span_processor(BatchSpanProcessor(exporter))
        trace.set_tracer_provider(provider)
        _tracer = trace.get_tracer("triage_agent")
        return True
    except Exception as exc:  # noqa: BLE001 - tracing is optional; the service runs without it
        logging.getLogger(__name__).warning("tracing could not be set up: %s", exc)
        _tracer = None
        return False


def current_trace() -> tuple[str, str] | None:
    if _tracer is None:
        return None
    try:
        from opentelemetry import trace

        ctx = trace.get_current_span().get_span_context()
        if ctx and ctx.trace_id:
            return format(ctx.trace_id, "032x"), format(ctx.span_id, "016x")
    except Exception:  # noqa: BLE001
        return None
    return None


@contextlib.contextmanager
def span(name: str, **attributes: Any) -> Iterator[dict[str, Any]]:
    """Time a unit of work. Yields a dict the caller may add attributes to; `elapsed_ms` is filled on exit."""
    info: dict[str, Any] = {}
    t0 = time.monotonic()
    if _tracer is None:
        try:
            yield info
        finally:
            info["elapsed_ms"] = int((time.monotonic() - t0) * 1000)
        return
    with _tracer.start_as_current_span(name) as otel_span:
        for key, value in attributes.items():
            if value is not None:
                otel_span.set_attribute(key, value if isinstance(value, (str, bool, int, float)) else str(value))
        try:
            yield info
        except Exception as exc:
            otel_span.record_exception(exc)
            raise
        finally:
            info["elapsed_ms"] = int((time.monotonic() - t0) * 1000)
            for key, value in info.items():
                if isinstance(value, (str, bool, int, float)):
                    otel_span.set_attribute(key, value)


def apply(config: Any) -> None:
    """Apply Settings → Telemetry (log level, tracing). Safe to call on every config reload."""
    t = config.platform.telemetry
    configure_logging(t.log_level)
    configure_tracing(t.tracing, t.trace_sample_rate)
