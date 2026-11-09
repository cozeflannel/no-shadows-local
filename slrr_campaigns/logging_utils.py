"""Structured JSON logging and emoji stripping for slrr-campaigns."""

from __future__ import annotations

import json
import logging
import re
import sys
from datetime import UTC, datetime
from typing import Any

# Matches emoji and pictographic Unicode blocks so nothing written by the service carries emojis.
_EMOJI_RE = re.compile(
    "["
    "\U0001f1e0-\U0001f1ff"
    "\U0001f300-\U0001f5ff"
    "\U0001f600-\U0001f64f"
    "\U0001f680-\U0001f6ff"
    "\U0001f700-\U0001f77f"
    "\U0001f780-\U0001f7ff"
    "\U0001f800-\U0001f8ff"
    "\U0001f900-\U0001f9ff"
    "\U0001fa00-\U0001fa6f"
    "\U0001fa70-\U0001faff"
    "\u2600-\u26ff"
    "\u2700-\u27bf"
    "\ufe0f"
    "\u200d"
    "]+",
)


def strip_emojis(text: str) -> str:
    """Remove any emoji or pictographic code points and collapse extra horizontal whitespace."""
    cleaned = _EMOJI_RE.sub("", text)
    return re.sub(r"[ \t]{2,}", " ", cleaned).strip()


class StructuredJsonFormatter(logging.Formatter):
    """Cloud Logging compatible single-line JSON formatter with emoji sanitization."""

    def __init__(self, *, service: str, region: str) -> None:
        super().__init__()
        self._service = service
        self._region = region

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "timestamp": datetime.now(UTC).isoformat(),
            "severity": record.levelname,
            "service": self._service,
            "region": self._region,
            "logger": record.name,
            "message": strip_emojis(record.getMessage()),
        }
        structured = getattr(record, "structured", None)
        if isinstance(structured, dict):
            for key, val in structured.items():
                payload[str(key)] = strip_emojis(val) if isinstance(val, str) else val
        if record.exc_info:
            payload["exception"] = strip_emojis(self.formatException(record.exc_info))
        return json.dumps(payload, default=str, ensure_ascii=True)


def configure_logging(*, service: str, region: str, level: int = logging.INFO) -> None:
    """Configure root logger once with structured JSON output to stderr."""
    root = logging.getLogger()
    root.setLevel(level)
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(StructuredJsonFormatter(service=service, region=region))
    root.handlers.clear()
    root.addHandler(handler)


def log_event(
    logger: logging.Logger,
    level: int,
    event: str,
    **fields: Any,
) -> None:
    """Emit a structured JSON log entry."""
    logger.log(level, event, extra={"structured": {"event": event, **fields}})
