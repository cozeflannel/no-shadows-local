"""Campaign Registry spreadsheet initializer, Settings loader, diff/apply engine, and orphan sweep."""

from __future__ import annotations

import logging
import re
from datetime import UTC, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from .bigquery_mentions import BigQueryMentionsClient
from .brandwatch import BrandwatchApiError, BrandwatchClient
from .config import CampaignsConfig
from .gemini_flows import GeminiFlows
from .logging_utils import log_event, strip_emojis
from .models import (
    CampaignRecord,
    CustomAlertFilterPayload,
    CustomAlertPayload,
    RegistrySettings,
    SentimentValue,
    ThreadEntryTypeValue,
)
from .provisioning import shutdown_campaign
from .store import CampaignStore
from .workspace import WorkspaceApiError, WorkspaceClients

logger = logging.getLogger(__name__)
NY_TZ = ZoneInfo("America/New_York")

TAB_CAMPAIGNS = "Campaigns"
TAB_SETTINGS = "Settings"
TAB_ORPHANS = "Orphans"

BOT_HEADERS: list[str] = [
    "Campaign ID",
    "Status",
    "Requester",
    "Approver",
    "Query",
    "Alert ID",
    "Space link",
    "External members",
    "History",
    "Members",
    "Last activity",
    "Campaign sheet link",
    "Mentions today against cap",
    "Posted today",
    "Last email",
    "Result",
    "Updated",
]

EDITABLE_HEADERS: list[str] = [
    "Space display name",
    "End time",
    "Threshold",
    "Sentiment",
    "Platforms",
    "Post types",
    "Daily cap",
    "Also post in alerts space",
    "Action",
]

ALL_CAMPAIGN_HEADERS: list[str] = BOT_HEADERS + EDITABLE_HEADERS
ORPHAN_HEADERS: list[str] = [
    "Detected at (ET)",
    "Resource type",
    "Project ID",
    "Resource ID",
    "Name",
    "Notes",
]

VALID_SENTIMENTS: tuple[SentimentValue, ...] = ("positive", "neutral", "negative")
VALID_POST_TYPES: tuple[ThreadEntryTypeValue, ...] = ("post", "reply", "share")


def format_et(iso_utc: str) -> str:
    """Format an ISO UTC timestamp for display in America/New_York."""
    if not iso_utc:
        return ""
    dt = datetime.fromisoformat(iso_utc.replace("Z", "+00:00"))
    return dt.astimezone(NY_TZ).strftime("%Y-%m-%d %H:%M %Z")


def parse_et_to_utc_iso(text: str) -> str:
    """Parse an America/New_York date-time cell or ISO timestamp into UTC ISO-8601."""
    cleaned = re.sub(r"\s+(?:EST|EDT|ET)$", "", text.strip(), flags=re.IGNORECASE).strip()
    if cleaned.endswith("Z") or "+" in cleaned[10:]:
        dt = datetime.fromisoformat(cleaned.replace("Z", "+00:00"))
        return dt.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d"):
        try:
            naive = datetime.strptime(cleaned, fmt)
            localized = naive.replace(tzinfo=NY_TZ)
            return localized.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
        except ValueError:
            continue
    raise ValueError(f"Invalid End time '{text}'; use YYYY-MM-DD HH:MM ET")


