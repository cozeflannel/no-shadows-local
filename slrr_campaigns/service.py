"""FastAPI Cloud Run entry point (/tick, /hourly, /daily), bootstrap, and live preflight."""

from __future__ import annotations

import argparse
import json
import logging
import sys
import time
from typing import Any

import uvicorn
import yaml
from fastapi import FastAPI, HTTPException
from triage_agent.llm import LLMError

from .auth import AuthFailureError, BrandwatchTokenProvider, SecretStore, load_user_oauth_credentials
from .bigquery_mentions import BigQueryMentionsClient, BigQueryMentionsError
from .brandwatch import BrandwatchApiError, BrandwatchClient
from .config import CampaignsConfig, load_config, resolve_config_path
from .conversation import process_campaign_spaces, process_owned_threads
from .gemini_flows import GeminiFlows
from .ingest import ingest_campaign_emails
from .logging_utils import configure_logging, log_event
from .provisioning import (
    close_expired_campaigns,
    run_hourly_volume_guard,
    send_due_shutdown_notices,
)
from .registry import (
    ensure_registry_spreadsheet,
    load_registry_settings,
    run_orphan_sweep,
    sync_registry,
)
from .store import CampaignStore, StoreError
from .workspace import (
    CHROME_ALERTS_GMAIL_QUERY,
    GMAIL_CAMPAIGN_QUERY,
    WorkspaceApiError,
    WorkspaceClients,
)

logger = logging.getLogger(__name__)
DRIVE_FOLDER_NAME = "SLRR Brandwatch Campaigns"

app = FastAPI(
    title="slrr-campaigns",
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)


class RuntimeDependencies:
    """Live clients wired from CampaignsConfig and Secret Manager."""

    def __init__(self, cfg: CampaignsConfig) -> None:
        cfg.require_provisioned_ids()
        configure_logging(service=cfg.cloud_run_service, region=cfg.cloud_run_region)
        self.cfg = cfg
        self.store = CampaignStore(cfg)
        self.secrets = SecretStore(cfg.gcp_project_id)
        self.bw_tokens = BrandwatchTokenProvider(cfg, self.secrets)
        self.bw = BrandwatchClient(cfg, self.store, self.bw_tokens)
        creds = load_user_oauth_credentials(cfg, self.secrets)
        self.workspace = WorkspaceClients(cfg, self.store, creds)
        self.bq = BigQueryMentionsClient(cfg)
        self.gemini = GeminiFlows(cfg)


def build_runtime() -> RuntimeDependencies:
    """Instantiate RuntimeDependencies from config/campaigns.yaml."""
    cfg = load_config()
    return RuntimeDependencies(cfg)


