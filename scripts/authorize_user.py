"""One-time Google User OAuth consent helper storing client JSON and refresh token in Secret Manager."""

from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path

from google_auth_oauthlib.flow import InstalledAppFlow

from slrr_campaigns.auth import (
    USER_OAUTH_SCOPES,
    AuthFailureError,
    SecretStore,
    extract_oauth_client_config,
    load_user_oauth_credentials,
)
from slrr_campaigns.config import load_config
from slrr_campaigns.logging_utils import configure_logging, log_event

logger = logging.getLogger(__name__)


def _read_or_prompt_client_json(
    *,
    explicit_path: str,
    secrets: SecretStore,
    secret_name: str,
    chat_project_id: str,
) -> str:
    if explicit_path:
        raw = Path(explicit_path).expanduser().read_text(encoding="utf-8").strip()
        extract_oauth_client_config(raw, chat_project_id)
        return raw

    try:
        existing = secrets.read_secret(secret_name)
        extract_oauth_client_config(existing, chat_project_id)
        return existing
    except AuthFailureError:
        pass

    sys.stdout.write(
        f"Enter path to OAuth Desktop client JSON created in GCP project '{chat_project_id}': ",
    )
    sys.stdout.flush()
    entered = sys.stdin.readline().strip()
    if not entered:
        raise AuthFailureError(
            f"No OAuth client JSON provided. Create an OAuth Desktop client in GCP project "
            f"'{chat_project_id}' and pass --client-secrets /path/to/client_secret.json.",
            service_name="oauth",
        )
    client_path = Path(entered).expanduser()
    if not client_path.is_file():
        raise AuthFailureError(f"OAuth client JSON file not found: {client_path}", service_name="oauth")
    raw = client_path.read_text(encoding="utf-8").strip()
    extract_oauth_client_config(raw, chat_project_id)
    return raw


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Authorize Google User OAuth for slrr-campaigns.")
    parser.add_argument(
        "--client-secrets",
        default="",
        help="Path to OAuth Desktop client JSON from the Chat GCP project.",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Force interactive browser consent even if a valid refresh token already exists.",
    )
    args = parser.parse_args(argv)

    cfg = load_config()
    configure_logging(service=cfg.cloud_run_service, region=cfg.cloud_run_region)
    secrets = SecretStore(cfg.gcp_project_id)

    if not args.force and not args.client_secrets:
        try:
            load_user_oauth_credentials(cfg, secrets)
            log_event(
                logger,
                logging.INFO,
                "user_oauth_already_valid",
                chat_project_id=cfg.chat_project_id,
                oauth_client_secret=cfg.secrets.oauth_client_json,
                oauth_refresh_secret=cfg.secrets.oauth_refresh_token,
            )
            sys.stdout.write("User OAuth credentials in Secret Manager are already valid.\n")
            return 0
        except AuthFailureError:
            pass

    raw_client_json = _read_or_prompt_client_json(
        explicit_path=str(args.client_secrets or "").strip(),
        secrets=secrets,
        secret_name=cfg.secrets.oauth_client_json,
        chat_project_id=cfg.chat_project_id,
    )
    client_config = json.loads(raw_client_json)
    flow = InstalledAppFlow.from_client_config(client_config, scopes=list(USER_OAUTH_SCOPES))
    creds = flow.run_local_server(port=0, access_type="offline", prompt="consent")
    refresh_token = str(creds.refresh_token or "").strip()
    if not refresh_token:
        raise AuthFailureError(
            "Browser consent completed without returning a refresh_token; "
            "ensure prompt='consent' was accepted.",
            service_name="oauth",
        )

    secrets.write_secret(cfg.secrets.oauth_client_json, raw_client_json)
    secrets.write_secret(cfg.secrets.oauth_refresh_token, refresh_token)
    # Verify round-trip refresh from Secret Manager immediately.
    load_user_oauth_credentials(cfg, secrets)
    log_event(
        logger,
        logging.INFO,
        "user_oauth_stored_and_verified",
        chat_project_id=cfg.chat_project_id,
        oauth_client_secret=cfg.secrets.oauth_client_json,
        oauth_refresh_secret=cfg.secrets.oauth_refresh_token,
    )
    sys.stdout.write("Stored and verified Google User OAuth client and refresh token in Secret Manager.\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
