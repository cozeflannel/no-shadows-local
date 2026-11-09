"""Idempotent campaign provisioning saga, rollback, volume guard, and shutdown lifecycle."""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from .bigquery_mentions import BigQueryMentionsClient
from .brandwatch import BrandwatchApiError, BrandwatchClient
from .config import CampaignsConfig
from .gemini_flows import GeminiFlows
from .ingest import CAMPAIGN_SHEET_HEADERS, CAMPAIGN_SHEET_TAB, ingest_campaign_emails
from .logging_utils import log_event, strip_emojis
from .models import (
    CampaignRecord,
    CreateQueryPayload,
    CustomAlertFilterPayload,
    CustomAlertPayload,
    LocationFilterPayload,
    QueryBuilderDraft,
    RegistrySettings,
)
from .store import CampaignStore
from .workspace import WorkspaceApiError, WorkspaceClients

logger = logging.getLogger(__name__)
NY_TZ = ZoneInfo("America/New_York")


class ProvisioningFailureError(RuntimeError):
    """Raised when a provisioning step fails unrecoverably and triggers Brandwatch rollback."""

    def __init__(self, message: str, *, step: str) -> None:
        super().__init__(message)
        self.step = step


def _format_ny(iso_utc: str) -> str:
    dt = datetime.fromisoformat(iso_utc.replace("Z", "+00:00"))
    return dt.astimezone(NY_TZ).strftime("%Y-%m-%d %H:%M %Z")


def verify_alert_recipient_accepted(alert_obj: dict[str, Any], mailbox_email: str) -> tuple[bool, str]:
    """Verify the ingest mailbox is present and accepted on the read-back Custom Alert."""
    target = mailbox_email.strip().lower()
    unaccepted = [
        str(x.get("emailAddress") if isinstance(x, dict) else x).strip().lower()
        for x in (alert_obj.get("unacceptedRecipients") or [])
    ]
    if target in unaccepted:
        return False, f"Recipient {target} is listed in unacceptedRecipients on Brandwatch"
    unsubscribed = [
        str(x.get("emailAddress") if isinstance(x, dict) else x).strip().lower()
        for x in (alert_obj.get("unsubscribedRecipients") or [])
    ]
    if target in unsubscribed:
        return False, f"Recipient {target} is listed in unsubscribedRecipients on Brandwatch"

    found = False
    for entry in alert_obj.get("recipients") or []:
        if isinstance(entry, str) and entry.strip().lower() == target:
            found = True
        elif isinstance(entry, dict):
            addr = str(entry.get("emailAddress") or entry.get("email") or "").strip().lower()
            if addr == target:
                if entry.get("accepted") is False or entry.get("unsubscribed") is True:
                    return False, f"Recipient {target} has accepted=false or unsubscribed=true"
                status = str(entry.get("status") or "").strip().lower()
                if status in ("pending", "unaccepted", "unsubscribed", "bounced"):
                    return False, f"Recipient {target} has Brandwatch status '{status}'"
                found = True
    if not found:
        return False, f"Recipient {target} was not retained by Brandwatch on the alert"
    return True, "accepted"


def rollback_brandwatch_resources(
    *,
    bw: BrandwatchClient,
    campaign: CampaignRecord,
) -> list[str]:
    """Delete any Brandwatch alert or campaign-created query on unrecoverable saga failure."""
    actions: list[str] = []
    if campaign.alert_id > 0:
        try:
            bw.delete_alert(campaign.project_id, campaign.alert_id)
            actions.append(f"Deleted Brandwatch alert {campaign.alert_id}")
            campaign.alert_id = 0
        except BrandwatchApiError as exc:
            if exc.status_code != 404:
                log_event(
                    logger,
                    logging.ERROR,
                    "rollback_delete_alert_failed",
                    campaign_id=campaign.campaign_id,
                    alert_id=campaign.alert_id,
                    status_code=exc.status_code,
                )
    if campaign.query_origin == "created" and campaign.query_id > 0:
        try:
            bw.delete_query(campaign.project_id, campaign.query_id)
            actions.append(f"Deleted Brandwatch created query {campaign.query_id}")
            campaign.query_id = 0
        except BrandwatchApiError as exc:
            if exc.status_code != 404:
                log_event(
                    logger,
                    logging.ERROR,
                    "rollback_delete_query_failed",
                    campaign_id=campaign.campaign_id,
                    query_id=campaign.query_id,
                    status_code=exc.status_code,
                )
    return actions