@app.post("/tick")
def handle_tick() -> dict[str, Any]:
    """Every-minute scheduler job: owned threads, campaign spaces, email ingest, registry sync."""
    try:
        rt = build_runtime()
        settings = load_registry_settings(rt.cfg, rt.workspace)
        threads_res = process_owned_threads(
            cfg=rt.cfg,
            store=rt.store,
            bw=rt.bw,
            bq=rt.bq,
            workspace=rt.workspace,
            gemini=rt.gemini,
            settings=settings,
        )
        spaces_res = process_campaign_spaces(
            cfg=rt.cfg,
            store=rt.store,
            bw=rt.bw,
            bq=rt.bq,
            workspace=rt.workspace,
            gemini=rt.gemini,
            settings=settings,
        )
        ingest_res = ingest_campaign_emails(
            cfg=rt.cfg,
            store=rt.store,
            workspace=rt.workspace,
            bq=rt.bq,
            gemini=rt.gemini,
            settings=settings,
        )
        closed_expired = close_expired_campaigns(
            cfg=rt.cfg,
            store=rt.store,
            bw=rt.bw,
            workspace=rt.workspace,
            bq=rt.bq,
            gemini=rt.gemini,
            settings=settings,
        )
        reg_res = sync_registry(
            cfg=rt.cfg,
            store=rt.store,
            bw=rt.bw,
            workspace=rt.workspace,
            bq=rt.bq,
            gemini=rt.gemini,
            settings=settings,
        )
        summary: dict[str, Any] = {
            "status": "ok",
            "threads": threads_res,
            "spaces": spaces_res,
            "ingest": ingest_res,
            "closed_expired": closed_expired,
            "registry": reg_res,
            "bw_calls": rt.bw.call_count,
        }
        log_event(logger, logging.INFO, "tick_completed", **summary)
        return summary
    except (
        AuthFailureError,
        BrandwatchApiError,
        WorkspaceApiError,
        BigQueryMentionsError,
        StoreError,
        LLMError,
        ValueError,
        RuntimeError,
    ) as exc:
        log_event(
            logger,
            logging.ERROR,
            "tick_failed",
            error_type=type(exc).__name__,
            error_message=str(exc)[:400],
        )
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/hourly")
def handle_hourly() -> dict[str, Any]:
    """Hourly scheduler job: volume guard, 24h shutdown notices, and registry health."""
    try:
        rt = build_runtime()
        owner_email = rt.workspace.get_mailbox_email()
        ensure_registry_spreadsheet(
            cfg=rt.cfg,
            workspace=rt.workspace,
            folder_id=rt.cfg.drive_folder_id,
            owner_email=owner_email,
            existing_spreadsheet_id=rt.cfg.registry_spreadsheet_id,
        )
        settings = load_registry_settings(rt.cfg, rt.workspace)
        vol_res = run_hourly_volume_guard(
            cfg=rt.cfg,
            store=rt.store,
            bw=rt.bw,
            workspace=rt.workspace,
            bq=rt.bq,
            gemini=rt.gemini,
            settings=settings,
        )
        notices_sent = send_due_shutdown_notices(
            store=rt.store,
            workspace=rt.workspace,
        )
        reg_res = sync_registry(
            cfg=rt.cfg,
            store=rt.store,
            bw=rt.bw,
            workspace=rt.workspace,
            bq=rt.bq,
            gemini=rt.gemini,
            settings=settings,
        )
        summary: dict[str, Any] = {
            "status": "ok",
            "volume_guard": vol_res,
            "shutdown_notices_sent": notices_sent,
            "registry": reg_res,
            "bw_calls": rt.bw.call_count,
        }
        log_event(logger, logging.INFO, "hourly_completed", **summary)
        return summary
    except (
        AuthFailureError,
        BrandwatchApiError,
        WorkspaceApiError,
        BigQueryMentionsError,
        StoreError,
        LLMError,
        ValueError,
        RuntimeError,
    ) as exc:
        log_event(
            logger,
            logging.ERROR,
            "hourly_failed",
            error_type=type(exc).__name__,
            error_message=str(exc)[:400],
        )
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/daily")
def handle_daily() -> dict[str, Any]:
    """Daily scheduler job: SLRR-CMP-* orphan sweep and 24-hour Brandwatch metadata cache refresh."""
    try:
        rt = build_runtime()
        cache_res = rt.bw.refresh_daily_caches()
        sweep_res = run_orphan_sweep(
            cfg=rt.cfg,
            store=rt.store,
            bw=rt.bw,
            workspace=rt.workspace,
        )
        summary: dict[str, Any] = {
            "status": "ok",
            "orphan_sweep": sweep_res,
            "cache_refresh": cache_res,
            "bw_calls": rt.bw.call_count,
        }
        log_event(logger, logging.INFO, "daily_completed", **summary)
        return summary
    except (
        AuthFailureError,
        BrandwatchApiError,
        WorkspaceApiError,
        StoreError,
        ValueError,
        RuntimeError,
    ) as exc:
        log_event(
            logger,
            logging.ERROR,
            "daily_failed",
            error_type=type(exc).__name__,
            error_message=str(exc)[:400],
        )
        raise HTTPException(status_code=500, detail=str(exc)) from exc


def bootstrap_workspace_resources() -> dict[str, str]:
    """Idempotently provision Drive folder and Registry sheet, persisting IDs to config/campaigns.yaml."""
    cfg_path = resolve_config_path()
    cfg = load_config(cfg_path)
    configure_logging(service=cfg.cloud_run_service, region=cfg.cloud_run_region)
    store = CampaignStore(cfg)
    secrets = SecretStore(cfg.gcp_project_id)
    creds = load_user_oauth_credentials(cfg, secrets)
    workspace = WorkspaceClients(cfg, store, creds)

    folder_id = cfg.drive_folder_id.strip()
    if not folder_id or not workspace.drive_file_exists(folder_id):
        folder_id = workspace.ensure_drive_folder(DRIVE_FOLDER_NAME)

    owner_email = workspace.get_mailbox_email()
    existing_reg = cfg.registry_spreadsheet_id.strip()
    if existing_reg and not workspace.drive_file_exists(existing_reg):
        existing_reg = ""

    registry_id = ensure_registry_spreadsheet(
        cfg=cfg,
        workspace=workspace,
        folder_id=folder_id,
        owner_email=owner_email,
        existing_spreadsheet_id=existing_reg,
    )
    registry_url = f"https://docs.google.com/spreadsheets/d/{registry_id}/edit"

    raw_yaml = yaml.safe_load(cfg_path.read_text(encoding="utf-8"))
    if not isinstance(raw_yaml, dict):
        raise ValueError(f"Expected YAML mapping in {cfg_path}")
    if raw_yaml.get("drive_folder_id") != folder_id or raw_yaml.get("registry_spreadsheet_id") != registry_id:
        raw_yaml["drive_folder_id"] = folder_id
        raw_yaml["registry_spreadsheet_id"] = registry_id
        cfg_path.write_text(yaml.safe_dump(raw_yaml, sort_keys=False), encoding="utf-8")

    return {
        "drive_folder_id": folder_id,
        "registry_spreadsheet_id": registry_id,
        "registry_url": registry_url,
        "owner_email": owner_email,
    }