def ensure_registry_spreadsheet(
    *,
    cfg: CampaignsConfig,
    workspace: WorkspaceClients,
    folder_id: str,
    owner_email: str,
    existing_spreadsheet_id: str = "",
) -> str:
    """Idempotently create or repair the Registry spreadsheet, tabs, protections, and validations."""
    if existing_spreadsheet_id:
        spreadsheet_id = existing_spreadsheet_id
        meta = workspace.get_spreadsheet_metadata(spreadsheet_id)
    else:
        spreadsheet_id, _url, _tabs = workspace.create_spreadsheet(
            title="SLRR Campaign Registry",
            folder_id=folder_id,
            sheet_titles=[TAB_CAMPAIGNS, TAB_SETTINGS, TAB_ORPHANS],
        )
        meta = workspace.get_spreadsheet_metadata(spreadsheet_id)

    sheet_map: dict[str, int] = {}
    protected_sheet_ids: set[int] = set()
    for s in meta.get("sheets") or []:
        props = (s or {}).get("properties") or {}
        title = str(props.get("title") or "")
        sid = int(props.get("sheetId") or 0)
        sheet_map[title] = sid
        for pr in (s or {}).get("protectedRanges") or []:
            rng = (pr or {}).get("range") or {}
            if int(rng.get("endColumnIndex") or 0) == len(BOT_HEADERS):
                protected_sheet_ids.add(sid)

    add_requests: list[dict[str, Any]] = []
    for tab in (TAB_CAMPAIGNS, TAB_SETTINGS, TAB_ORPHANS):
        if tab not in sheet_map:
            add_requests.append({"addSheet": {"properties": {"title": tab}}})
    if add_requests:
        workspace.batch_update_spreadsheet(spreadsheet_id, add_requests)
        meta = workspace.get_spreadsheet_metadata(spreadsheet_id)
        for s in meta.get("sheets") or []:
            props = (s or {}).get("properties") or {}
            sheet_map[str(props.get("title") or "")] = int(props.get("sheetId") or 0)

    campaigns_header = workspace.read_sheet_values(spreadsheet_id, f"'{TAB_CAMPAIGNS}'!A1:Z1")
    if not campaigns_header or campaigns_header[0] != ALL_CAMPAIGN_HEADERS:
        workspace.write_sheet_values(
            spreadsheet_id,
            f"'{TAB_CAMPAIGNS}'!A1:Z1",
            [ALL_CAMPAIGN_HEADERS],
        )

    settings_rows = workspace.read_sheet_values(spreadsheet_id, f"'{TAB_SETTINGS}'!A1:B10")
    if len(settings_rows) < 6:
        seeded_settings: list[list[Any]] = [
            ["Setting", "Value"],
            ["Approver emails", owner_email],
            ["Default daily cap", "2500"],
            ["Maximum campaign duration days", "14"],
            ["Per-tick post cap", "5"],
            ["Exclusion snippet names", "jobs"],
        ]
        workspace.write_sheet_values(spreadsheet_id, f"'{TAB_SETTINGS}'!A1:B6", seeded_settings)

    orphans_header = workspace.read_sheet_values(spreadsheet_id, f"'{TAB_ORPHANS}'!A1:F1")
    if not orphans_header or orphans_header[0] != ORPHAN_HEADERS:
        workspace.write_sheet_values(spreadsheet_id, f"'{TAB_ORPHANS}'!A1:F1", [ORPHAN_HEADERS])

    campaigns_sid = sheet_map[TAB_CAMPAIGNS]
    rule_requests: list[dict[str, Any]] = []
    if campaigns_sid not in protected_sheet_ids:
        rule_requests.append(
            {
                "addProtectedRange": {
                    "protectedRange": {
                        "range": {
                            "sheetId": campaigns_sid,
                            "startRowIndex": 0,
                            "startColumnIndex": 0,
                            "endColumnIndex": len(BOT_HEADERS),
                        },
                        "description": "Bot-written SLRR Campaign Registry columns",
                        "warningOnly": False,
                        "editors": {"users": [owner_email]},
                    },
                },
            },
        )

    def _list_validation(col_idx: int, values: list[str], *, strict: bool = True) -> dict[str, Any]:
        return {
            "setDataValidation": {
                "range": {
                    "sheetId": campaigns_sid,
                    "startRowIndex": 1,
                    "endRowIndex": 500,
                    "startColumnIndex": col_idx,
                    "endColumnIndex": col_idx + 1,
                },
                "rule": {
                    "condition": {
                        "type": "ONE_OF_LIST",
                        "values": [{"userEnteredValue": v} for v in values],
                    },
                    "strict": strict,
                    "showCustomUi": True,
                },
            },
        }

    def _non_negative_int_validation(col_idx: int) -> dict[str, Any]:
        return {
            "setDataValidation": {
                "range": {
                    "sheetId": campaigns_sid,
                    "startRowIndex": 1,
                    "endRowIndex": 500,
                    "startColumnIndex": col_idx,
                    "endColumnIndex": col_idx + 1,
                },
                "rule": {
                    "condition": {
                        "type": "NUMBER_GREATER_THAN_EQ",
                        "values": [{"userEnteredValue": "0"}],
                    },
                    "strict": True,
                },
            },
        }

    def _text_contains_validation(col_idx: int, needle: str) -> dict[str, Any]:
        return {
            "setDataValidation": {
                "range": {
                    "sheetId": campaigns_sid,
                    "startRowIndex": 1,
                    "endRowIndex": 500,
                    "startColumnIndex": col_idx,
                    "endColumnIndex": col_idx + 1,
                },
                "rule": {
                    "condition": {
                        "type": "TEXT_CONTAINS",
                        "values": [{"userEnteredValue": needle}],
                    },
                    "strict": False,
                },
            },
        }

    # Editable indices: 17 Space display name, 18 End time, 19 Threshold, 20 Sentiment,
    # 21 Platforms, 22 Post types, 23 Daily cap, 24 Also post in alerts space, 25 Action.
    rule_requests.extend(
        [
            _text_contains_validation(17, " "),
            _text_contains_validation(18, "-"),
            _non_negative_int_validation(19),
            _list_validation(
                20,
                [
                    "positive, neutral, negative",
                    "positive",
                    "neutral",
                    "negative",
                    "positive, neutral",
                    "neutral, negative",
                    "positive, negative",
                ],
                strict=False,
            ),
            _text_contains_validation(21, ""),
            _list_validation(
                22,
                [
                    "all",
                    "post",
                    "reply",
                    "share",
                    "post, reply",
                    "post, share",
                    "reply, share",
                    "post, reply, share",
                ],
                strict=False,
            ),
            _non_negative_int_validation(23),
            _list_validation(24, ["No", "Yes"], strict=True),
            _list_validation(25, ["Pause", "Resume", "Shut down now"], strict=True),
        ],
    )
    workspace.batch_update_spreadsheet(spreadsheet_id, rule_requests)
    log_event(
        logger,
        logging.INFO,
        "registry_spreadsheet_ready",
        spreadsheet_id=spreadsheet_id,
        project_id=cfg.gcp_project_id,
    )
    return spreadsheet_id