def ensure_created_query_step(
    *,
    bw: BrandwatchClient,
    store: CampaignStore,
    campaign: CampaignRecord,
    builder: QueryBuilderDraft,
    settings: RegistrySettings,
) -> None:
    """Saga step 0 (created queries only): create locked Brandwatch query with explicit startDate."""
    if campaign.query_origin != "created":
        campaign.saga_steps["query"] = "not_needed"
        store.save_campaign(campaign)
        return
    if campaign.saga_steps.get("query") == "done" and campaign.query_id > 0:
        return

    snippet_ids = bw.resolve_exclusion_snippet_ids(settings.exclusion_snippet_names)
    loc_payload = (
        LocationFilterPayload(includedLocations=list(builder.locations)) if builder.locations else None
    )
    query_name = f"SLRR-CMP-{campaign.campaign_id} {strip_emojis(builder.short_name)[:48]}".strip()
    description = (
        f"SLRR Campaign {campaign.campaign_id} | "
        f"Requester: {campaign.requester_email or campaign.requester_user} | "
        f"Approver: {campaign.approver_email or campaign.approver_user}"
    )
    payload = CreateQueryPayload(
        name=query_name,
        booleanQuery=builder.boolean_query,
        contentSources=list(builder.content_sources),
        languages=list(builder.languages or ["en"]),
        locationFilter=loc_payload,
        startDate=builder.start_date,
        lockedQuery=True,
        exclusionSnippets=snippet_ids,
        description=description,
    )
    created = bw.create_query(campaign.project_id, payload)
    qid = int(created.get("id") or 0)
    if qid <= 0:
        raise ProvisioningFailureError("Brandwatch query creation returned no valid ID", step="query")
    campaign.query_id = qid
    campaign.query_name = str(created.get("name") or query_name)
    campaign.query_limit_usage = str(created.get("queryLimitUsage") or builder.query_limit_usage or "1")
    campaign.saga_steps["query"] = "done"
    campaign.updated_at_utc = datetime.now(UTC).isoformat()
    store.save_campaign(campaign)


def ensure_custom_alert_step(
    *,
    bw: BrandwatchClient,
    store: CampaignStore,
    workspace: WorkspaceClients,
    campaign: CampaignRecord,
) -> None:
    """Saga step 1: create Custom Alert SLRR-CMP-<campaignId> and verify recipient acceptance."""
    if campaign.saga_steps.get("alert") == "done" and campaign.alert_id > 0:
        return
    ingest_mailbox = workspace.get_mailbox_email()
    filter_payload = CustomAlertFilterPayload(
        pageType=list(campaign.platforms)
        if campaign.query_origin == "existing" and campaign.platforms
        else None,
        threadEntryType=(
            list(campaign.post_types) if campaign.query_origin == "existing" and campaign.post_types else None
        ),
        sentiment=list(campaign.sentiments) if campaign.sentiments else None,
    )
    alert_payload = CustomAlertPayload(
        name=campaign.alert_name,
        queryIds=[campaign.query_id],
        frequency=5,
        alertTypes=["scheduled"],
        mentionsPerAlert=50,
        recipients=[ingest_mailbox],
        filter=filter_payload,
    )
    created = bw.create_alert(campaign.project_id, alert_payload)
    aid = int(created.get("id") or 0)
    if aid <= 0:
        raise ProvisioningFailureError("Brandwatch Custom Alert creation returned no ID", step="alert")
    campaign.alert_id = aid
    read_back = bw.get_alert(campaign.project_id, aid)
    ok, reason = verify_alert_recipient_accepted(read_back, ingest_mailbox)
    if not ok:
        raise ProvisioningFailureError(
            f"Brandwatch alert recipient check failed: {reason}",
            step="alert_recipient",
        )
    campaign.saga_steps["alert"] = "done"
    campaign.updated_at_utc = datetime.now(UTC).isoformat()
    store.save_campaign(campaign)


