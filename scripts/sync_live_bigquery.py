"""Pull real live alerts from bsip-s-bsip-gg-26-2cf3.google_bg (us-central1) and
brand-social-central-data.slrr_alerts (US) and run them through the SLRR Triage Agent
with live Vertex AI Gemini (models from config: gemini-3.8-flash on the global endpoint) in stealth Burson mode.

Usage:
    PYTHONPATH=. .venv/bin/python scripts/sync_live_bigquery.py --db .local/live.db [--reset]

--db defaults to $TRIAGE_LOCAL_DB, then .local/live.db. The SQLite file there is kept and added to;
it is deleted first only when --reset is given.
"""

from __future__ import annotations

import argparse
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from google.cloud import bigquery

from tests.test_production_artifacts import (
    BURSON_ALERT_1_P1_AIO,
    BURSON_ALERT_2_P2_MAPS,
    BURSON_ALERT_3_P0_PARIS,
)
from triage_agent.config import load_config
from triage_agent.context import AgentContext
from triage_agent.escalation.gmail import FakeGmail
from triage_agent.events import SqliteEventLogger
from triage_agent.inhouse import _format_raw_alert, row_to_parsed
from triage_agent.llm import VertexGemini
from triage_agent.operations import handle
from triage_agent.outbox import NoopDoorbell
from triage_agent.qa.sonar import SonarLookup
from triage_agent.store import SqliteStore

REAL_BURSON_ALERTS = [
    {
        "id": "burson-v3-1",
        "label": "P1 High Engagement — AI Overviews (Polymarket)",
        "text": BURSON_ALERT_1_P1_AIO,
    },
    {
        "id": "burson-v3-2",
        "label": "P2 High Engagement — Maps/Geo (Venice)",
        "text": BURSON_ALERT_2_P2_MAPS,
    },
    {
        "id": "burson-v3-3",
        "label": "P0 Perceived Bias — Search (Paris Riots 2026)",
        "text": BURSON_ALERT_3_P0_PARIS,
    },
]


def fetch_latest_slrr_alerts(client_us: bigquery.Client, limit: int = 6) -> list[dict[str, Any]]:
    sql = """
    SELECT
      record_id, source_tab, sheet_row_number, ingestion_timestamp, date_added, post_time,
      author_handle, followers, status, issue_name, novelty, category, exposure_tag, risk_tag,
      product, overview, original_post, engagement_level, engagements_actual, shares_rts,
      comments, likes, url, identifier_analyst, viral_kof, social_network, social_alert, ts_action
    FROM `brand-social-central-data.slrr_alerts.slrr_alerts`
    WHERE ingestion_timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 14 DAY)
    ORDER BY ingestion_timestamp DESC, sheet_row_number DESC
    LIMIT @n
    """
    job = client_us.query(
        sql,
        job_config=bigquery.QueryJobConfig(
            query_parameters=[bigquery.ScalarQueryParameter("n", "INT64", limit)],
            labels={"app": "slrr-triage-agent", "component": "live-sync"},
        ),
    )
    return [dict(r.items()) for r in job.result()]