def load_registry_settings(cfg: CampaignsConfig, workspace: WorkspaceClients) -> RegistrySettings:
    """Read operational people, defaults, and limits from the Registry Settings tab."""
    rows = workspace.read_sheet_values(cfg.registry_spreadsheet_id, f"'{TAB_SETTINGS}'!A2:B20")
    kv: dict[str, str] = {}
    for row in rows:
        if len(row) >= 2 and row[0].strip():
            kv[row[0].strip().lower()] = row[1].strip()

    approvers = [
        e.strip().lower()
        for e in re.split(r"[,;\s]+", kv.get("approver emails", ""))
        if e.strip() and "@" in e
    ]
    if not approvers:
        approvers = [workspace.get_mailbox_email()]

    daily_cap = int(kv.get("default daily cap") or "2500")
    max_days = int(kv.get("maximum campaign duration days") or "14")
    per_tick = int(kv.get("per-tick post cap") or "5")
    snippets = [s.strip() for s in re.split(r"[,;]+", kv.get("exclusion snippet names", "")) if s.strip()]
    return RegistrySettings(
        approver_emails=approvers,
        default_daily_cap=max(1, daily_cap),
        max_campaign_duration_days=max(1, max_days),
        per_tick_post_cap=max(1, per_tick),
        exclusion_snippet_names=snippets,
    )


