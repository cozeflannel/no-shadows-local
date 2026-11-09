"""Live integration tests for slrr-campaigns across Brandwatch, Chat, Gmail, Drive, Docs, Gemini, People."""

from __future__ import annotations

import time
from datetime import UTC, datetime, timedelta

import pytest

from slrr_campaigns.brandwatch import parse_rate_limit_headers
from slrr_campaigns.conversation import format_validation_issues
from slrr_campaigns.models import (
    CustomAlertFilterPayload,
    CustomAlertPayload,
    QueryBuilderDraft,
)
from slrr_campaigns.registry import load_registry_settings, resolve_approver_users
from slrr_campaigns.service import RuntimeDependencies
from slrr_campaigns.workspace import (
    CHROME_ALERTS_GMAIL_QUERY,
    GMAIL_CAMPAIGN_QUERY,
    WorkspaceApiError,
)

DEPRECATED_ALERT_KEYS = frozenset({"queryId", "queryName", "additionalRecipients", "emailCreator"})


@pytest.mark.live
def test_brandwatch_auth_validation_mentions_and_alert_lifecycle(
    live_runtime: RuntimeDependencies,
) -> None:
    """Exercise Brandwatch auth, queries, validation, mentions, rate-limit headers, and alert lifecycle."""
    bw = live_runtime.bw
    mailbox_email = live_runtime.workspace.get_mailbox_email()

    me = bw.get_me()
    assert me.get("id") is not None
    client_info = bw.get_client()
    assert client_info is not None

    # Rate-limit headers parsed from real responses plus direct parser verification.
    assert bw.last_rate_limit is None or bw.last_rate_limit > 0
    assert bw.last_rate_used is None or bw.last_rate_used >= 0
    parsed_lim, parsed_used = parse_rate_limit_headers({"X-Rate-Limit": "1500", "X-Rate-Limit-Used": "12"})
    assert parsed_lim == 1500
    assert parsed_used == 12

    projects = bw.list_projects(force_refresh=True)
    assert isinstance(projects, list)
    queries = bw.get_cached_queries(force_refresh=True)
    existing_queries = [q for q in queries if not q.name.startswith("SLRR-CMP-")]
    assert len(existing_queries) >= 1, "Expected at least one existing Brandwatch query"
    target_query = existing_queries[0]

    # Validate one valid boolean and one invalid boolean without creating any Brandwatch query.
    valid_resp = bw.validate_query(
        boolean_query='"Google Chrome" AND (update OR browser)',
        languages=["en"],
    )
    valid_errors, valid_usage = format_validation_issues(valid_resp)
    assert valid_errors == []
    assert int(valid_usage) >= 1

    invalid_resp = bw.validate_query(
        boolean_query='"Google Chrome" and (j*)',
        languages=["en"],
    )
    invalid_errors, _ = format_validation_issues(invalid_resp)
    assert len(invalid_errors) >= 1

    # Total Mentions and one mentions page on an existing query (verifying +0000 -> %2B encoding).
    now_utc = datetime.now(UTC)
    start_iso = (now_utc - timedelta(hours=24)).strftime("%Y-%m-%dT%H:%M:%SZ")
    end_iso = now_utc.strftime("%Y-%m-%dT%H:%M:%SZ")
    total_count = bw.get_mentions_count(
        target_query.project_id,
        query_ids=[target_query.query_id],
        start_date=start_iso,
        end_date=end_iso,
    )
    assert total_count >= 0

    mentions_page = bw.get_top_mentions(
        target_query.project_id,
        query_ids=[target_query.query_id],
        start_date=start_iso,
        end_date=end_iso,
        page_size=5,
    )
    assert isinstance(mentions_page, list)
    assert len(mentions_page) <= 5

    # Full Custom Alert lifecycle on the existing query: create, read, update, pause, resume, delete.
    stamp = int(time.time())
    alert_name = f"SLRR-CMP-LIVETEST{stamp}"
    create_payload = CustomAlertPayload(
        name=alert_name,
        queryIds=[target_query.query_id],
        frequency=60,
        alertTypes=["scheduled"],
        mentionsPerAlert=25,
        recipients=[mailbox_email],
        filter=CustomAlertFilterPayload(sentiment=["negative", "neutral"]),
    )
    body_dict = create_payload.to_api_dict()
    assert DEPRECATED_ALERT_KEYS.isdisjoint(body_dict.keys())

    alert_id = 0
    try:
        created = bw.create_alert(target_query.project_id, create_payload)
        alert_id = int(created.get("id") or 0)
        assert alert_id > 0

        fetched = bw.get_alert(target_query.project_id, alert_id)
        assert str(fetched.get("name") or "") == alert_name
        assert target_query.query_id in [int(q) for q in (fetched.get("queryIds") or [])]

        update_payload = CustomAlertPayload(
            name=alert_name,
            queryIds=[target_query.query_id],
            frequency=60,
            alertTypes=["scheduled"],
            mentionsPerAlert=10,
            recipients=[mailbox_email],
            filter=CustomAlertFilterPayload(sentiment=["negative"]),
        )
        assert DEPRECATED_ALERT_KEYS.isdisjoint(update_payload.to_api_dict().keys())
        updated = bw.update_alert(target_query.project_id, alert_id, update_payload)
        assert int(updated.get("mentionsPerAlert") or 0) == 10

        # Pause and settle enabled polarity by listing with enabled=true.
        bw.set_alert_paused(target_query.project_id, alert_id, paused=True)
        enabled_when_paused = bw.list_alerts(
            target_query.project_id,
            search=alert_name,
            enabled=True,
            page_size=50,
            page=0,
        )
        assert all(int(a.get("id") or 0) != alert_id for a in enabled_when_paused)

        # Resume and confirm presence in enabled=true listing.
        bw.set_alert_paused(target_query.project_id, alert_id, paused=False)
        enabled_when_active = bw.list_alerts(
            target_query.project_id,
            search=alert_name,
            enabled=True,
            page_size=50,
            page=0,
        )
        assert any(int(a.get("id") or 0) == alert_id for a in enabled_when_active)
    finally:
        if alert_id > 0:
            bw.delete_alert(target_query.project_id, alert_id)

    assert bw.find_alert_by_name(alert_name, project_id=target_query.project_id) is None