def ensure_chat_space_step(
    *,
    store: CampaignStore,
    workspace: WorkspaceClients,
    campaign: CampaignRecord,
) -> bool:
    """Saga step 2: create dedicated Chat space via spaces.setup and read back applied state.

    Returns True if history came back OFF so the caller warns the requester.
    """
    if campaign.saga_steps.get("space") == "done" and campaign.space_name:
        return "OFF" in campaign.space_history_state.upper()
    space_info = workspace.setup_space(
        display_name=campaign.space_display_name,
        external_user_allowed=campaign.external_user_allowed,
        member_user_names=campaign.member_users,
    )
    campaign.space_name = str(space_info.get("name") or "")
    campaign.space_uri = str(space_info.get("spaceUri") or "")
    campaign.external_user_allowed = bool(space_info.get("externalUserAllowed"))
    campaign.space_history_state = str(space_info.get("spaceHistoryState") or "HISTORY_ON")
    campaign.saga_steps["space"] = "done"
    campaign.updated_at_utc = datetime.now(UTC).isoformat()
    store.save_campaign(campaign)
    return "OFF" in campaign.space_history_state.upper()


def ensure_campaign_sheet_step(
    *,
    cfg: CampaignsConfig,
    store: CampaignStore,
    workspace: WorkspaceClients,
    campaign: CampaignRecord,
) -> None:
    """Saga step 3: create Campaign Sheet in Drive folder and write Mentions header row."""
    if campaign.saga_steps.get("sheet") == "done" and campaign.sheet_id:
        return
    sheet_title = f"SLRR Campaign {campaign.campaign_id} - {strip_emojis(campaign.space_display_name)[:60]}"
    sheet_id, sheet_url, _tabs = workspace.create_spreadsheet(
        title=sheet_title,
        folder_id=cfg.drive_folder_id,
        sheet_titles=[CAMPAIGN_SHEET_TAB],
    )
    existing_header = workspace.read_sheet_values(sheet_id, f"'{CAMPAIGN_SHEET_TAB}'!A1:I1")
    if not existing_header:
        workspace.write_sheet_values(
            sheet_id,
            f"'{CAMPAIGN_SHEET_TAB}'!A1:I1",
            [CAMPAIGN_SHEET_HEADERS],
        )
    campaign.sheet_id = sheet_id
    campaign.sheet_url = sheet_url
    campaign.saga_steps["sheet"] = "done"
    campaign.updated_at_utc = datetime.now(UTC).isoformat()
    store.save_campaign(campaign)


def ensure_announce_step(
    *,
    store: CampaignStore,
    workspace: WorkspaceClients,
    campaign: CampaignRecord,
    history_came_back_off: bool,
) -> None:
    """Saga step 4: post confirmation in source thread and intro in campaign space."""
    if campaign.saga_steps.get("announce") == "done":
        return

    history_warning = (
        "\nNotice: Google Chat applied space history OFF; messages in this space last 24 hours."
        if history_came_back_off
        else ""
    )
    echo_label = "Enabled" if campaign.also_post_in_alerts_space else "Disabled"
    intro_text = (
        f"*Campaign Active: {strip_emojis(campaign.space_display_name)}*\n"
        f"Campaign ID: {campaign.campaign_id}\n"
        f"Query: {strip_emojis(campaign.query_name)} (ID {campaign.query_id}, {campaign.query_origin})\n"
        f"Sentiment filter: {', '.join(campaign.sentiments) or 'all'}\n"
        f"Posting engagement threshold: >= {campaign.threshold}\n"
        f"Alerts-space secondary echo: {echo_label}\n"
        f"Scheduled shutdown: {_format_ny(campaign.end_time_utc)}\n"
        f"Campaign sheet: {campaign.sheet_url}"
        f"{history_warning}\n\n"
        "How to change settings: edit this campaign's row in the Campaign Registry spreadsheet, "
        "or post a command here or in the original thread: "
        "'threshold 500', 'extend 2 days', 'pause', 'resume', or 'shut down'."
    )
    workspace.post_message(
        campaign.space_name,
        intro_text,
        idempotency_key=f"intro-{campaign.campaign_id}",
    )

    thread_confirm = (
        f"<users/{campaign.requester_user.split('/')[-1]}> Campaign *{campaign.campaign_id}* is live.\n"
        f"- Dedicated Chat space: {campaign.space_uri or campaign.space_name}\n"
        f"- Campaign mentions sheet: {campaign.sheet_url}\n"
        f"- Brandwatch Custom Alert: {campaign.alert_name} (ID {campaign.alert_id})\n"
        f"- Posting threshold: >= {campaign.threshold}\n"
        f"- Scheduled shutdown: {_format_ny(campaign.end_time_utc)}"
        f"{history_warning}"
    )
    workspace.post_message(
        campaign.source_space,
        thread_confirm,
        thread_name=campaign.source_thread,
        idempotency_key=f"confirm-{campaign.campaign_id}",
    )
    campaign.saga_steps["announce"] = "done"
    campaign.status = "active"
    campaign.last_result = "Active"
    now_iso = datetime.now(UTC).isoformat()
    campaign.last_activity_utc = now_iso
    campaign.updated_at_utc = now_iso
    store.save_campaign(campaign)