def resolve_approver_users(
    settings: RegistrySettings,
    workspace: WorkspaceClients,
) -> dict[str, str]:
    """Resolve approver emails in Settings to Chat user resource names (users/...) -> email."""
    resolved: dict[str, str] = {}
    for email in settings.approver_emails:
        user_res = workspace.resolve_email_to_chat_user(email)
        resolved[user_res] = email
    return resolved


def _editable_snapshot_from_campaign(campaign: CampaignRecord) -> dict[str, str]:
    return {
        "space_display_name": campaign.space_display_name,
        "end_time": format_et(campaign.end_time_utc),
        "threshold": str(campaign.threshold),
        "sentiment": ", ".join(campaign.sentiments),
        "platforms": ", ".join(campaign.platforms) if campaign.platforms else "all",
        "post_types": ", ".join(campaign.post_types) if campaign.post_types else "all",
        "daily_cap": str(campaign.daily_cap),
        "also_post_in_alerts_space": "Yes" if campaign.also_post_in_alerts_space else "No",
        "action": "",
    }


def _row_from_campaign(campaign: CampaignRecord) -> list[str]:
    snap = _editable_snapshot_from_campaign(campaign)
    cap_display = (
        f"{campaign.mentions_today} / {campaign.daily_cap}"
        if campaign.daily_cap > 0
        else f"{campaign.mentions_today} (existing query)"
    )
    query_display = f"{campaign.query_name} (ID {campaign.query_id}, {campaign.query_origin})"
    status_display = (
        f"Closed ({campaign.close_reason})"
        if campaign.status == "closed" and campaign.close_reason
        else campaign.status.capitalize()
    )
    bot_cells = [
        campaign.campaign_id,
        status_display,
        campaign.requester_email or campaign.requester_user,
        campaign.approver_email or campaign.approver_user or "N/A (existing query)",
        query_display,
        str(campaign.alert_id) if campaign.alert_id > 0 else "Deleted",
        campaign.space_uri or campaign.space_name,
        "Yes" if campaign.external_user_allowed else "No",
        campaign.space_history_state or "HISTORY_ON",
        str(len(campaign.member_users)),
        format_et(campaign.last_activity_utc),
        campaign.sheet_url,
        cap_display,
        str(campaign.posted_today),
        format_et(campaign.last_email_utc),
        campaign.last_result,
        format_et(campaign.updated_at_utc),
    ]
    editable_cells = [
        snap["space_display_name"],
        snap["end_time"],
        snap["threshold"],
        snap["sentiment"],
        snap["platforms"],
        snap["post_types"],
        snap["daily_cap"],
        snap["also_post_in_alerts_space"],
        "",
    ]
    return bot_cells + editable_cells


def _sync_alert_put(bw: BrandwatchClient, campaign: CampaignRecord) -> None:
    """Apply filter changes to Brandwatch Custom Alert using GET then PUT with all required fields."""
    if campaign.alert_id <= 0 or campaign.status == "closed":
        return
    current = bw.get_alert(campaign.project_id, campaign.alert_id)
    recipients = [
        str(r.get("emailAddress") if isinstance(r, dict) else r) for r in (current.get("recipients") or [])
    ]
    filt = CustomAlertFilterPayload(
        pageType=list(campaign.platforms)
        if campaign.query_origin == "existing" and campaign.platforms
        else None,
        threadEntryType=(
            list(campaign.post_types) if campaign.query_origin == "existing" and campaign.post_types else None
        ),
        sentiment=list(campaign.sentiments) if campaign.sentiments else None,
    )
    payload = CustomAlertPayload(
        name=str(current.get("name") or campaign.alert_name),
        queryIds=[int(q) for q in (current.get("queryIds") or [campaign.query_id])],
        frequency=5,
        alertTypes=["scheduled"],
        mentionsPerAlert=int(current.get("mentionsPerAlert") or 50),
        recipients=recipients,
        filter=filt,
        enabled=current.get("enabled") if isinstance(current.get("enabled"), bool) else None,
    )
    bw.update_alert(campaign.project_id, campaign.alert_id, payload)


