"""Path B: in-house alerts from BigQuery (brand-social-central-data.slrr_alerts and bsip-s-bsip-gg-26-2cf3.google_bg).

Rows are mapped onto the alert fields and run through the same QA as Burson
alerts. During parity (inhouse.parity_mode) nothing is posted to chat; cases
and parity events feed the Console. After cutover, alerts post like Burson's.
"""

import logging
from datetime import datetime
from typing import Any

from .context import AgentContext
from .events import EventType
from .models import ChatMessage, ChatOutputs, ChatUser, ParsedAlert, RequestContext
from .operations import enqueue_outputs, operation
from .qa.parser import normalize_value, parse_datetime

log = logging.getLogger(__name__)

# Column candidates -> canonical alert field (checked in order per field)
FIELD_CANDIDATES: dict[str, tuple[str, ...]] = {
    "alert_name": ("alert_name", "social_alert"),
    "issue_name": ("issue_name",),
    "issue_status": ("issue_status", "issue_name_novelty", "novelty"),
    "priority": ("priority", "collection_tier"),
    "exposure_tag": ("exposure_tag",),
    "product": ("product", "query_name"),
    "other_products": ("other_products",),
    "social_network": ("social_network", "platform"),
    "post_url": ("post_url", "post_link", "url"),
    "post_content": ("post_content", "aggregated_content", "original_post", "snippet", "content"),
    "summary": ("sonar_summary", "summary", "overview_of_post", "overview"),
    "author": ("author", "creator_handle", "author_handle"),
    "followers": ("followers", "creator_followers", "follower_count"),
    "location": ("channel_location", "location"),
    "kof": ("is_kof", "is_kol"),
    "kof_lists": ("kof_lists", "kof_vertical", "viral_kof"),
    "risk_tags": ("risk_tags", "sensitive_topic", "risk_tag"),
    "engagement_level": ("engagement_level",),
    "total_engagement": ("total_engagement", "total_engagements", "engagements_actual", "engagement_count"),
    "likes": ("likes",),
    "comments": ("comments",),
    "shares": ("shares", "shares_rts"),
    "views": ("views",),
    "post_date": ("post_timestamp", "post_time", "date_added"),
    "ts": ("ts_recommended", "ts_action"),
}

EXTRA_COLUMNS = (
    "relevance_score", "language", "alert_track", "alert_action", "reason_codes", "sensitive_topics",
    "first_detected_at", "related_alert_id", "alert_id", "id", "record_id", "post_id", "sonar_post_id",
    "sonar_instance_id", "suggested_routing", "identifier_analyst", "source_tab", "sheet_row_number",
    "query_id", "query_name", "alert_type",
)

PLATFORM_MAP = {
    "x (twitter)": "X",
    "twitter": "X",
    "x": "X",
    "youtube": "YouTube",
    "reddit": "Reddit",
    "tiktok": "TikTok",
    "instagram": "Instagram",
    "facebook": "Facebook",
    "bluesky": "Bluesky",
    "threads": "Threads",
    "linkedin": "LinkedIn",
    "truth social": "Truth Social",
}


def _first_present(row: dict[str, Any], cols: tuple[str, ...]) -> Any:
    for col in cols:
        val = row.get(col)
        if val not in (None, "", []):
            return val
    return None