def provision_campaign(
    *,
    cfg: CampaignsConfig,
    store: CampaignStore,
    bw: BrandwatchClient,
    workspace: WorkspaceClients,
    campaign: CampaignRecord,
    builder: QueryBuilderDraft,
    settings: RegistrySettings,
) -> CampaignRecord:
    """Run or resume the idempotent provisioning saga for campaign, rolling back BW on failure."""
    try:
        ensure_created_query_step(
            bw=bw,
            store=store,
            campaign=campaign,
            builder=builder,
            settings=settings,
        )
        ensure_custom_alert_step(
            bw=bw,
            store=store,
            workspace=workspace,
            campaign=campaign,
        )
        history_off = ensure_chat_space_step(
            store=store,
            workspace=workspace,
            campaign=campaign,
        )
        ensure_campaign_sheet_step(
            cfg=cfg,
            store=store,
            workspace=workspace,
            campaign=campaign,
        )
        ensure_announce_step(
            store=store,
            workspace=workspace,
            campaign=campaign,
            history_came_back_off=history_off,
        )
        return campaign
    except (ProvisioningFailureError, BrandwatchApiError, WorkspaceApiError) as exc:
        rolled_back = rollback_brandwatch_resources(bw=bw, campaign=campaign)
        campaign.status = "failed"
        rb_note = "; ".join(rolled_back) if rolled_back else "no Brandwatch resources remained"
        campaign.last_result = f"Provisioning failed: {strip_emojis(str(exc))[:180]} ({rb_note})"
        campaign.updated_at_utc = datetime.now(UTC).isoformat()
        store.save_campaign(campaign)
        log_event(
            logger,
            logging.ERROR,
            "campaign_provisioning_failed",
            campaign_id=campaign.campaign_id,
            error_message=str(exc)[:300],
            rolled_back=rolled_back,
        )
        err_reply = (
            f"Campaign {campaign.campaign_id} provisioning stopped: {strip_emojis(str(exc))}\n"
            f"Rollback completed: {rb_note}."
        )
        workspace.post_message(
            campaign.source_space,
            err_reply,
            thread_name=campaign.source_thread,
            idempotency_key=f"prov-err-{campaign.campaign_id}-{int(datetime.now(UTC).timestamp())}",
        )
        raise