def apply_campaign_mutation(
    *,
    cfg: CampaignsConfig,
    store: CampaignStore,
    bw: BrandwatchClient,
    workspace: WorkspaceClients,
    bq: BigQueryMentionsClient,
    gemini: GeminiFlows,
    settings: RegistrySettings,
    campaign: CampaignRecord,
    changes: dict[str, str],
) -> tuple[CampaignRecord, str]:
    """Unified mutation path shared by Registry cell diffs and Chat commands."""
    if campaign.status == "closed":
        campaign.last_result = "Ignored edit: campaign is already Closed"
        campaign.updated_at_utc = datetime.now(UTC).isoformat()
        store.save_campaign(campaign)
        return campaign, campaign.last_result

    notes: list[str] = []
    alert_needs_put = False
    now = datetime.now(UTC)

    action_val = changes.get("action", "").strip().lower()
    if action_val in ("shut down now", "shut_down", "shutdown"):
        closed = shutdown_campaign(
            cfg=cfg,
            store=store,
            bw=bw,
            workspace=workspace,
            bq=bq,
            gemini=gemini,
            settings=settings,
            campaign=campaign,
            reason="Manual shutdown requested",
        )
        store.save_registry_snapshot(closed.campaign_id, _editable_snapshot_from_campaign(closed))
        return closed, closed.last_result

    if "space_display_name" in changes:
        new_name = strip_emojis(changes["space_display_name"]).strip()
        if not new_name:
            notes.append("Reverted empty Space display name")
        else:
            if campaign.campaign_id not in new_name:
                new_name = f"{new_name} [{campaign.campaign_id}]"
            try:
                workspace.patch_space_display_name(campaign.space_name, new_name)
                campaign.space_display_name = new_name
                notes.append(f"Renamed space to '{new_name}'")
            except WorkspaceApiError as exc:
                notes.append(f"Reverted rename ({strip_emojis(str(exc))[:120]})")

    if "end_time" in changes:
        try:
            new_end_iso = parse_et_to_utc_iso(changes["end_time"])
            new_end_dt = datetime.fromisoformat(new_end_iso.replace("Z", "+00:00"))
            created_dt = datetime.fromisoformat(campaign.created_at_utc.replace("Z", "+00:00"))
            max_end = max(now, created_dt) + timedelta(days=settings.max_campaign_duration_days)
            if new_end_dt <= now:
                notes.append("Reverted End time: must be in the future")
            elif new_end_dt > max_end:
                notes.append(
                    f"Reverted End time: exceeds maximum duration of "
                    f"{settings.max_campaign_duration_days} days",
                )
            else:
                campaign.end_time_utc = new_end_iso
                campaign.shutdown_notice_sent = False
                notes.append(f"Updated End time to {format_et(new_end_iso)}")
        except ValueError as exc:
            notes.append(f"Reverted End time ({exc})")

    if "extend_days" in changes:
        days_add = int(changes["extend_days"])
        current_end = datetime.fromisoformat(campaign.end_time_utc.replace("Z", "+00:00"))
        proposed = max(current_end, now) + timedelta(days=days_add)
        max_allowed = now + timedelta(days=settings.max_campaign_duration_days)
        if days_add <= 0 or proposed > max_allowed:
            notes.append(
                f"Rejected extension: must stay within {settings.max_campaign_duration_days} days from now",
            )
        else:
            campaign.end_time_utc = proposed.strftime("%Y-%m-%dT%H:%M:%SZ")
            campaign.shutdown_notice_sent = False
            notes.append(f"Extended shutdown to {format_et(campaign.end_time_utc)}")

    if "threshold" in changes:
        raw_thr = changes["threshold"].strip()
        if not raw_thr.isdigit():
            notes.append(f"Reverted Threshold '{raw_thr}': must be a non-negative integer")
        else:
            campaign.threshold = int(raw_thr)
            notes.append(f"Updated Threshold to {campaign.threshold}")

    if "sentiment" in changes:
        tokens = [t.strip().lower() for t in re.split(r"[,;\s]+", changes["sentiment"]) if t.strip()]
        invalid = [t for t in tokens if t not in VALID_SENTIMENTS]
        if not tokens or invalid:
            notes.append(
                "Reverted Sentiment: allowed values are positive, neutral, negative",
            )
        else:
            typed_sents: list[SentimentValue] = []
            for s in VALID_SENTIMENTS:
                if s in tokens:
                    typed_sents.append(s)
            campaign.sentiments = typed_sents
            alert_needs_put = True
            notes.append(f"Updated Sentiment to {', '.join(typed_sents)}")

    if "platforms" in changes:
        raw_plat = changes["platforms"].strip()
        if campaign.query_origin == "created":
            notes.append(
                "Reverted Platforms: contentSources on a created Brandwatch query cannot change via the API",
            )
        elif raw_plat.lower() in ("", "all"):
            campaign.platforms = []
            alert_needs_put = True
            notes.append("Cleared platform filter (all query platforms)")
        else:
            valid_ids = {
                str(m.get("id") or m.get("name") or "").strip().lower()
                for m in bw.get_metrics()
                if m.get("id") or m.get("name")
            }
            valid_ids.update(
                {"twitter", "reddit", "youtube", "news", "blog", "forum", "instagram", "facebook", "bluesky"},
            )
            chosen = [p.strip().lower() for p in re.split(r"[,;\s]+", raw_plat) if p.strip()]
            bad_plat = [p for p in chosen if p not in valid_ids]
            if bad_plat:
                notes.append(f"Reverted Platforms: unknown content source IDs {bad_plat}")
            else:
                campaign.platforms = chosen
                alert_needs_put = True
                notes.append(f"Updated Platforms to {', '.join(chosen)}")

    if "post_types" in changes:
        raw_pt = changes["post_types"].strip()
        if campaign.query_origin == "created":
            notes.append(
                "Reverted Post types: post-type filtering applies only to existing-query alerts",
            )
        elif raw_pt.lower() in ("", "all"):
            campaign.post_types = []
            alert_needs_put = True
            notes.append("Cleared Post types filter")
        else:
            pt_tokens = [t.strip().lower() for t in re.split(r"[,;\s]+", raw_pt) if t.strip()]
            bad_pt = [t for t in pt_tokens if t not in VALID_POST_TYPES]
            if bad_pt:
                notes.append("Reverted Post types: allowed values are post, reply, share, or all")
            else:
                typed_pts: list[ThreadEntryTypeValue] = [pt for pt in VALID_POST_TYPES if pt in pt_tokens]
                campaign.post_types = typed_pts
                alert_needs_put = True
                notes.append(
                    f"Updated Post types to {', '.join(typed_pts)} (note: drops non-threaded news/blogs)",
                )

    if "daily_cap" in changes:
        raw_cap = changes["daily_cap"].strip()
        if not raw_cap.isdigit():
            notes.append(f"Reverted Daily cap '{raw_cap}': must be a non-negative integer")
        else:
            campaign.daily_cap = int(raw_cap)
            notes.append(f"Updated Daily cap to {campaign.daily_cap}")

    if "also_post_in_alerts_space" in changes:
        raw_echo = changes["also_post_in_alerts_space"].strip().lower()
        if raw_echo not in ("yes", "no", "true", "false"):
            notes.append("Reverted Also post in alerts space: use Yes or No")
        else:
            campaign.also_post_in_alerts_space = raw_echo in ("yes", "true")
            notes.append(
                f"Set Also post in alerts space to {'Yes' if campaign.also_post_in_alerts_space else 'No'}",
            )

    if alert_needs_put:
        try:
            _sync_alert_put(bw, campaign)
        except BrandwatchApiError as exc:
            notes.append(f"Brandwatch alert PUT error: {strip_emojis(str(exc))[:140]}")

    if action_val == "pause":
        if campaign.alert_id > 0:
            bw.set_alert_paused(campaign.project_id, campaign.alert_id, paused=True)
        campaign.status = "paused"
        if campaign.query_origin == "created":
            notes.append(
                "Paused posting and alert emails; created query continues collecting "
                "mentions toward allotment until shut down",
            )
        else:
            notes.append("Paused campaign alert and Chat posting")
    elif action_val == "resume":
        if campaign.alert_id > 0:
            bw.set_alert_paused(campaign.project_id, campaign.alert_id, paused=False)
        campaign.status = "active"
        notes.append("Resumed campaign alert and Chat posting")
    elif action_val:
        notes.append(f"Reverted unknown Action '{changes.get('action')}'")

    result_text = "; ".join(notes) if notes else "No changes applied"
    now_iso = datetime.now(UTC).isoformat()
    campaign.last_result = strip_emojis(result_text)[:450]
    campaign.updated_at_utc = now_iso
    campaign.last_activity_utc = now_iso
    store.save_campaign(campaign)
    store.save_registry_snapshot(campaign.campaign_id, _editable_snapshot_from_campaign(campaign))
    return campaign, campaign.last_result