def fetch_latest_sonar_raw(client_central: bigquery.Client, limit: int = 5) -> list[dict[str, Any]]:
    sql = """
    SELECT
      ANY_VALUE(post_id) AS post_id,
      post_url,
      ARRAY_AGG(post_timestamp IGNORE NULLS ORDER BY received_at DESC LIMIT 1)[SAFE_OFFSET(0)] AS post_timestamp,
      ARRAY_AGG(platform IGNORE NULLS ORDER BY received_at DESC LIMIT 1)[SAFE_OFFSET(0)] AS platform,
      ARRAY_AGG(language IGNORE NULLS ORDER BY received_at DESC LIMIT 1)[SAFE_OFFSET(0)] AS language,
      ARRAY_AGG(JSON_VALUE(payload, "$.detail.channel.username") IGNORE NULLS ORDER BY received_at DESC LIMIT 1)[SAFE_OFFSET(0)] AS author,
      MAX(follower_count) AS followers,
      ARRAY_AGG(JSON_VALUE(payload, "$.detail.classification.summary") IGNORE NULLS ORDER BY received_at DESC LIMIT 1)[SAFE_OFFSET(0)] AS summary,
      ARRAY_AGG(JSON_VALUE(payload, "$.detail.classification.issue_name") IGNORE NULLS ORDER BY received_at DESC LIMIT 1)[SAFE_OFFSET(0)] AS issue_name,
      ARRAY_AGG(alert_criticality IGNORE NULLS ORDER BY received_at DESC LIMIT 1)[SAFE_OFFSET(0)] AS criticality,
      MAX(engagement_likes) AS likes,
      MAX(engagement_comments) AS comments,
      MAX(engagement_shares) AS shares,
      ARRAY_AGG(DISTINCT smart_tag IGNORE NULLS LIMIT 8) AS smart_tags,
      ARRAY_AGG(JSON_VALUE(payload, "$.detail.post.snippet.text") IGNORE NULLS ORDER BY received_at DESC LIMIT 1)[SAFE_OFFSET(0)] AS aggregated_content,
      MIN(received_at) AS first_received_at,
      MAX(received_at) AS last_received_at
    FROM `bsip-s-bsip-gg-26-2cf3.google_bg.sonar_raw`
    WHERE received_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 24 HOUR)
      AND post_url IS NOT NULL
      AND smart_tag IS NOT NULL AND TRIM(smart_tag) != ''
    GROUP BY post_url
    HAVING summary IS NOT NULL AND summary != ''
    ORDER BY last_received_at DESC
    LIMIT @n
    """
    job = client_central.query(
        sql,
        job_config=bigquery.QueryJobConfig(
            query_parameters=[bigquery.ScalarQueryParameter("n", "INT64", limit)],
            labels={"app": "slrr-triage-agent", "component": "live-sync"},
        ),
    )
    return [dict(r.items()) for r in job.result()]


def fetch_latest_slrr_source_mirror(client_us: bigquery.Client, limit: int = 5) -> list[dict[str, Any]]:
    sql = """
    SELECT *
    FROM `brand-social-central-data.slrr_alerts.slrr_source_mirror`
    WHERE overview_of_post IS NOT NULL AND overview_of_post != ''
    ORDER BY created_at DESC
    LIMIT @n
    """
    job = client_us.query(
        sql,
        job_config=bigquery.QueryJobConfig(
            query_parameters=[bigquery.ScalarQueryParameter("n", "INT64", limit)],
            labels={"app": "slrr-triage-agent", "component": "live-sync"},
        ),
    )
    return [dict(r.items()) for r in job.result()]


