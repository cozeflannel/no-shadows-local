"""Secrets and credentials, managed from the Console.

GCP: Secret Manager. Local: a file under .local/ (mode 600) with the same interface. A secret's value is write-only
from the Console: it can be set and replaced, never read back; the API returns names, versions and states only.
Only secrets whose name starts with Settings → GCP → secret_prefix are shown or changed.
"""

from __future__ import annotations

import json
import logging
import os
import re
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Any, Protocol

if TYPE_CHECKING:  # pragma: no cover
    from .context import AgentContext

log = logging.getLogger(__name__)
SECRET_NAME = re.compile(r"^[A-Za-z0-9_-]{1,255}$")


class SecretError(RuntimeError):
    pass


class SecretGateway(Protocol):
    def list(self, prefix: str = "") -> list[dict[str, Any]]: ...
    def create(self, name: str, value: str | None = None, labels: dict[str, str] | None = None) -> dict[str, Any]: ...
    def add_version(self, name: str, value: str) -> dict[str, Any]: ...
    def versions(self, name: str) -> list[dict[str, Any]]: ...
    def set_version_state(self, name: str, version: str, state: str) -> dict[str, Any]: ...
    def access(self, name: str, version: str = "latest") -> str: ...


class SecretManagerGateway:
    def __init__(self, project: str):
        from google.cloud import secretmanager

        if not project:
            raise SecretError("No project for Secret Manager: set Settings → GCP → Project.")
        self._sm = secretmanager
        self.project = project
        self.client = secretmanager.SecretManagerServiceClient()

    def _secret(self, name: str) -> str:
        return f"projects/{self.project}/secrets/{name}"

    def list(self, prefix: str = "") -> list[dict[str, Any]]:
        out = []
        for s in self.client.list_secrets(request={"parent": f"projects/{self.project}"}):
            name = s.name.rsplit("/", 1)[-1]
            if prefix and not name.startswith(prefix):
                continue
            out.append({"name": name, "created": s.create_time.isoformat() if s.create_time else None, "labels": dict(s.labels)})
        return sorted(out, key=lambda s: s["name"])

    def create(self, name: str, value: str | None = None, labels: dict[str, str] | None = None) -> dict[str, Any]:
        self.client.create_secret(request={"parent": f"projects/{self.project}", "secret_id": name,
                                           "secret": {"replication": {"automatic": {}}, "labels": labels or {}}})
        if value is not None:
            self.add_version(name, value)
        return {"name": name}

    def add_version(self, name: str, value: str) -> dict[str, Any]:
        v = self.client.add_secret_version(request={"parent": self._secret(name), "payload": {"data": value.encode("utf-8")}})
        return {"name": name, "version": v.name.rsplit("/", 1)[-1], "state": v.state.name}

    def versions(self, name: str) -> list[dict[str, Any]]:
        out = []
        for v in self.client.list_secret_versions(request={"parent": self._secret(name)}):
            out.append({"version": v.name.rsplit("/", 1)[-1], "state": v.state.name,
                        "created": v.create_time.isoformat() if v.create_time else None})
        return out

    def set_version_state(self, name: str, version: str, state: str) -> dict[str, Any]:
        path = f"{self._secret(name)}/versions/{version}"
        if state == "ENABLED":
            v = self.client.enable_secret_version(request={"name": path})
        elif state == "DISABLED":
            v = self.client.disable_secret_version(request={"name": path})
        elif state == "DESTROYED":
            v = self.client.destroy_secret_version(request={"name": path})
        else:
            raise SecretError("State must be ENABLED, DISABLED or DESTROYED.")
        return {"name": name, "version": version, "state": v.state.name}

    def access(self, name: str, version: str = "latest") -> str:
        resp = self.client.access_secret_version(request={"name": f"{self._secret(name)}/versions/{version}"})
        return resp.payload.data.decode("utf-8")