def sync_registry(
    *,
    cfg: CampaignsConfig,
    store: CampaignStore,
    bw: BrandwatchClient,
    workspace: WorkspaceClients,
    bq: BigQueryMentionsClient,
    gemini: GeminiFlows,
    settings: RegistrySettings,
) -> dict[str, int]:
    """Diff editable Registry cells against snapshots, apply mutations, and rebuild canonical rows."""
    rows = workspace.read_sheet_values(cfg.registry_spreadsheet_id, f"'{TAB_CAMPAIGNS}'!A1:Z500")
    if not rows or rows[0] != ALL_CAMPAIGN_HEADERS:
        workspace.write_sheet_values(
            cfg.registry_spreadsheet_id,
            f"'{TAB_CAMPAIGNS}'!A1:Z1",
            [ALL_CAMPAIGN_HEADERS],
        )
        rows = [ALL_CAMPAIGN_HEADERS]

    sheet_by_cid: dict[str, list[str]] = {}
    for raw_row in rows[1:]:
        padded = list(raw_row) + [""] * max(0, len(ALL_CAMPAIGN_HEADERS) - len(raw_row))
        cid = padded[0].strip()
        if cid:
            sheet_by_cid[cid] = padded

    edits_applied = 0
    campaigns = store.list_campaigns()

    for campaign in campaigns:
        cid = campaign.campaign_id
        snap = store.get_registry_snapshot(cid)
        if snap is None:
            snap = _editable_snapshot_from_campaign(campaign)
            store.save_registry_snapshot(cid, snap)

        sheet_row = sheet_by_cid.get(cid)
        if sheet_row is not None:
            current_edit = {
                "space_display_name": sheet_row[17].strip(),
                "end_time": sheet_row[18].strip(),
                "threshold": sheet_row[19].strip(),
                "sentiment": sheet_row[20].strip(),
                "platforms": sheet_row[21].strip(),
                "post_types": sheet_row[22].strip(),
                "daily_cap": sheet_row[23].strip(),
                "also_post_in_alerts_space": sheet_row[24].strip(),
                "action": sheet_row[25].strip(),
            }
            diff = {
                k: v
                for k, v in current_edit.items()
                if (k == "action" and v != "") or (k != "action" and v != "" and v != snap.get(k, ""))
            }
            if diff:
                owner = f"regdiff-{cid}"
                if store.acquire_lease("campaign", cid, owner, ttl_s=90.0):
                    try:
                        fresh = store.get_campaign(cid)
                        if fresh is not None:
                            apply_campaign_mutation(
                                cfg=cfg,
                                store=store,
                                bw=bw,
                                workspace=workspace,
                                bq=bq,
                                gemini=gemini,
                                settings=settings,
                                campaign=fresh,
                                changes=diff,
                            )
                            edits_applied += 1
                    finally:
                        store.release_lease("campaign", cid, owner)

    # Rebuild full view from Firestore state (restores deleted/tampered rows and clears Action).
    latest_campaigns = store.list_campaigns()
    out_matrix: list[list[Any]] = [ALL_CAMPAIGN_HEADERS]
    for camp in latest_campaigns:
        out_matrix.append(_row_from_campaign(camp))
    # Pad extra blank rows if a manual row was removed so stale trailing cells are wiped.
    extra_blank_rows = max(0, len(rows) - len(out_matrix))
    for _ in range(extra_blank_rows):
        out_matrix.append([""] * len(ALL_CAMPAIGN_HEADERS))

    end_row = max(1, len(out_matrix))
    workspace.write_sheet_values(
        cfg.registry_spreadsheet_id,
        f"'{TAB_CAMPAIGNS}'!A1:Z{end_row}",
        out_matrix,
    )
    return {"campaigns": len(latest_campaigns), "edits_applied": edits_applied}


