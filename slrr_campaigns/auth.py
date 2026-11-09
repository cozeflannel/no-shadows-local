"""Secret Manager access, Google User OAuth credentials, and Brandwatch token management."""

from __future__ import annotations

import json
import logging
from typing import Any
from urllib.parse import urlencode

import httpx
from google.api_core.exceptions import GoogleAPICallError, NotFound
from google.auth.exceptions import RefreshError
from google.auth.transport.requests import Request
from google.cloud import secretmanager
from google.oauth2.credentials import Credentials

from .config import CampaignsConfig
from .logging_utils import log_event

logger = logging.getLogger(__name__)

BRANDWATCH_BASE_URL = "https://api.brandwatch.com"

USER_OAUTH_SCOPES: tuple[str, ...] = (
    "https://www.googleapis.com/auth/chat.spaces",
    "https://www.googleapis.com/auth/chat.delete",
    "https://www.googleapis.com/auth/chat.memberships",
    "https://www.googleapis.com/auth/chat.messages",
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/documents",
    "https://www.googleapis.com/auth/directory.readonly",
)


class AuthFailureError(RuntimeError):
    """Raised when Secret Manager, User OAuth, or Brandwatch authentication fails."""

    def __init__(self, message: str, *, service_name: str) -> None:
        super().__init__(message)
        self.service_name = service_name


class SecretStore:
    """Thin wrapper over Google Cloud Secret Manager that never logs secret payloads."""

    def __init__(self, project_id: str) -> None:
        self._project_id = project_id
        self._client = secretmanager.SecretManagerServiceClient()

    def read_secret(self, secret_name: str) -> str:
        """Read the latest version of a secret as stripped UTF-8 text."""
        resource = f"projects/{self._project_id}/secrets/{secret_name}/versions/latest"
        try:
            response = self._client.access_secret_version(request={"name": resource})
        except GoogleAPICallError as exc:
            log_event(
                logger,
                logging.ERROR,
                "secret_read_failed",
                secret_name=secret_name,
                error_type=type(exc).__name__,
            )
            raise AuthFailureError(
                f"Failed to read secret {secret_name} in project {self._project_id}: {exc}",
                service_name="secretmanager",
            ) from exc
        value = response.payload.data.decode("utf-8").strip()
        if not value:
            raise AuthFailureError(
                f"Secret {secret_name} in project {self._project_id} is empty",
                service_name="secretmanager",
            )
        return value

    def write_secret(self, secret_name: str, payload: str) -> None:
        """Create the secret if absent and add a new latest version."""
        parent = f"projects/{self._project_id}"
        secret_path = f"{parent}/secrets/{secret_name}"
        try:
            self._client.get_secret(request={"name": secret_path})
        except NotFound:
            self._client.create_secret(
                request={
                    "parent": parent,
                    "secret_id": secret_name,
                    "secret": {"replication": {"automatic": {}}},
                },
            )
        except GoogleAPICallError as exc:
            log_event(
                logger,
                logging.ERROR,
                "secret_get_failed",
                secret_name=secret_name,
                error_type=type(exc).__name__,
            )
            raise AuthFailureError(
                f"Failed to inspect secret {secret_name}: {exc}",
                service_name="secretmanager",
            ) from exc

        try:
            self._client.add_secret_version(
                request={
                    "parent": secret_path,
                    "payload": {"data": payload.encode("utf-8")},
                },
            )
        except GoogleAPICallError as exc:
            log_event(
                logger,
                logging.ERROR,
                "secret_write_failed",
                secret_name=secret_name,
                error_type=type(exc).__name__,
            )
            raise AuthFailureError(
                f"Failed to write secret version for {secret_name}: {exc}",
                service_name="secretmanager",
            ) from exc


def extract_oauth_client_config(raw_json: str, expected_chat_project_id: str) -> dict[str, Any]:
    """Extract installed or web OAuth client config and verify project ownership."""
    try:
        parsed = json.loads(raw_json)
    except json.JSONDecodeError as exc:
        raise AuthFailureError("Stored OAuth client JSON is not valid JSON", service_name="oauth") from exc
    if not isinstance(parsed, dict):
        raise AuthFailureError("Stored OAuth client JSON must be a JSON object", service_name="oauth")
    block = parsed.get("installed") or parsed.get("web")
    if not isinstance(block, dict):
        raise AuthFailureError(
            "OAuth client JSON must contain an 'installed' or 'web' section",
            service_name="oauth",
        )
    project_id = str(block.get("project_id") or "").strip()
    if project_id and project_id != expected_chat_project_id:
        raise AuthFailureError(
            f"OAuth client project_id '{project_id}' does not match "
            f"Chat project '{expected_chat_project_id}'",
            service_name="oauth",
        )
    client_id = str(block.get("client_id") or "").strip()
    client_secret = str(block.get("client_secret") or "").strip()
    token_uri = str(block.get("token_uri") or "https://oauth2.googleapis.com/token").strip()
    if not client_id or not client_secret:
        raise AuthFailureError(
            "OAuth client JSON is missing client_id or client_secret",
            service_name="oauth",
        )
    return {
        "client_id": client_id,
        "client_secret": client_secret,
        "token_uri": token_uri,
        "project_id": project_id or expected_chat_project_id,
    }