@pytest.mark.live
def test_chat_space_lifecycle_threads_cursors_and_allowlist(
    live_runtime: RuntimeDependencies,
) -> None:
    """Exercise spaces.setup, read-back, post, thread reply, cursor listing, and space deletion."""
    ws = live_runtime.workspace
    store = live_runtime.store
    cfg = live_runtime.cfg

    # Verify allowlist blocks posting to the live Burson alerts space.
    with pytest.raises(WorkspaceApiError):
        ws.post_message(cfg.forbidden_burson_space, "Allowlist verification probe")

    stamp = int(time.time())
    space = ws.setup_space(
        display_name=f"SLRR Live Pytest Space {stamp}",
        external_user_allowed=False,
        member_user_names=[],
        ephemeral=True,
    )
    space_name = str(space.get("name") or "")
    assert space_name.startswith("spaces/")

    created_msg_names: list[str] = []
    try:
        read_back = ws.get_space(space_name)
        assert str(read_back.get("spaceUri") or "").startswith("https://")
        assert bool(read_back.get("externalUserAllowed", False)) is False
        assert str(read_back.get("spaceHistoryState") or "") != ""

        root_msg = ws.post_message(space_name, "Root post from live integration test.")
        root_msg_name = str(root_msg.get("name") or "")
        assert root_msg_name != ""
        created_msg_names.append(root_msg_name)
        thread_name = str((root_msg.get("thread") or {}).get("name") or "")
        assert thread_name.startswith(f"{space_name}/threads/")

        reply_msg = ws.post_message(
            space_name,
            "Thread reply from live integration test.",
            thread_name=thread_name,
        )
        reply_msg_name = str(reply_msg.get("name") or "")
        assert reply_msg_name != ""
        created_msg_names.append(reply_msg_name)

        # Own-message recognition via both client-scmp- ID and Firestore created_messages.
        assert ws.is_own_or_bot_message(root_msg) is True
        assert ws.is_own_or_bot_message(reply_msg) is True
        assert store.is_created_message(root_msg_name) is True

        # Cursor listing skips own messages while recent listing shows both posted messages.
        early_cursor = "2020-01-01T00:00:00Z"
        human_only = ws.list_human_messages(space_name, thread_name=thread_name, since_iso=early_cursor)
        assert human_only == []

        recent_listed = ws.list_recent_space_messages(space_name, page_size=10)
        listed_names = {str(m.get("name") or "") for m in recent_listed}
        assert root_msg_name in listed_names
        assert reply_msg_name in listed_names
    finally:
        # delete_space verifies 404 on read-back and unregisters the ephemeral space from Firestore.
        ws.delete_space(space_name)
        if created_msg_names:
            store.delete_test_documents(message_names=created_msg_names)

    for mname in created_msg_names:
        assert store.is_created_message(mname) is False


@pytest.mark.live
def test_gmail_partition_queries_return_disjoint_sets(
    live_runtime: RuntimeDependencies,
) -> None:
    """Verify v1 Chrome Alerts query and slrr-campaigns query return disjoint sets on the real mailbox."""
    ws = live_runtime.workspace
    chrome_ids = set(ws.search_gmail_message_ids(CHROME_ALERTS_GMAIL_QUERY, max_results=50))
    campaign_ids = set(ws.search_gmail_message_ids(GMAIL_CAMPAIGN_QUERY, max_results=50))
    assert chrome_ids.isdisjoint(campaign_ids)