def sync_live(db_path: str = ".local/live.db", reset: bool = False) -> dict[str, Any]:
    p = Path(db_path)
    if reset and p.exists():
        p.unlink()
    p.parent.mkdir(parents=True, exist_ok=True)

    store = SqliteStore(p)
    cfg = load_config(store)
    cfg.burson_feedback.silent_in_burson_space = True
    cfg.sonar_lookup.enabled = True
    cfg.inhouse.enabled = True

    llm = VertexGemini(project="brand-social-central-data", location=cfg.models.location)
    sonar = SonarLookup(cfg)
    gmail = FakeGmail(connect_all=True)

    ctx = AgentContext(
        config=cfg,
        store=store,
        events=SqliteEventLogger(p),
        llm=llm,
        gmail=gmail,
        sonar=sonar,
        doorbell=NoopDoorbell(),
    )

    # Seed real rosters into the store
    ctx.roster("slrr_im")
    ctx.roster("burson")

    print("=" * 88)
    print(f"LIVE PRODUCTION SYNC -> {p.resolve()}")
    print(
        f"  Vertex AI Gemini : {cfg.models.triage} (triage) / {cfg.models.drafting} (drafting) @ {cfg.models.location}"
    )
    print(f"  Sonar Lookup     : {cfg.sonar_lookup.table} ({cfg.sonar_lookup.location})")
    print(f"  In-house Outbox  : {cfg.inhouse.outbox_view} ({cfg.inhouse.location})")
    print(f"  Stealth Burson   : silent_in_burson_space={cfg.burson_feedback.silent_in_burson_space}")
    print("=" * 88)

    # 1. Process the 3 real Burson V3 Chat messages from [S-F] Burson Automated Alerts V3
    burson_cases: list[str] = []
    for item in REAL_BURSON_ALERTS:
        thread_id = f"thread-{item['id']}"
        existing = ctx.store.find_case_by_source_ref("burson", f"spaces/AAQAaa_0I9g:{thread_id}")
        if existing and existing.latest:
            cid = existing.case_id
            burson_cases.append(cid)
            if not existing.clean_message_ref:
                existing.clean_message_ref = f"clean-{cid}"
                ctx.store.save_case(existing)
            print(
                f"[Burson V3 Chat] {cid} (cached): {item['label']} -> verdict={existing.latest.result.verdict.value} "
                f"track={existing.track} status={existing.status.value}"
            )
            continue
        resp = handle(
            {
                "op": "triage_message",
                "payload": {
                    "message": {
                        "message_id": item["id"],
                        "text": item["text"],
                        "sender": {"name": "Zapier", "type": "BOT"},
                        "space_id": "spaces/AAQAaa_0I9g",
                        "space_name": "[S-F] Burson Automated Alerts V3",
                        "thread_id": thread_id,
                        "conversation_type": "SPACE",
                    }
                },
            },
            ctx,
        )
        cid = resp.outputs.get("case_id")
        assert resp.outputs["has_burson"] == "no", "Stealth Burson mode violated!"
        if cid:
            burson_cases.append(cid)
            c_obj = ctx.store.get_case(cid)
            if c_obj and not c_obj.clean_message_ref:
                c_obj.clean_message_ref = f"clean-{cid}"
                ctx.store.save_case(c_obj)
            print(
                f"[Burson V3 Chat] {cid}: {item['label']} -> verdict={resp.data.get('verdict')} "
                f"track={c_obj.track if c_obj else None} status={c_obj.status.value if c_obj else None}"
            )

    # 2. Pull recent real alerts from brand-social-central-data.slrr_alerts.slrr_alerts (US)
    slrr_rows = fetch_latest_slrr_alerts(sonar.client_us, limit=6)
    print(
        f"\nFetched {len(slrr_rows)} live rows from brand-social-central-data.slrr_alerts.slrr_alerts (last 14d)"
    )
    for row in slrr_rows:
        parsed = row_to_parsed(ctx, row)
        raw_msg = _format_raw_alert(parsed.fields)
        rid = str(row.get("record_id") or "")[:16]
        thread_id = f"thread-slrr-{rid}"
        existing = ctx.store.find_case_by_source_ref("burson", f"spaces/AAQAaa_0I9g:{thread_id}")
        if existing and existing.latest:
            cid = existing.case_id
            burson_cases.append(cid)
            if not existing.clean_message_ref:
                existing.clean_message_ref = f"clean-{cid}"
                ctx.store.save_case(existing)
            print(
                f"[Live SLRR BQ]   {cid} (cached): {parsed.fields.get('product')} | {parsed.fields.get('issue_name')} "
                f"-> verdict={existing.latest.result.verdict.value} track={existing.track} status={existing.status.value}"
            )
            continue
        resp = handle(
            {
                "op": "triage_message",
                "payload": {
                    "message": {
                        "message_id": f"slrr-live-{rid}",
                        "text": raw_msg,
                        "sender": {"name": "Zapier", "type": "BOT"},
                        "space_id": "spaces/AAQAaa_0I9g",
                        "space_name": "[S-F] Burson Automated Alerts V3",
                        "thread_id": thread_id,
                        "conversation_type": "SPACE",
                    }
                },
            },
            ctx,
        )
        cid = resp.outputs.get("case_id")
        assert resp.outputs["has_burson"] == "no", "Stealth Burson mode violated!"
        if cid:
            burson_cases.append(cid)
            c_obj = ctx.store.get_case(cid)
            if c_obj and not c_obj.clean_message_ref:
                c_obj.clean_message_ref = f"clean-{cid}"
                ctx.store.save_case(c_obj)
            print(
                f"[Live SLRR BQ]   {cid}: {parsed.fields.get('product')} | {parsed.fields.get('issue_name')} "
                f"-> verdict={resp.data.get('verdict')} track={c_obj.track if c_obj else None} status={c_obj.status.value if c_obj else None}"
            )

    # 3. Pull real in-house rows from brand-social-central-data.slrr_alerts.slrr_source_mirror (US)
    #    and bsip-s-bsip-gg-26-2cf3.google_bg.sonar_raw (us-central1)
    mirror_rows = fetch_latest_slrr_source_mirror(sonar.client_us, limit=4)
    sonar_rows = fetch_latest_sonar_raw(sonar.client, limit=4)
    inhouse_rows = mirror_rows + sonar_rows
    print(
        f"\nFetched {len(mirror_rows)} rows from slrr_source_mirror + {len(sonar_rows)} rows from "
        f"google_bg.sonar_raw"
    )
    ih_resp = handle(
        {
            "op": "ingest_inhouse",
            "payload": {"rows": inhouse_rows},
            "context": {
                "deliver": "outbox",
                "flow": "job",
                "invoked_by": "job:live-sync",
            },
        },
        ctx,
    )
    print(f"[In-house Ingest] {ih_resp.outputs.get('summary')}")

    # 4. Trigger 📦 (PA email draft) on HIGH_ENGAGEMENT passed cases so HTML email drafts are ready to inspect
    preview_dir = Path(".local/email_previews")
    preview_dir.mkdir(parents=True, exist_ok=True)
    im_email = ctx.im_on_shift().person.email if ctx.im_on_shift().person else "im@ops.test"

    for cid in burson_cases:
        c = ctx.store.get_case(cid)
        if not c or not c.latest:
            continue
        if c.latest.result.verdict.value in ("PASS", "CORRECTED") and not c.escalation_ids:
            rx_resp = handle(
                {
                    "op": "record_reaction",
                    "payload": {
                        "emoji": "📦",
                        "reactor_email": im_email,
                        "reactor_name": "On-Shift IM",
                        "message_text": f"[{cid}]",
                        "message_id": c.clean_message_ref or f"clean-{cid}",
                        "space": "SLRR Triaged Alerts",
                    },
                },
                ctx,
            )
            print(f"[PA Email Draft] {cid} -> {rx_resp.outputs.get('summary')}")

    draft_count = 0
    for esc in ctx.store.list_escalations(limit=500):
        for em in esc.emails:
            for v in em.versions:
                html_body = getattr(v, "html_body", None) or v.body
                if html_body:
                    out_file = preview_dir / f"{esc.escalation_id}_{em.purpose}_v{v.version}.html"
                    out_file.write_text(html_body, encoding="utf-8")
                    draft_count += 1

    summary = {
        "db": str(p.resolve()),
        "cases": len(ctx.store.list_cases(limit=500)),
        "events": len(ctx.events.query(limit=5000)),
        "html_drafts": draft_count,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    print("\nSummary:", summary)
    return summary


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=os.environ.get("TRIAGE_LOCAL_DB", ".local/live.db"))
    ap.add_argument(
        "--reset",
        action=argparse.BooleanOptionalAction,
        default=False,
        help="delete the SQLite file at --db before the run (default: keep it and add to it)",
    )
    args = ap.parse_args(argv)
    sync_live(db_path=args.db, reset=args.reset)


if __name__ == "__main__":
    main()