def shutdown_campaign(
    *,
    cfg: CampaignsConfig,
    store: CampaignStore,
    bw: BrandwatchClient,
    workspace: WorkspaceClients,
    bq: BigQueryMentionsClient,
    gemini: GeminiFlows,
    settings: RegistrySettings,
    campaign: CampaignRecord,
    reason: str,
) -> CampaignRecord:
    """Shut down a campaign: delete BW alert (and created query), drain emails, post closing summary."""
    if campaign.status == "closed":
        return campaign

    if campaign.alert_id > 0:
        try:
            bw.delete_alert(campaign.project_id, campaign.alert_id)
        except BrandwatchApiError as exc:
            if exc.status_code != 404:
                raise
        campaign.alert_id = 0

    if campaign.query_origin == "created" and campaign.query_id > 0:
        try:
            bw.delete_query(campaign.project_id, campaign.query_id)
        except BrandwatchApiError as exc:
            if exc.status_code != 404:
                raise

    # Process any emails already delivered before marking closed.
    store.save_campaign(campaign)
    ingest_campaign_emails(
        cfg=cfg,
        store=store,
        workspace=workspace,
        bq=bq,
        gemini=gemini,
        settings=settings,
        only_campaign_id=campaign.campaign_id,
    )
    refreshed = store.get_campaign(campaign.campaign_id) or campaign

    top_lines = [
        f"- [{item.network}] {item.author} ({item.engagement} eng): {item.summary} ({item.url})"
        for item in refreshed.top_posted[:5]
    ]
    top_block = "\n".join(top_lines) if top_lines else "- No qualifying posts reached the posting threshold."

    closing_text = (
        f"*Campaign Closed: {strip_emojis(refreshed.space_display_name)} ({refreshed.campaign_id})*\n"
        f"Reason: {strip_emojis(reason)}\n"
        f"Mentions received into sheet: {refreshed.total_received}\n"
        f"Qualifying mentions posted to Chat: {refreshed.total_posted}\n"
        f"Top items:\n{top_block}\n"
        f"Campaign space (retained): {refreshed.space_uri or refreshed.space_name}\n"
        f"Campaign sheet (retained): {refreshed.sheet_url}"
    )
    if refreshed.space_name:
        workspace.post_message(
            refreshed.space_name,
            closing_text,
            idempotency_key=f"close-space-{refreshed.campaign_id}",
        )
    if refreshed.source_space and refreshed.source_thread:
        workspace.post_message(
            refreshed.source_space,
            closing_text,
            thread_name=refreshed.source_thread,
            idempotency_key=f"close-thread-{refreshed.campaign_id}",
        )

    now_iso = datetime.now(UTC).isoformat()
    refreshed.status = "closed"
    refreshed.close_reason = strip_emojis(reason)
    refreshed.last_result = f"Closed: {strip_emojis(reason)}"
    refreshed.updated_at_utc = now_iso
    refreshed.last_activity_utc = now_iso
    store.save_campaign(refreshed)
    log_event(
        logger,
        logging.INFO,
        "campaign_closed",
        campaign_id=refreshed.campaign_id,
        reason=reason,
        total_received=refreshed.total_received,
        total_posted=refreshed.total_posted,
    )
    return refreshed


def close_expired_campaigns(
    *,
    cfg: CampaignsConfig,
    store: CampaignStore,
    bw: BrandwatchClient,
    workspace: WorkspaceClients,
    bq: BigQueryMentionsClient,
    gemini: GeminiFlows,
    settings: RegistrySettings,
) -> int:
    """Shut down any active or paused campaign whose end_time_utc has arrived."""
    now = datetime.now(UTC)
    closed_count = 0
    for campaign in store.list_campaigns():
        if campaign.status not in ("active", "paused"):
            continue
        end_dt = datetime.fromisoformat(campaign.end_time_utc.replace("Z", "+00:00"))
        if end_dt <= now:
            owner = f"expire-{campaign.campaign_id}"
            if not store.acquire_lease("campaign", campaign.campaign_id, owner, ttl_s=90.0):
                continue
            try:
                fresh = store.get_campaign(campaign.campaign_id)
                if fresh and fresh.status in ("active", "paused"):
                    shutdown_campaign(
                        cfg=cfg,
                        store=store,
                        bw=bw,
                        workspace=workspace,
                        bq=bq,
                        gemini=gemini,
                        settings=settings,
                        campaign=fresh,
                        reason="Scheduled shutdown time reached",
                    )
                    closed_count += 1
            finally:
                store.release_lease("campaign", campaign.campaign_id, owner)
    return closed_count


def send_due_shutdown_notices(
    *,
    store: CampaignStore,
    workspace: WorkspaceClients,
) -> int:
    """Post 24-hour advance shutdown notices in both space and original thread."""
    now = datetime.now(UTC)
    horizon = now + timedelta(hours=24)
    sent = 0
    for campaign in store.list_campaigns():
        if campaign.status not in ("active", "paused") or campaign.shutdown_notice_sent:
            continue
        end_dt = datetime.fromisoformat(campaign.end_time_utc.replace("Z", "+00:00"))
        if now < end_dt <= horizon:
            req_tag = (
                f"<{campaign.requester_user}>"
                if campaign.requester_user.startswith("users/")
                else campaign.requester_user
            )
            notice = (
                f"{req_tag} Campaign *{campaign.campaign_id}* ({strip_emojis(campaign.space_display_name)}) "
                f"is scheduled to shut down in less than 24 hours at {_format_ny(campaign.end_time_utc)}.\n"
                "To extend it, reply 'extend 2 days' here or update End time in the "
                "Campaign Registry spreadsheet."
            )
            if campaign.space_name:
                workspace.post_message(
                    campaign.space_name,
                    notice,
                    idempotency_key=f"notice24-space-{campaign.campaign_id}",
                )
            if campaign.source_space and campaign.source_thread:
                workspace.post_message(
                    campaign.source_space,
                    notice,
                    thread_name=campaign.source_thread,
                    idempotency_key=f"notice24-thread-{campaign.campaign_id}",
                )
            campaign.shutdown_notice_sent = True
            campaign.updated_at_utc = datetime.now(UTC).isoformat()
            store.save_campaign(campaign)
            sent += 1
    return sent


