"""Verify 1-to-1 parity of config keys, environment variables, and secrets across setup and code."""

from __future__ import annotations

import ast
import re
import sys
from pathlib import Path
from typing import Any

import yaml

from slrr_campaigns.config import CONFIG_ENV_VAR, CampaignsConfig, SecretNamesConfig

ROOT = Path(__file__).resolve().parent.parent
YAML_PATH = ROOT / "config" / "campaigns.yaml"
SETUP_SH_PATH = ROOT / "setup.sh"
CODE_PATHS = [
    *sorted((ROOT / "slrr_campaigns").glob("*.py")),
    ROOT / "scripts" / "authorize_user.py",
]


def _flatten_yaml_keys(raw: dict[str, Any], prefix: str = "") -> set[str]:
    keys: set[str] = set()
    for k, v in raw.items():
        full = f"{prefix}.{k}" if prefix else str(k)
        if isinstance(v, dict):
            keys |= _flatten_yaml_keys(v, full)
        else:
            keys.add(full)
    return keys


def _model_leaf_keys() -> set[str]:
    keys: set[str] = set()
    for name in CampaignsConfig.model_fields:
        if name == "secrets":
            for sname in SecretNamesConfig.model_fields:
                keys.add(f"secrets.{sname}")
        else:
            keys.add(name)
    return keys


def _collect_code_reads() -> tuple[set[str], set[str], set[str]]:
    """Return (config_keys_read, env_vars_read, secret_fields_read) from Python ASTs."""
    model_top = set(CampaignsConfig.model_fields.keys()) - {"secrets"}
    secret_fields = set(SecretNamesConfig.model_fields.keys())

    cfg_reads: set[str] = set()
    secret_reads: set[str] = set()
    env_reads: set[str] = set()

    for py_path in CODE_PATHS:
        tree = ast.parse(py_path.read_text(encoding="utf-8"), filename=str(py_path))
        for node in ast.walk(tree):
            if isinstance(node, ast.Attribute):
                if node.attr in model_top:
                    cfg_reads.add(node.attr)
                if (
                    isinstance(node.value, ast.Attribute)
                    and node.value.attr == "secrets"
                    and node.attr in secret_fields
                ):
                    cfg_reads.add(f"secrets.{node.attr}")
                    secret_reads.add(node.attr)
            if isinstance(node, ast.Call):
                func = node.func
                # Match os.environ.get(...) or os.getenv(...)
                is_env_get = (
                    isinstance(func, ast.Attribute)
                    and func.attr == "get"
                    and isinstance(func.value, ast.Attribute)
                    and func.value.attr == "environ"
                ) or (
                    isinstance(func, ast.Attribute)
                    and func.attr == "getenv"
                    and isinstance(func.value, ast.Name)
                    and func.value.id == "os"
                )
                if is_env_get and node.args:
                    arg0 = node.args[0]
                    if isinstance(arg0, ast.Constant) and isinstance(arg0.value, str):
                        env_reads.add(arg0.value)
                    elif isinstance(arg0, ast.Name) and arg0.id == "CONFIG_ENV_VAR":
                        env_reads.add(CONFIG_ENV_VAR)

    return cfg_reads, env_reads, secret_reads


def _collect_setup_references(setup_text: str) -> tuple[set[str], set[str], set[str]]:
    """Extract config keys, Cloud Run --set-env-vars, and secret fields handled by setup.sh."""
    model_keys = _model_leaf_keys()
    setup_cfg_keys: set[str] = set()
    for key in model_keys:
        if key in setup_text:
            setup_cfg_keys.add(key)

    env_vars: set[str] = set()
    for match in re.finditer(r"--set-env-vars=[\"']([^\"']+)[\"']", setup_text):
        pairs = match.group(1).split(",")
        for pair in pairs:
            if "=" in pair:
                env_name = pair.split("=", 1)[0].strip()
                if env_name:
                    env_vars.add(env_name)

    secret_fields: set[str] = set()
    for sfield in SecretNamesConfig.model_fields:
        if f"secrets.{sfield}" in setup_text:
            secret_fields.add(sfield)

    return setup_cfg_keys, env_vars, secret_fields


def main() -> int:
    errors: list[str] = []
    if not YAML_PATH.is_file():
        sys.stderr.write(f"Missing {YAML_PATH}\n")
        return 1
    if not SETUP_SH_PATH.is_file():
        sys.stderr.write(f"Missing {SETUP_SH_PATH}\n")
        return 1

    raw_yaml = yaml.safe_load(YAML_PATH.read_text(encoding="utf-8"))
    if not isinstance(raw_yaml, dict):
        sys.stderr.write("config/campaigns.yaml must be a YAML mapping\n")
        return 1

    yaml_keys = _flatten_yaml_keys(raw_yaml)
    model_keys = _model_leaf_keys()
    code_cfg_keys, code_env_vars, code_secret_fields = _collect_code_reads()
    setup_text = SETUP_SH_PATH.read_text(encoding="utf-8")
    setup_cfg_keys, setup_env_vars, setup_secret_fields = _collect_setup_references(setup_text)

    if yaml_keys != model_keys:
        errors.append(
            f"YAML keys vs CampaignsConfig mismatch: extra_yaml={sorted(yaml_keys - model_keys)}, "
            f"missing_yaml={sorted(model_keys - yaml_keys)}",
        )
    if code_cfg_keys != yaml_keys:
        errors.append(
            f"Config keys unread by code: {sorted(yaml_keys - code_cfg_keys)}; "
            f"extra in code: {sorted(code_cfg_keys - yaml_keys)}",
        )
    if setup_cfg_keys != yaml_keys:
        errors.append(
            f"Config keys missing from setup.sh: {sorted(yaml_keys - setup_cfg_keys)}; "
            f"extra in setup.sh: {sorted(setup_cfg_keys - yaml_keys)}",
        )
    if setup_env_vars != code_env_vars:
        errors.append(
            f"Environment variable mismatch: setup_sets={sorted(setup_env_vars)}, "
            f"code_reads={sorted(code_env_vars)}",
        )
    expected_secrets = set(SecretNamesConfig.model_fields.keys())
    if code_secret_fields != expected_secrets or setup_secret_fields != expected_secrets:
        errors.append(
            f"Secret parity mismatch: expected={sorted(expected_secrets)}, "
            f"setup_handles={sorted(setup_secret_fields)}, code_reads={sorted(code_secret_fields)}",
        )

    if errors:
        for err in errors:
            sys.stderr.write(f"check_config FAILED: {err}\n")
        return 1

    sys.stdout.write(
        f"check_config OK: {len(yaml_keys)} config keys, {len(code_env_vars)} env vars, "
        f"{len(expected_secrets)} secrets verified 1-to-1 across YAML, setup.sh, and Python code.\n",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
