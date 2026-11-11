"""Settings for slrr-signals: config/signals.yaml (SIGNALS_CONFIG overrides the path, GOOGLE_CLOUD_PROJECT the project)."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CONFIG = ROOT / "config" / "signals.yaml"


class Settings:
    """Read-only view over the YAML, with dotted lookups (settings.get("track1.min_confidence"))."""

    def __init__(self, raw: dict[str, Any]):
        self.raw = raw or {}

    def get(self, dotted: str, default: Any = None) -> Any:
        cur: Any = self.raw
        for part in dotted.split("."):
            if not isinstance(cur, dict) or part not in cur:
                return default
            cur = cur[part]
        return cur

    @property
    def project(self) -> str:
        return os.environ.get("GOOGLE_CLOUD_PROJECT") or str(self.get("project", "brand-social-central-data"))

    @property
    def dataset(self) -> str:
        return str(self.get("dataset", "slrr_signals"))

    @property
    def dataset_location(self) -> str:
        return str(self.get("dataset_location", "US"))

    def table(self, name: str) -> str:
        """A table of the dataset, as project.dataset.table."""
        return f"{self.project}.{self.dataset}.{name}"

    def source(self, key: str) -> dict[str, Any]:
        return dict(self.get(f"sources.{key}", {}) or {})

    @property
    def networks(self) -> list[str]:
        return [str(n).lower() for n in (self.get("networks", []) or [])]

    @property
    def labels(self) -> dict[str, str]:
        return {str(k): str(v) for k, v in (self.get("labels", {}) or {}).items()}

    @property
    def agent_config_path(self) -> Path:
        p = Path(str(self.get("agent_config", "config/default_config.yaml")))
        return p if p.is_absolute() else ROOT / p


def load_settings(path: str | Path | None = None) -> Settings:
    p = Path(path or os.environ.get("SIGNALS_CONFIG") or DEFAULT_CONFIG)
    with p.open(encoding="utf-8") as f:
        return Settings(yaml.safe_load(f) or {})
