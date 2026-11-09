"""Typed configuration loader reading resource IDs from config/campaigns.yaml."""

from __future__ import annotations

import os
from pathlib import Path

import yaml
from pydantic import BaseModel, ConfigDict, Field

CONFIG_ENV_VAR = "SLRR_CAMPAIGNS_CONFIG"
DEFAULT_CONFIG_PATH = "config/campaigns.yaml"


class SecretNamesConfig(BaseModel):
    """Secret Manager secret resource names."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    oauth_client_json: str = Field(min_length=1)
    oauth_refresh_token: str = Field(min_length=1)
    brandwatch_username: str = Field(min_length=1)
    brandwatch_password: str = Field(min_length=1)
    brandwatch_token: str = Field(min_length=1)


class CampaignsConfig(BaseModel):
    """Immutable resource-ID configuration for slrr-campaigns."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    gcp_project_id: str = Field(min_length=1)
    chat_project_id: str = Field(min_length=1)
    cloud_run_region: str = Field(min_length=1)
    cloud_run_service: str = Field(min_length=1)
    firestore_database: str = Field(min_length=1)
    alerts_space: str = Field(min_length=1)
    forbidden_burson_space: str = Field(min_length=1)
    drive_folder_id: str
    registry_spreadsheet_id: str
    kof_spreadsheet_id: str = Field(min_length=1)
    bigquery_sundar_table: str = Field(min_length=1)
    bigquery_brandwatch_table: str = Field(min_length=1)
    brandwatch_project_ids: list[int] = Field(min_length=1)
    secrets: SecretNamesConfig

    def require_provisioned_ids(self) -> None:
        """Raise ValueError if setup-created Drive or Registry IDs have not been populated yet."""
        if not self.drive_folder_id.strip():
            raise ValueError("drive_folder_id is empty in config/campaigns.yaml; run ./setup.sh first")
        if not self.registry_spreadsheet_id.strip():
            raise ValueError(
                "registry_spreadsheet_id is empty in config/campaigns.yaml; run ./setup.sh first"
            )
        if self.alerts_space == self.forbidden_burson_space:
            raise ValueError("alerts_space must never equal forbidden_burson_space")


def resolve_config_path(explicit_path: str | Path | None = None) -> Path:
    """Resolve the path to config/campaigns.yaml from explicit argument or SLRR_CAMPAIGNS_CONFIG."""
    if explicit_path is not None:
        return Path(explicit_path)
    env_path = os.environ.get(CONFIG_ENV_VAR, "").strip()
    return Path(env_path if env_path else DEFAULT_CONFIG_PATH)


def load_config(explicit_path: str | Path | None = None) -> CampaignsConfig:
    """Load and validate CampaignsConfig from YAML."""
    path = resolve_config_path(explicit_path)
    raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise ValueError(f"Expected mapping in {path}")
    return CampaignsConfig.model_validate(raw)