def _format_raw_alert(fields: dict[str, Any]) -> str:
    if fields.get("alert_name") and str(fields["alert_name"]).startswith("["):
        return str(fields["alert_name"])
    issue = fields.get("issue_name") or fields.get("alert_name") or "Social Alert"
    status = fields.get("issue_status") or "Ongoing Issue"
    name_line = f"{issue} / {status}" if status and status not in str(issue) else str(issue)
    eng_level = fields.get("engagement_level") or "VERY LOW"
    eng_total = fields.get("total_engagement") if fields.get("total_engagement") is not None else 0
    product = fields.get("product") or "Brand"
    network = fields.get("social_network") or "X"
    exp_tag = fields.get("exposure_tag") or "Product - Other/general criticism"
    risks = fields.get("risk_tags")
    risk_str = ", ".join(risks) if isinstance(risks, list) and risks else "-"
    kof_lists = fields.get("kof_lists")
    if isinstance(kof_lists, list) and kof_lists:
        kof_str = f"Yes ({', '.join(kof_lists)})"
    elif fields.get("kof"):
        kof_str = "Yes"
    else:
        kof_str = "No"
    summary = fields.get("summary") or fields.get("post_content") or ""
    url = fields.get("post_url") or ""
    author = str(fields.get("author") or "").lstrip("@")
    code = f"{exp_tag},{eng_total},{author},{risk_str},{product},{status}"
    lines = [
        f"⬛SOCIAL ALERT⬛: {product} | {issue} | {network} | {eng_total} Engagements",
        f"[Name]: {name_line}",
        f"[Engagement]: {eng_level} ({eng_total} engagements)",
        f"[Product]: {product}",
        f"[Social Network]: {network}",
        f"[Exposure Tag]: {exp_tag}",
        f"[Sensitive Topic]: {risk_str}",
        f"[KOF]: {kof_str}",
        "",
        str(summary),
        "",
        f"[Link]: {url}",
        f"[Code]: {code}",
    ]
    return "\n".join(lines)


def row_to_parsed(ctx: AgentContext, row: dict[str, Any]) -> ParsedAlert:
    tpl = ctx.config.alert_template
    fields: dict[str, Any] = {}
    for name, candidates in FIELD_CANDIDATES.items():
        value = _first_present(row, candidates)
        if value in (None, "", []):
            continue
        spec = tpl.field(name)
        if name == "issue_status" and isinstance(value, str):
            low = value.strip().lower()
            if low.startswith("new"):
                value = "NEW"
            elif low in ("recently reported",):
                value = "Recently Reported"
            elif "ongoing" in low:
                value = "Ongoing Issue"
        elif name == "social_network" and isinstance(value, str):
            value = PLATFORM_MAP.get(value.strip().lower(), value.strip())
        elif name in ("followers", "total_engagement", "likes", "comments", "shares", "views"):
            try:
                value = int(float(value))
            except (TypeError, ValueError):
                pass
        elif name in ("kof_lists", "risk_tags") and isinstance(value, str):
            cleaned = value.strip()
            if cleaned.lower() in ("", "no", "none", "-", "n/a"):
                continue
            value = [p.strip() for p in cleaned.split(",") if p.strip()]
        if name == "risk_tags" and isinstance(value, list):
            mapped_topics: list[str] = []
            for item in value:
                t = ctx.config.collection.topic(str(item))
                mapped_topics.append(t.name if t else str(item))
            value = mapped_topics
        elif name == "product" and isinstance(value, str):
            p = ctx.config.distribution.product(value)
            if p and not p.deprecated:
                value = p.name
            elif row.get("product") in (None, "") and row.get("query_name"):
                value = ctx.config.distribution.fallback_product
        elif name == "exposure_tag" and isinstance(value, str):
            t = ctx.config.collection.tag(value)
            if t:
                value = t.name
        fields[name] = normalize_value(spec, value, ctx.config.timezone) if (spec and isinstance(value, str)) else value

    if "exposure_tag" not in fields and isinstance(row.get("smart_tags"), list) and row["smart_tags"]:
        tag_val = str(row["smart_tags"][0])
        t = ctx.config.collection.tag(tag_val)
        fields["exposure_tag"] = t.name if t else tag_val

    alert_type = str(row.get("alert_type") or "").strip().upper()
    if "kof" not in fields:
        fields["kof"] = bool(fields.get("kof_lists")) or alert_type == "KOF"

    if "total_engagement" not in fields:
        likes = fields.get("likes")
        comments = fields.get("comments")
        shares = fields.get("shares")
        if any(isinstance(x, int) for x in (likes, comments, shares)):
            fields["total_engagement"] = int(likes or 0) + int(comments or 0) + int(shares or 0)

    if "engagement_level" not in fields:
        if fields.get("kof"):
            fields["engagement_level"] = "VIRAL KOF"
        elif isinstance(fields.get("total_engagement"), int):
            lvl = ctx.config.collection.level_for(fields["total_engagement"], is_kof=False)
            if lvl:
                fields["engagement_level"] = lvl
        elif alert_type in ("HIGH", "MODERATE", "LOW", "VERY LOW"):
            fields["engagement_level"] = alert_type

    if "alert_name" not in fields and fields.get("issue_name"):
        status = fields.get("issue_status")
        fields["alert_name"] = f"{fields['issue_name']} / {status}" if status else str(fields["issue_name"])

    extra = {
        k: (v.isoformat() if isinstance(v, datetime) else v)
        for k, v in row.items()
        if k in EXTRA_COLUMNS and v is not None
    }
    raw_text = str(row.get("alert_name") or _format_raw_alert(fields))
    return ParsedAlert(
        template_id="brand_safety_alert_log",
        fields=fields,
        raw_text=raw_text,
        parse_method="structured",
        extra=extra,
    )