@pytest.mark.live
def test_sheets_drive_and_docs_create_write_read_delete(
    live_runtime: RuntimeDependencies,
) -> None:
    """Create, write, read, and delete a campaign spreadsheet and a Google Doc in the Drive folder."""
    ws = live_runtime.workspace
    folder_id = live_runtime.cfg.drive_folder_id
    stamp = int(time.time())

    sheet_id, sheet_url, _ = ws.create_spreadsheet(
        title=f"SLRR Live Test Sheet {stamp}",
        folder_id=folder_id,
        sheet_titles=["Summary", "Mentions"],
    )
    assert sheet_id != ""
    assert sheet_url.startswith("https://")
    try:
        ws.write_sheet_values(
            sheet_id,
            "'Summary'!A1:B2",
            [["Campaign ID", "TEST01"], ["Status", "active"]],
        )
        ws.append_sheet_rows(
            sheet_id,
            "'Mentions'!A1",
            [["https://reddit.com/r/chrome/comments/abc", "reddit", "250"]],
        )
        summary_rows = ws.read_sheet_values(sheet_id, "'Summary'!A1:B2")
        assert summary_rows[0] == ["Campaign ID", "TEST01"]
        mentions_rows = ws.read_sheet_values(sheet_id, "'Mentions'!A1:C1")
        assert mentions_rows[0][1] == "reddit"
    finally:
        ws.delete_drive_file(sheet_id)
    assert ws.drive_file_exists(sheet_id) is False

    doc_id, doc_url = ws.create_report_doc(
        title=f"SLRR Live Test Report {stamp}",
        folder_id=folder_id,
        content="Executive Summary\nTotal mentions analyzed: 42\nZero emoji verification line.",
    )
    assert doc_id != ""
    assert doc_url.startswith("https://")
    try:
        read_text = ws.read_doc_text(doc_id)
        assert "Total mentions analyzed: 42" in read_text
    finally:
        ws.delete_drive_file(doc_id)
    assert ws.drive_file_exists(doc_id) is False


@pytest.mark.live
def test_gemini_parses_real_alerts_and_drafts_valid_brandwatch_boolean(
    live_runtime: RuntimeDependencies,
) -> None:
    """Parse real alerts-space messages at temperature 0 and validate a drafted boolean via Brandwatch."""
    ws = live_runtime.workspace
    gemini = live_runtime.gemini
    bw = live_runtime.bw

    recent_msgs = ws.list_recent_space_messages(live_runtime.cfg.alerts_space, page_size=15)
    assert len(recent_msgs) >= 1
    real_alert_text = ""
    for item in recent_msgs:
        txt = str(item.get("text") or "").strip()
        if len(txt) > 40:
            real_alert_text = txt
            break
    assert real_alert_text != ""

    intent = gemini.parse_initial_intent(
        user_text="Can you run a 48h Brandwatch deep dive on this alert?",
        alert_text=real_alert_text,
    )
    assert intent.intent == "deep_dive"
    assert 1 <= intent.deep_dive_days <= 7

    step_parsed = gemini.parse_step_reply(
        step_name="cs_threshold",
        step_instructions="Choose engagement threshold: 1=0, 2=200, 3=500, or custom integer.",
        current_Time_ny=datetime.now(UTC).strftime("%Y-%m-%d %H:%M UTC"),
        user_reply="set it to 350",
    )
    assert step_parsed.outcome in ("parsed", "command")

    cached_queries = bw.get_cached_queries()
    example_booleans = [
        q.boolean_query for q in cached_queries if q.boolean_query and not q.name.startswith("SLRR-CMP-")
    ][:3]
    builder = QueryBuilderDraft(
        short_name="Chrome Browser Update",
        core_terms=["Google Chrome", "Chrome update"],
        context_proximity="crash OR freeze within 5 words of Chrome",
        alternate_phrases=["Chrome browser crash"],
        exclusions=["chromebook giveaway"],
        content_sources=["reddit", "news"],
        languages=["en"],
    )
    drafted = gemini.draft_boolean(
        builder=builder,
        example_booleans=example_booleans,
        previous_errors=[],
    )
    assert drafted.boolean_query.strip() != ""
    val_resp = bw.validate_query(boolean_query=drafted.boolean_query, languages=["en"])
    val_errors, _ = format_validation_issues(val_resp)
    assert val_errors == [], f"Drafted boolean failed /query-validation: {val_errors}"


@pytest.mark.live
def test_people_api_resolves_approver_emails_to_chat_users(
    live_runtime: RuntimeDependencies,
) -> None:
    """Confirm every approver email in Registry Settings resolves to a Google Chat users/{id} resource."""
    settings = load_registry_settings(live_runtime.cfg, live_runtime.workspace)
    assert len(settings.approver_emails) >= 1
    approver_users = resolve_approver_users(settings, live_runtime.workspace)
    assert len(approver_users) >= 1
    for user_res in approver_users:
        assert user_res.startswith("users/")