def run_live_preflight() -> dict[str, Any]:
    """Execute every live preflight verification check required by ./setup.sh."""
    rt = build_runtime()
    mailbox_email = rt.workspace.get_mailbox_email()
    setup_user_id = rt.workspace.resolve_email_to_chat_user(mailbox_email)

    recent_alerts = rt.workspace.list_recent_space_messages(rt.cfg.alerts_space, page_size=5)

    stamp = int(time.time())
    temp_space = rt.workspace.setup_space(
        display_name=f"SLRR Campaigns Preflight {stamp}",
        external_user_allowed=False,
        member_user_names=[],
        ephemeral=True,
    )
    temp_space_name = str(temp_space.get("name") or "")
    created_msg_name = ""
    try:
        msg = rt.workspace.post_message(
            temp_space_name,
            "SLRR Campaigns preflight write check (temporary space, deleting immediately).",
        )
        created_msg_name = str(msg.get("name") or "")
    finally:
        rt.workspace.delete_space(temp_space_name)
        if created_msg_name:
            rt.store.delete_test_documents(message_names=[created_msg_name])

    probe_doc_id, _ = rt.workspace.create_report_doc(
        title=f"SLRR Campaigns Preflight Doc {stamp}",
        folder_id=rt.cfg.drive_folder_id,
        content="SLRR Campaigns preflight Google Docs write/read/delete probe.",
    )
    try:
        doc_text = rt.workspace.read_doc_text(probe_doc_id)
        if "preflight Google Docs" not in doc_text:
            raise RuntimeError("Google Docs read-back did not match written preflight text")
    finally:
        rt.workspace.delete_drive_file(probe_doc_id)
    if rt.workspace.drive_file_exists(probe_doc_id):
        raise RuntimeError(f"Google Drive preflight doc {probe_doc_id} still exists after deletion")

    me_data = rt.bw.get_me()
    client_data = rt.bw.get_client()
    rt.bw.list_projects()
    rt.bw.get_cached_queries()
    rt.bw.get_filters()
    rt.bw.get_metrics()
    rt.bw.get_exclusion_snippets(language="en")
    gemini_bool = rt.gemini.preflight_ping()

    cmp_ids = set(rt.workspace.search_gmail_message_ids(GMAIL_CAMPAIGN_QUERY, max_results=20))
    chrome_ids = set(rt.workspace.search_gmail_message_ids(CHROME_ALERTS_GMAIL_QUERY, max_results=20))
    overlap = cmp_ids & chrome_ids
    if overlap:
        raise RuntimeError(f"Gmail partition queries overlapped on message IDs: {sorted(overlap)}")

    settings = load_registry_settings(rt.cfg, rt.workspace)
    bq_counts = rt.bq.preflight_check()

    return {
        "mailbox_email": mailbox_email,
        "setup_user_id": setup_user_id,
        "alerts_space_messages_read": len(recent_alerts),
        "temp_space_verified_deleted": temp_space_name,
        "temp_doc_verified_deleted": probe_doc_id,
        "brandwatch_user_id": me_data.get("id"),
        "brandwatch_client_name": client_data.get("name") or client_data.get("id"),
        "brandwatch_rate_limit": rt.bw.last_rate_limit,
        "brandwatch_rate_used": rt.bw.last_rate_used,
        "gemini_preflight_boolean": gemini_bool,
        "gmail_partition_disjoint": True,
        "registry_approvers": settings.approver_emails,
        "bigquery_dsd_7d": bq_counts["dsd_7d"],
        "bigquery_brandwatch_7d": bq_counts["brandwatch_7d"],
    }


def main(argv: list[str] | None = None) -> int:
    """CLI entry point for Cloud Run server, setup bootstrap, daily sync, and live preflight."""
    parser = argparse.ArgumentParser(description="slrr-campaigns runtime and administrative CLI.")
    parser.add_argument(
        "command",
        choices=("serve", "bootstrap", "preflight", "daily"),
        help="Runtime or administrative action.",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=8080,
        help="HTTP listen port when command == 'serve'.",
    )
    args = parser.parse_args(argv)
    if args.command == "serve":
        uvicorn.run(app, host="0.0.0.0", port=args.port)
        return 0
    if args.command == "bootstrap":
        res: dict[str, Any] = bootstrap_workspace_resources()
    elif args.command == "daily":
        res = handle_daily()
    else:
        res = run_live_preflight()
    sys.stdout.write(json.dumps(res, indent=2, sort_keys=True) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