def _row_alert_id(row: dict[str, Any]) -> str:
    for col in ("alert_id", "id", "record_id", "post_id", "sonar_post_id"):
        val = row.get(col)
        if val not in (None, ""):
            return str(val)
    raw_url = str(row.get("url") or row.get("post_url") or row.get("post_link") or "").strip()
    if raw_url:
        from .qa.record_key import normalize_url

        return normalize_url(raw_url) or raw_url
    return ""


def _row_timestamp(row: dict[str, Any]) -> Any:
    for col in ("alerted_at", "created_at", "ingestion_timestamp", "ingestion_time", "last_received_at", "received_at", "date_added"):
        val = row.get(col)
        if val not in (None, ""):
            return val
    return None


def fetch_rows(ctx: AgentContext) -> list[dict[str, Any]]:
    from google.cloud import bigquery  # lazy: only the job needs BigQuery

    cfg = ctx.config.inhouse
    project = getattr(cfg, "project", None) or "brand-social-central-data"
    location = cfg.location
    if "bsip-s-bsip-gg-26-2cf3.google_bg" in cfg.outbox_view or "slrr_staging_central1" in cfg.outbox_view:
        location = getattr(cfg, "sonar_location", "us-central1")
    client = bigquery.Client(project=project, location=location)

    if cfg.outbox_view.endswith(".sonar_raw"):
        latest = lambda expr: f"ARRAY_AGG({expr} IGNORE NULLS ORDER BY received_at DESC LIMIT 1)[SAFE_OFFSET(0)]"
        sql = (
            "SELECT "
            "  ANY_VALUE(post_id) AS post_id, post_url, "
            f"  {latest('post_timestamp')} AS post_timestamp, "
            f"  {latest('platform')} AS platform, "
            f"  {latest('language')} AS language, "
            f"  {latest('JSON_VALUE(payload, \"$.detail.channel.username\")')} AS author, "
            "  MAX(follower_count) AS follower_count, "
            f"  {latest('JSON_VALUE(payload, \"$.detail.classification.summary\")')} AS summary, "
            f"  {latest('JSON_VALUE(payload, \"$.detail.classification.issue_name\")')} AS issue_name, "
            "  MAX(engagement_likes) AS likes, MAX(engagement_comments) AS comments, MAX(engagement_shares) AS shares, "
            "  ARRAY_AGG(DISTINCT smart_tag IGNORE NULLS LIMIT 8) AS smart_tags, "
            f"  {latest('NULLIF(TRIM(influencer_list), \"\")')} AS kof_vertical, "
            f"  {latest('JSON_VALUE(payload, \"$.detail.post.snippet.text\")')} AS post_content, "
            "  MAX(received_at) AS last_received_at "
            f"FROM `{cfg.outbox_view}` "
            "WHERE received_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 24 HOUR) AND post_url IS NOT NULL "
            "GROUP BY post_url "
            "ORDER BY last_received_at DESC LIMIT @n"
        )
    else:
        if cfg.outbox_view.endswith(".slrr_source_mirror") or cfg.outbox_view.endswith(".slrr_source"):
            order_col = "created_at DESC"
        elif cfg.outbox_view.endswith(".slrr_alerts"):
            order_col = "ingestion_timestamp DESC"
        elif cfg.outbox_view.endswith(".DSD-story-selection"):
            order_col = "ingestion_time DESC"
        else:
            order_col = "alerted_at"
        sql = f"SELECT * FROM `{cfg.outbox_view}` ORDER BY {order_col} LIMIT @n"

    job = client.query(
        sql,
        job_config=bigquery.QueryJobConfig(
            query_parameters=[bigquery.ScalarQueryParameter("n", "INT64", cfg.max_rows_per_run)],
            labels={"app": "slrr-triage-agent", "component": "inhouse-ingest"},
        ),
    )
    return [dict(r.items()) for r in job.result()]