def load_user_oauth_credentials(cfg: CampaignsConfig, secrets: SecretStore) -> Credentials:
    """Build and refresh User OAuth credentials from Secret Manager."""
    raw_client = secrets.read_secret(cfg.secrets.oauth_client_json)
    refresh_token = secrets.read_secret(cfg.secrets.oauth_refresh_token)
    client_info = extract_oauth_client_config(raw_client, cfg.chat_project_id)
    creds = Credentials(  # type: ignore[no-untyped-call]
        token=None,
        refresh_token=refresh_token,
        token_uri=client_info["token_uri"],
        client_id=client_info["client_id"],
        client_secret=client_info["client_secret"],
        scopes=list(USER_OAUTH_SCOPES),
    )
    try:
        creds.refresh(Request())  # type: ignore[no-untyped-call]
    except RefreshError as exc:
        log_event(logger, logging.ERROR, "user_oauth_refresh_failed", error_type=type(exc).__name__)
        raise AuthFailureError(
            f"Failed to refresh Google User OAuth token: {exc}", service_name="oauth"
        ) from exc
    return creds


def mint_brandwatch_token(
    username: str, password: str, *, timeout_s: float = 30.0
) -> tuple[str, dict[str, str]]:
    """Mint a Brandwatch API bearer token via POST /oauth/token per documented flow."""
    raw_user = username.strip()
    platform_client_id = ""
    if "|" in raw_user:
        actual_user, platform_client_id = [p.strip() for p in raw_user.split("|", 1)]
    else:
        actual_user = raw_user

    params: dict[str, str] = {
        "username": actual_user,
        "grant_type": "api-password",
        "client_id": "brandwatch-api-client",
    }
    if platform_client_id:
        params["platform_client_id"] = platform_client_id

    query = urlencode(params)
    url = f"{BRANDWATCH_BASE_URL}/oauth/token?{query}"
    body = urlencode({"password": password})
    try:
        with httpx.Client(timeout=timeout_s) as client:
            resp = client.post(
                url,
                content=body.encode("utf-8"),
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
    except httpx.HTTPError as exc:
        log_event(logger, logging.ERROR, "brandwatch_auth_network_error", error_type=type(exc).__name__)
        raise AuthFailureError(f"Brandwatch token request failed: {exc}", service_name="brandwatch") from exc

    headers = {k.lower(): v for k, v in resp.headers.items()}
    if resp.status_code >= 400:
        err_detail = ""
        try:
            err_json = resp.json()
            if isinstance(err_json, dict):
                errs = err_json.get("errors")
                if isinstance(errs, list) and errs and isinstance(errs[0], dict):
                    err_detail = str(errs[0].get("message") or "")
                else:
                    err_detail = str(err_json.get("error_description") or err_json.get("error") or "")
        except ValueError:
            err_detail = ""
        log_event(
            logger,
            logging.ERROR,
            "brandwatch_auth_http_error",
            status_code=resp.status_code,
            error_detail=err_detail[:200],
            has_platform_client_id=bool(platform_client_id),
        )
        suffix = f" ({err_detail})" if err_detail else ""
        raise AuthFailureError(
            f"Brandwatch /oauth/token returned HTTP {resp.status_code}{suffix}",
            service_name="brandwatch",
        )
    data = resp.json()
    token = str(data.get("access_token") or "").strip()
    if not token:
        raise AuthFailureError(
            "Brandwatch /oauth/token response did not contain access_token",
            service_name="brandwatch",
        )
    return token, headers


class BrandwatchTokenProvider:
    """Provides the Brandwatch API token from Secret Manager and re-authenticates on 401."""

    def __init__(self, cfg: CampaignsConfig, secrets: SecretStore) -> None:
        self._cfg = cfg
        self._secrets = secrets
        self._cached_token: str = ""

    def get_token(self) -> str:
        """Return cached or Secret Manager Brandwatch bearer token."""
        if not self._cached_token:
            self._cached_token = self._secrets.read_secret(self._cfg.secrets.brandwatch_token)
        return self._cached_token

    def refresh_on_unauthorized(self) -> str:
        """Mint a fresh Brandwatch token using stored credentials and persist it to Secret Manager."""
        username = self._secrets.read_secret(self._cfg.secrets.brandwatch_username)
        password = self._secrets.read_secret(self._cfg.secrets.brandwatch_password)
        token, _headers = mint_brandwatch_token(username, password)
        self._secrets.write_secret(self._cfg.secrets.brandwatch_token, token)
        self._cached_token = token
        log_event(logger, logging.INFO, "brandwatch_token_refreshed", username=username)
        return token