def run_orphan_sweep(
    *,
    cfg: CampaignsConfig,
    store: CampaignStore,
    bw: BrandwatchClient,
    workspace: WorkspaceClients,
) -> dict[str, int]:
    """Sweep SLRR-CMP-* alerts and queries: delete closed ones; record unknown ones to Orphans tab."""
    known_campaigns = {c.campaign_id: c for c in store.list_campaigns()}
    extra_pids = {c.project_id for c in known_campaigns.values() if c.project_id > 0}
    alerts, queries = bw.list_slrr_cmp_resources(extra_project_ids=extra_pids)
    deleted_alerts = 0
    deleted_queries = 0
    orphan_rows: list[list[Any]] = [ORPHAN_HEADERS]
    now_et = format_et(datetime.now(UTC).isoformat())

    cid_re = re.compile(r"^SLRR-CMP-([A-Z0-9]+)", re.IGNORECASE)

    for pid, alert_obj in alerts:
        aname = str(alert_obj.get("name") or "")
        aid = int(alert_obj.get("id") or 0)
        m = cid_re.match(aname)
        cid = m.group(1).upper() if m else ""
        camp = known_campaigns.get(cid) if cid else None
        if camp is not None and camp.status in ("closed", "failed"):
            bw.delete_alert(pid, aid)
            deleted_alerts += 1
        elif camp is None:
            orphan_rows.append(
                [
                    now_et,
                    "Custom Alert",
                    str(pid),
                    str(aid),
                    aname,
                    "No campaign record in Firestore; left untouched for manual review",
                ],
            )

    for pid, query_obj in queries:
        qname = str(query_obj.get("name") or "")
        qid = int(query_obj.get("id") or 0)
        m = cid_re.match(qname)
        cid = m.group(1).upper() if m else ""
        camp = known_campaigns.get(cid) if cid else None
        if camp is not None and camp.status in ("closed", "failed") and camp.query_origin == "created":
            bw.delete_query(pid, qid)
            deleted_queries += 1
        elif camp is None:
            orphan_rows.append(
                [
                    now_et,
                    "Query",
                    str(pid),
                    str(qid),
                    qname,
                    "No campaign record in Firestore; never auto-deleted",
                ],
            )

    existing_orphans = workspace.read_sheet_values(
        cfg.registry_spreadsheet_id,
        f"'{TAB_ORPHANS}'!A1:F200",
    )
    pad_count = max(0, len(existing_orphans) - len(orphan_rows))
    for _ in range(pad_count):
        orphan_rows.append([""] * len(ORPHAN_HEADERS))
    workspace.write_sheet_values(
        cfg.registry_spreadsheet_id,
        f"'{TAB_ORPHANS}'!A1:F{len(orphan_rows)}",
        orphan_rows,
    )
    log_event(
        logger,
        logging.INFO,
        "orphan_sweep_completed",
        deleted_alerts=deleted_alerts,
        deleted_queries=deleted_queries,
        unknown_orphans=len(orphan_rows) - 1 - pad_count,
    )
    return {
        "deleted_alerts": deleted_alerts,
        "deleted_queries": deleted_queries,
        "orphans_logged": len(orphan_rows) - 1 - pad_count,
    }