class LocalSecrets:
    """Secrets in a local file for the local backend (never used on GCP)."""

    def __init__(self, path: str | Path):
        self.path = Path(path)
        self._lock = threading.Lock()

    def _load(self) -> dict[str, Any]:
        if not self.path.exists():
            return {}
        return json.loads(self.path.read_text(encoding="utf-8") or "{}")

    def _save(self, data: dict[str, Any]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(data), encoding="utf-8")
        try:
            os.chmod(self.path, 0o600)
        except OSError:
            pass

    def list(self, prefix: str = "") -> list[dict[str, Any]]:
        with self._lock:
            data = self._load()
        return sorted(({"name": n, "created": s.get("created"), "labels": s.get("labels", {})}
                       for n, s in data.items() if n.startswith(prefix)), key=lambda s: s["name"])

    def create(self, name: str, value: str | None = None, labels: dict[str, str] | None = None) -> dict[str, Any]:
        with self._lock:
            data = self._load()
            if name in data:
                raise SecretError(f"A secret named {name} already exists.")
            data[name] = {"created": datetime.now(timezone.utc).isoformat(), "labels": labels or {}, "versions": []}
            self._save(data)
        if value is not None:
            self.add_version(name, value)
        return {"name": name}

    def add_version(self, name: str, value: str) -> dict[str, Any]:
        with self._lock:
            data = self._load()
            if name not in data:
                raise SecretError(f"There is no secret named {name}.")
            versions = data[name]["versions"]
            versions.append({"version": str(len(versions) + 1), "state": "ENABLED", "value": value,
                             "created": datetime.now(timezone.utc).isoformat()})
            self._save(data)
            return {"name": name, "version": versions[-1]["version"], "state": "ENABLED"}

    def versions(self, name: str) -> list[dict[str, Any]]:
        with self._lock:
            data = self._load()
        if name not in data:
            raise SecretError(f"There is no secret named {name}.")
        return [{"version": v["version"], "state": v["state"], "created": v.get("created")} for v in reversed(data[name]["versions"])]

    def set_version_state(self, name: str, version: str, state: str) -> dict[str, Any]:
        if state not in ("ENABLED", "DISABLED", "DESTROYED"):
            raise SecretError("State must be ENABLED, DISABLED or DESTROYED.")
        with self._lock:
            data = self._load()
            for v in data.get(name, {}).get("versions", []):
                if v["version"] == version:
                    if v["state"] == "DESTROYED":
                        raise SecretError("A destroyed version can't be brought back.")
                    v["state"] = state
                    if state == "DESTROYED":
                        v["value"] = ""
                    self._save(data)
                    return {"name": name, "version": version, "state": state}
        raise SecretError(f"{name} has no version {version}.")

    def access(self, name: str, version: str = "latest") -> str:
        with self._lock:
            data = self._load()
        versions = [v for v in data.get(name, {}).get("versions", []) if v["state"] == "ENABLED"]
        if version != "latest":
            versions = [v for v in versions if v["version"] == version]
        if not versions:
            raise SecretError(f"{name} has no enabled version.")
        return versions[-1]["value"]


def get_gateway(ctx: "AgentContext") -> SecretGateway:
    if ctx.secrets is not None:
        return ctx.secrets
    if os.environ.get("TRIAGE_BACKEND", "local") == "gcp":
        cfg = ctx.config.platform
        project = cfg.gcp.project or os.environ.get("TRIAGE_PROJECT_ID") or os.environ.get("GOOGLE_CLOUD_PROJECT") or ""
        ctx.secrets = SecretManagerGateway(project)
    else:
        base = Path(os.environ.get("TRIAGE_LOCAL_DB", ".local/triage.db")).parent
        ctx.secrets = LocalSecrets(base / "secrets.json")
    return ctx.secrets


def check_name(ctx: "AgentContext", name: str) -> str:
    name = (name or "").strip()
    if not SECRET_NAME.match(name):
        raise SecretError("A secret name uses letters, digits, hyphens and underscores.")
    prefix = ctx.config.platform.gcp.secret_prefix
    if prefix and not name.startswith(prefix):
        raise SecretError(f"The Console only manages secrets whose name starts with “{prefix}”.")
    return name


def read(ctx: "AgentContext", name: str) -> str:
    """A secret's value, for the agent's own use (never returned to the Console)."""
    if not name:
        raise SecretError("No secret name is set.")
    return get_gateway(ctx).access(name)