def run_hourly_volume_guard(
    *,
    cfg: CampaignsConfig,
    store: CampaignStore,
    bw: BrandwatchClient,
    workspace: WorkspaceClients,
    bq: BigQueryMentionsClient,
    gemini: GeminiFlows,
    settings: RegistrySettings,
) -> dict[str, int]:
    """Check Total Mentions since local midnight against daily_cap for created queries."""
    now_ny = datetime.now(NY_TZ)
    midnight_ny = now_ny.replace(hour=0, minute=0, second=0, microsecond=0)
    start_utc = midnight_ny.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    end_utc = now_ny.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    today_key = now_ny.strftime("%Y-%m-%d")

    checked = 0
    warned = 0
    capped = 0

    for campaign in store.list_campaigns():
        if campaign.status not in ("active", "paused") or campaign.query_origin != "created":
            continue
        if campaign.query_id <= 0 or campaign.daily_cap <= 0:
            continue
        owner = f"volguard-{campaign.campaign_id}"
        if not store.acquire_lease("campaign", campaign.campaign_id, owner, ttl_s=90.0):
            continue
        try:
            fresh = store.get_campaign(campaign.campaign_id)
            if not fresh or fresh.status not in ("active", "paused"):
                continue
            count = bw.get_mentions_count(
                fresh.project_id,
                query_ids=[fresh.query_id],
                start_date=start_utc,
                end_date=end_utc,
            )
            checked += 1
            fresh.stats_day_ny = today_key
            fresh.mentions_today = count
            fresh.updated_at_utc = datetime.now(UTC).isoformat()
            store.save_campaign(fresh)

            if count >= fresh.daily_cap:
                reason = f"Daily mention cap reached ({count} / {fresh.daily_cap} mentions since midnight ET)"
                shutdown_campaign(
                    cfg=cfg,
                    store=store,
                    bw=bw,
                    workspace=workspace,
                    bq=bq,
                    gemini=gemini,
                    settings=settings,
                    campaign=fresh,
                    reason=reason,
                )
                capped += 1
            elif count >= int(fresh.daily_cap * 0.8) and fresh.warned_80_day_ny != today_key:
                mentions_tags = " ".join(
                    f"<{u}>"
                    for u in {fresh.requester_user, fresh.approver_user}
                    if u and u.startswith("users/")
                )
                warn_msg = (
                    f"{mentions_tags} Volume warning for campaign *{fresh.campaign_id}*: "
                    f"created query '{strip_emojis(fresh.query_name)}' has collected "
                    f"{count} / {fresh.daily_cap} mentions since midnight ET (>= 80% of daily cap). "
                    "At 100%, the query and alert will be deleted automatically."
                ).strip()
                if fresh.space_name:
                    workspace.post_message(
                        fresh.space_name,
                        warn_msg,
                        idempotency_key=f"warn80-space-{fresh.campaign_id}-{today_key}",
                    )
                if fresh.source_space and fresh.source_thread:
                    workspace.post_message(
                        fresh.source_space,
                        warn_msg,
                        thread_name=fresh.source_thread,
                        idempotency_key=f"warn80-thread-{fresh.campaign_id}-{today_key}",
                    )
                fresh.warned_80_day_ny = today_key
                fresh.last_result = f"Warning: {count}/{fresh.daily_cap} daily cap"
                store.save_campaign(fresh)
                warned += 1
        finally:
            store.release_lease("campaign", campaign.campaign_id, owner)

    return {"checked": checked, "warned": warned, "capped": capped}