def mark_delivered(ctx: AgentContext, alert_ids: list[str]) -> None:
    from google.cloud import bigquery

    cfg = ctx.config.inhouse
    project = getattr(cfg, "project", None) or "brand-social-central-data"
    client = bigquery.Client(project=project, location=cfg.location)
    sql = (
        f"UPDATE `{cfg.alert_log_table}` SET delivered_at = CURRENT_TIMESTAMP() "
        "WHERE alert_id IN UNNEST(@ids) AND alerted_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 2 DAY)"
    )
    client.query(
        sql,
        job_config=bigquery.QueryJobConfig(
            query_parameters=[bigquery.ArrayQueryParameter("ids", "STRING", alert_ids)],
            labels={"app": "slrr-triage-agent", "component": "inhouse-ingest"},
        ),
    ).result()


@operation("ingest_inhouse")
def ingest_inhouse(ctx: AgentContext, payload: dict[str, Any], rc: RequestContext):
    from .triage import process_alert  # local import: triage imports operations

    cfg = ctx.config.inhouse
    if not cfg.enabled and not payload.get("rows"):
        return ChatOutputs(summary="in-house ingestion disabled"), {"processed": 0}
    rows = payload.get("rows") if payload.get("rows") is not None else fetch_rows(ctx)
    processed, skipped, posted, delivered = 0, 0, 0, []
    verdicts: dict[str, int] = {}
    failed: list[str] = []
    no_id = 0
    for row in rows:
        alert_id = _row_alert_id(row)
        if not alert_id:
            no_id += 1
            continue
        if ctx.store.find_case_by_source_ref("inhouse", alert_id):
            skipped += 1
            continue
        try:
            parsed = row_to_parsed(ctx, row)
            received = parse_datetime(_row_timestamp(row), ctx.config.timezone) or ctx.now()
            msg = ChatMessage(
                message_id=f"inhouse:{alert_id}",
                text=parsed.raw_text,
                sender=ChatUser(name="In-house pipeline", type="BOT"),
                create_time=received,
            )
            outputs, data = process_alert(
                ctx,
                parsed,
                source="inhouse",
                source_ref=alert_id,
                received_at=received,
                message=msg,
                post=not cfg.parity_mode,
            )
        except Exception as exc:  # noqa: BLE001 - one bad row must not block the rest of the feed
            # Nothing was stored for this row, so the next run picks it up again; `error` events show it.
            log.exception("in-house row %s failed", alert_id)
            failed.append(alert_id)
            try:
                ctx.emit(EventType.ERROR, actor="agent",
                         payload={"op": "ingest_inhouse", "alert_id": alert_id, "error": str(exc), "retryable": True})
            except Exception:  # noqa: BLE001
                pass
            continue
        verdicts[data["verdict"]] = verdicts.get(data["verdict"], 0) + 1
        if not cfg.parity_mode:
            posted += len(enqueue_outputs(ctx, outputs, source="ingest_inhouse"))
        delivered.append(alert_id)
        processed += 1
    if no_id:
        log.warning("in-house: %d rows without an alert id were ignored", no_id)
    if cfg.mark_delivered and delivered and payload.get("rows") is None:
        try:
            mark_delivered(ctx, delivered)
        except Exception:  # noqa: BLE001 - rows are idempotent via source_ref; retry next run
            log.exception("mark_delivered failed")
    summary = f"in-house: processed {processed}, skipped {skipped}, queued {posted} posts, verdicts {verdicts}"
    if failed:
        summary += f", failed {len(failed)} (retried next run)"
    return ChatOutputs(summary=summary), {"processed": processed, "skipped": skipped, "queued": posted,
                                          "verdicts": verdicts, "failed": failed, "no_id": no_id}
