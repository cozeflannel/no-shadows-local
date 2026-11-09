"""SLRR Collection Requirements (March 5, 2026) as code.

Mirrors brand_safety_alerting/sql/02_brand_safety_alerts.sql so that QA of
Burson alerts (Path A) and in-house alerts (Path B) reach the same decisions:

  sensitive topics (minus redundant risk tags; Politics = US/unknown or English election)
  exclusions (unless a risk signal), URGENT reasons, 2K+ track, 14-day novelty,
  ongoing-URGENT-needs-KOF, YouTube / Doodle / leadership protocols, T&S
  recommendation, SLA, and the derived fields the IM used to fix by hand
  (issue status, engagement level, [TRACK] [STATUS] alert-name prefix).
"""

import logging
import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any

from ..config import AgentConfig
from ..models import AlertAssessment, Case, Correction, Issue, IssueSource, Severity
from ..routing import plan_recipients, suggest_actions
from .llm_assess import Enrichment
from .parser import parse_datetime

log = logging.getLogger(__name__)

# Sonar relevance gates from sql/02 (applied only when the source provides relevance_score).
P0_MIN_RELEVANCE = 0.8
SENSITIVE_MIN_RELEVANCE = 1.0
BRIEFED_MIN_RELEVANCE = 0.8
KOF_MIN_RELEVANCE = 0.8
HE_MIN_RELEVANCE = 0.8

# Sonar's textual relevance labels -> score. Anything else counts as unknown (gates don't apply).
RELEVANCE_LABELS = {
    "very_high": 1.0, "very high": 1.0, "great match": 1.0,
    "high": 0.85, "good match": 0.85,
    "medium": 0.65, "moderate": 0.65, "fair match": 0.65,
    "low": 0.3, "poor match": 0.3,
}

NEW_STATUSES = {"new", "recently reported", "new / not previously reported over the past 14 days"}
ONGOING_FIELD_VALUE = "Ongoing Issue"
NEW_FIELD_VALUE = "NEW"
_PREFIX_RE = re.compile(r"^\s*(?:\[[^\]]*\]\s*)+")


@dataclass
class RequirementsResult:
    assessment: AlertAssessment
    fields: dict[str, Any]
    corrections: list[Correction] = field(default_factory=list)
    warnings: list[Issue] = field(default_factory=list)
    review_reasons: list[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Issue-name tokens (same stemming + stopwords as sql/02 step 5)
# ---------------------------------------------------------------------------


def issue_tokens(name: str | None, stopwords: list[str]) -> list[str]:
    stop = {s.lower() for s in stopwords}
    out = set()
    for w in re.findall(r"[a-z0-9]+", (name or "").lower()):
        if len(w) > 4 and w.endswith("ies"):
            w = w[:-3] + "y"
        elif len(w) > 3 and w.endswith("s") and w != "news" and not re.search(r"(ss|us|is|as|os)$", w):
            w = w[:-1]
        if w not in stop and len(w) > 1:
            out.add(w)
    return sorted(out)


def jaccard(a: list[str], b: list[str]) -> float:
    sa, sb = set(a), set(b)
    return len(sa & sb) / len(sa | sb) if (sa or sb) else 0.0


def issue_name_of(fields: dict[str, Any]) -> str | None:
    """issue_name, else the part of the alert name after the product dash."""
    if fields.get("issue_name"):
        return str(fields["issue_name"]).strip()
    name = _PREFIX_RE.sub("", str(fields.get("alert_name") or "")).strip()
    for dash in (" – ", " — ", " - "):
        if dash in name:
            return name.split(dash, 1)[1].strip()
    return name or None


def same_issue(tokens: list[str], fingerprint: str, other: Case, min_jaccard: float, stopwords: list[str]) -> bool:
    if not tokens:
        return False
    other_tokens = (other.issue_fingerprint or "").split() or issue_tokens(other.issue_name, stopwords)
    if not other_tokens:
        return False
    return fingerprint == " ".join(other_tokens) or jaccard(tokens, other_tokens) >= min_jaccard


# ---------------------------------------------------------------------------
# Engine
# ---------------------------------------------------------------------------


def _rx(config: AgentConfig, name: str, text: str) -> bool:
    pattern = config.collection.patterns.get(name)
    return bool(pattern and re.search(pattern, text or "", flags=re.IGNORECASE))


def _as_list(v: Any) -> list[str]:
    if v in (None, ""):
        return []
    return [str(x) for x in v] if isinstance(v, list) else [str(v)]


def _briefed_hits(config: AgentConfig, products: list[str], text_all: str, now: datetime) -> list[str]:
    hits = []
    for b in config.collection.briefed_topics:
        if not b.active:
            continue
        start = parse_datetime(b.starts_at, config.timezone) if b.starts_at else None
        end = parse_datetime(b.ends_at, config.timezone) if b.ends_at else None
        if (start and now < start) or (end and now > end):
            continue
        ok_product = not b.product_regex or re.search(b.product_regex, " | ".join(products), re.IGNORECASE)
        ok_text = not b.text_regex or re.search(b.text_regex, text_all, re.IGNORECASE)
        if ok_product and ok_text and (b.product_regex or b.text_regex):
            hits.append(b.label)
    return hits


def evaluate(
    config: AgentConfig,
    fields_in: dict[str, Any],
    *,
    received_at: datetime,
    extra: dict[str, Any] | None = None,
    enrichment: Enrichment | None = None,
    history: list[Case] | None = None,
    history_complete: bool = True,
    flags: dict[str, bool] | None = None,
    pinned: dict[str, Any] | None = None,
) -> RequirementsResult:
    """Decide track / alertability / protocols / routing and derive fields.

    history: cases already alerted (clean_posted_at set) — used for 14-day novelty
    and leadership de-duplication. history_complete=False (agent younger than the
    novelty window) means "no match" can't prove an issue is NEW.
    pinned: field values an IM restored by reverting a correction; derivation keeps them
    (and the rest of the evaluation uses them) instead of re-deriving the same fix.
    """
    col = config.collection
    extra = extra or {}
    enr = enrichment or Enrichment()
    history = history or []
    flags = flags or {}
    pinned = pinned or {}
    fields = dict(fields_in)
    corrections: list[Correction] = []
    warnings: list[Issue] = []
    review: list[str] = []

    def derive(name: str, new: Any, reason: str, confidence: float = 1.0) -> None:
        """Set a derived field. Only overriding a value Burson provided counts as a correction."""
        if name in pinned:  # an IM reverted this fix: keep their value
            fields[name] = pinned[name]
            return
        current = fields.get(name)
        if current == new:
            return
        if config.alert_template.field(name) is None or current in (None, "", []):
            fields[name] = new
            return
        corrections.append(Correction(field=name, old=current, new=new, reason=reason,
                                      confidence=confidence, source=IssueSource.RULE))
        fields[name] = new

    product = str(fields.get("product") or "") or None
    others = _as_list(fields.get("other_products"))
    products = [p for p in [product, *others] if p]
    post = str(fields.get("post_content") or "")
    summary = str(fields.get("summary") or "")
    issue_name = issue_name_of(fields)
    text_all = "\n".join([post, summary, issue_name or "", str(fields.get("alert_name") or "")]).lower()
    snippet = post.lower() or text_all
    issue_text = f"{issue_name or ''}\n{summary}".lower()
    location = str(fields.get("location") or "").strip()
    language = str(extra.get("language") or col.language or "en").lower()
    raw_relevance = extra.get("relevance_score")
    relevance: float | None = None  # None = unknown: the relevance gates below don't apply
    if raw_relevance is not None:
        if isinstance(raw_relevance, (int, float)):
            relevance = float(raw_relevance)
        else:
            s_rel = str(raw_relevance).strip().lower()
            if s_rel:
                try:
                    relevance = float(s_rel)
                except ValueError:
                    relevance = RELEVANCE_LABELS.get(s_rel)
                    if relevance is None:
                        log.warning("unknown Sonar relevance label %r: treating relevance as unknown", raw_relevance)

    # -- exposure tag / priority (+ suspension-claiming-bias remap) -------------
    tag = col.tag(fields.get("exposure_tag"))
    if (col.remap_suspension_bias and tag and tag.name == "Product - Account deletion/suspension"
            and _rx(config, "censorship", text_all)):
        new_tag = col.tag("Product - Perceived bias")
        if new_tag:
            derive("exposure_tag", new_tag.name, "account suspension that claims censorship/bias")
            tag = new_tag
    priority = tag.priority if tag else (fields.get("priority") if fields.get("priority") in ("P0", "P1", "P2") else None)
    if tag and fields.get("priority") and fields.get("priority") != priority:
        derive("priority", priority, f"{tag.name} is {priority}")
    tag_name = tag.name if tag else (str(fields.get("exposure_tag")) if fields.get("exposure_tag") else None)

    # -- sensitive topics ----------------------------------------------------------
    risk_tags = _as_list(fields.get("risk_tags"))
    sensitive: list[str] = []
    for rt in risk_tags:
        topic = col.topic(rt)
        if not topic or col.is_redundant(tag_name, topic.name) or col.is_redundant(tag_name, rt):
            continue
        if topic.name == "Politics":
            us = (not location) or location.lower() in (u.lower() for u in col.politics_us_locations)
            election = language.startswith("en") and _rx(config, "election", text_all)
            if enr.politics_us_relevant is not None and not (us or election):
                us = enr.politics_us_relevant
            if not (us or election):
                continue
        if topic.name not in sensitive:
            sensitive.append(topic.name)
    briefed = _briefed_hits(config, products, text_all, received_at)
    topics_out = sensitive + [f"Launches: {b}" for b in briefed]
    risk_topics: list[str] = []  # routing sees every topic, even one that restates the tag or is non-US politics
    for rt in risk_tags:
        topic = col.topic(rt)
        if topic and topic.name not in risk_topics:
            risk_topics.append(topic.name)

    # -- KOF + engagement ----------------------------------------------------------
    kof_lists = _as_list(fields.get("kof_lists"))
    is_kof = fields.get("kof") is True or bool(kof_lists)
    if fields.get("kof") is False and kof_lists:
        derive("kof", True, f"author is on {', '.join(kof_lists)}")
    total = fields.get("total_engagement")
    if not isinstance(total, int):
        parts = [fields.get(k) for k in ("likes", "comments", "shares")]
        total = sum(p for p in parts if isinstance(p, int)) if any(isinstance(p, int) for p in parts) else None
    if total is None:
        warnings.append(Issue(field="total_engagement", rule="engagement_missing", severity=Severity.WARNING,
                              fix="Engagement is missing; treated as 0 for the 2K+ track."))
    engagement = total or 0

    # -- exclusions (sql/02 step 4) ------------------------------------------------
    risk_signal = bool(risk_tags) or (relevance is not None and relevance >= 1.0)
    excl: list[str] = []
    for rule in col.exclusions:
        if not rule.enabled:
            continue
        rid = rule.id
        if rid == "google_as_verb":
            hit = (not risk_signal and priority != "P0" and _rx(config, "google_verb", snippet)
                   and all(p.lower() in ("brand", "search", "google search", "google", "google (brand)") for p in products or ["brand"]))
        elif rid == "drive_link":
            hit = not risk_signal and _rx(config, "drive_link", snippet)
        elif rid == "spam":
            hit = not risk_signal and (_rx(config, "spam", snippet) or len(re.findall(r"https?://", snippet)) >= 4
                                       or len(re.findall(r"#\w+", snippet)) >= 12)
        elif rid == "ai_comparison":
            hit = (tag_name in col.generic_criticism_tags and not sensitive
                   and _rx(config, "comparison", text_all) and _rx(config, "ai_context", text_all))
        elif rid == "benchmark":
            hit = (priority != "P0" and _rx(config, "benchmark", issue_text)
                   and not [s for s in sensitive if s != "AI Personification"])
        else:
            hit = bool(rule.pattern and re.search(rule.pattern, snippet, re.IGNORECASE)) and not (rule.unless_risk_keywords and risk_signal)
        if hit:
            excl.append(f"EXCLUDED_{rid.upper()}")
    for hint in enr.exclusion_hints:
        code = f"EXCLUDED_{hint.upper()}"
        if code not in excl and any(r.id == hint for r in col.exclusions):
            warnings.append(Issue(field=None, rule=f"possible_exclusion:{hint}", severity=Severity.WARNING,
                                  source=IssueSource.LLM, fix=f"Gemini thinks this may be excluded ({hint.replace('_', ' ')})."))

    # -- tracks ----------------------------------------------------------------------
    def gate(minimum: float) -> bool:
        return relevance is None or relevance >= minimum

    urgent_reasons = [r for r, ok in (
        ("P0_TOPIC", priority == "P0" and gate(P0_MIN_RELEVANCE)),
        ("SENSITIVE_TOPIC", bool(sensitive) and gate(SENSITIVE_MIN_RELEVANCE)),
        ("BRIEFED_TOPIC", bool(briefed) and gate(BRIEFED_MIN_RELEVANCE)),
        ("KOF", is_kof and gate(KOF_MIN_RELEVANCE)),
    ) if ok]
    detect_ts = parse_datetime(extra.get("first_detected_at"), config.timezone) if extra.get("first_detected_at") else None
    fresh = detect_ts is None or (received_at - detect_ts) <= timedelta(hours=col.urgent_max_detect_age_hours)
    urgent_ok = bool(urgent_reasons) and not excl and fresh
    he_ok = engagement >= col.high_engagement_threshold and gate(HE_MIN_RELEVANCE) and not excl
    reason_codes = urgent_reasons + (["HIGH_ENGAGEMENT"] if engagement >= col.high_engagement_threshold else []) + excl

    # -- novelty (sql/02 step 6) -----------------------------------------------------
    tokens = issue_tokens(issue_name, col.issue_stopwords)
    fingerprint = " ".join(tokens)
    window_start = received_at - timedelta(days=col.novelty_days)
    related: Case | None = None
    for other in sorted(history, key=lambda c: c.clean_posted_at or c.created_at, reverse=True):
        alerted = other.clean_posted_at
        if not alerted or alerted < window_start or alerted > received_at:
            continue
        if (other.exposure_tag or "").lower() != (tag_name or "").lower():
            continue
        if same_issue(tokens, fingerprint, other, col.novelty_min_jaccard, col.issue_stopwords):
            related = other
            break
    stated = str(fields.get("issue_status") or "").strip().lower()
    if related:
        status = "ONGOING"
        if stated in NEW_STATUSES or not stated:
            derive("issue_status", ONGOING_FIELD_VALUE, f"alerted within {col.novelty_days} days ({related.case_id})", 0.95)
    elif history_complete or stated in NEW_STATUSES or not stated:
        status = "NEW"
        if stated not in NEW_STATUSES:
            derive("issue_status", NEW_FIELD_VALUE, f"no alert on this issue in the last {col.novelty_days} days", 0.9)
    else:
        status = "ONGOING"  # Burson says ongoing and our history can't disprove it yet

    # -- alertability ------------------------------------------------------------------
    track = "URGENT" if urgent_ok else ("HIGH_ENGAGEMENT" if he_ok else None)
    suppression: str | None = None
    if track is None:
        suppression = excl[0] if excl else ("stale_detection" if urgent_reasons and not fresh else "below_threshold")
    elif (track == "URGENT" and status == "ONGOING" and not is_kof and col.ongoing_urgent_requires_kof
          and not (tag and tag.always_alert)):
        if he_ok:
            track = "HIGH_ENGAGEMENT"  # 2K+ still alerts, as an update on the existing thread
        else:
            suppression = "ongoing_no_kof"

    # -- YouTube protocol ------------------------------------------------------------------
    yt_rx = lambda s: _rx(config, "youtube", s)  # noqa: E731
    yt_in_products = any(yt_rx(p.lower()) for p in products)
    yt_subject = ((yt_rx(issue_name or "") or yt_in_products) and not _rx(config, "google_products", issue_name or "")
                  and all(p.lower() in ("brand", "google (brand)") or yt_rx(p.lower()) for p in products)
                  and tag_name != "Employees - Executive criticism")
    yt_mentioned = yt_subject or yt_rx(re.sub(r"^\s*you ?tube (user|channel|creator)", "", summary.lower())) \
        or (str(fields.get("social_network") or "").lower() != "youtube" and yt_rx(snippet)) or yt_in_products
    yt_cfg = config.protocols.youtube
    yt_sensitive = bool(set(sensitive) & set(yt_cfg.sensitive_topics_for_low_engagement)) or tag_name in yt_cfg.sensitive_exposure_tags
    bias = (tag_name in col.bias_tags) or _rx(config, "censorship", issue_text) or bool(enr.bias_allegation)
    alert_action: str | None = None
    yt_protocol = "none"
    if suppression is None:
        if yt_cfg.enabled and yt_subject and (track == "HIGH_ENGAGEMENT" or is_kof):
            alert_action = "EMAIL_ALERT" if bias else "YOUTUBE_CHAT_ONLY"
            yt_protocol = "email_and_ping" if bias else "chat_only"
        elif yt_cfg.enabled and yt_subject:
            if yt_sensitive:
                alert_action, yt_protocol = "YOUTUBE_CHAT_ONLY", "sensitive_ping"
            else:
                suppression = "youtube_no_action"
        else:
            alert_action = "EMAIL_ALERT"
            yt_protocol = "email_and_ping" if (yt_cfg.enabled and yt_mentioned) else "none"
    alertable = suppression is None

    # -- Doodle / leadership / T&S --------------------------------------------------------
    doodle_cfg = config.protocols.doodle
    doodle = alertable and doodle_cfg.enabled and (
        any(p.lower() in (d.lower() for d in doodle_cfg.products) for p in products) or _rx(config, "doodle", text_all)
    )
    lead = config.protocols.leadership
    leadership = False
    if alertable and lead.enabled and alert_action == "EMAIL_ALERT" and (status == "NEW" or not lead.require_new_issue):
        severe = (priority in lead.priorities) or (lead.include_sensitive_topics and bool(topics_out))
        mistake = tag_name in (lead.product_failure_tags or col.product_mistake_tags) or tag_name in col.product_mistake_tags \
            or (lead.include_content_tags and (tag_name or "").startswith("Content - "))
        if severe and mistake:
            since = received_at - timedelta(days=lead.dedupe_days)
            already = any(
                c.leadership_pinged_at and c.leadership_pinged_at >= since and (
                    same_issue(tokens, fingerprint, c, col.novelty_min_jaccard, col.issue_stopwords)
                    or (not tokens and (c.exposure_tag or "").lower() == (tag_name or "").lower() and c.product == product)
                )
                for c in history
            )
            leadership = not already
    ts_reasons = []
    # "Viral KOF post showing a product issue": a KOF author alone isn't a T&S case (✍️ on ~3% of KOF/INF alerts)
    if is_kof and tag_name in col.hallucination_tags:
        ts_reasons.append("viral KOF")
    if "Child Safety" in sensitive:
        ts_reasons.append("child safety")
    if tag_name in col.hallucination_tags and (any("gemini" in p.lower() for p in products) or re.search(r"\bgemini\b", (issue_name or "").lower())):
        ts_reasons.append("Gemini hallucination")
    elif tag_name in col.hallucination_tags and any(
            (config.distribution.product(p).name if config.distribution.product(p) else p).strip().lower()
            in (x.strip().lower() for x in col.hallucination_products) for p in products):
        ts_reasons.append("AI hallucination")

    # -- manual inputs ----------------------------------------------------------------------
    markets: list[str] = []
    if location and location.lower() not in (u.lower() for u in col.politics_us_locations):
        markets.append(location)
    for m in enr.non_us_markets:
        if m and m.lower() not in (x.lower() for x in markets) and m.lower() not in (u.lower() for u in col.politics_us_locations):
            markets.append(m)
    if not location:
        for rl in config.distribution.regional_leads:
            terms = [rl.region, *[a for a in rl.aliases if len(a) > 2]]
            for term in terms:
                if re.search(rf"\b{re.escape(term)}\b", f"{issue_name or ''}\n{summary}", re.I):
                    if rl.region.lower() not in (x.lower() for x in markets):
                        markets.append(rl.region)
                    break
    if not location and not language.startswith("en"):
        markets.append(f"language:{language}")
    secondary = [p for p in dict.fromkeys(others + list(enr.secondary_products)) if p and p != product][:2]
    platform = str(fields.get("social_network") or "") or None
    tier = col.tier_for(platform)
    sla_minutes = tier.sla_minutes if tier else None
    timestamp = fields.get("video_timestamp") or enr.video_timestamp
    long_video = bool(platform) and platform.lower() in (p.lower() for p in col.long_video_platforms)

    # -- derived display fields ----------------------------------------------------------------
    level = col.level_for(total, is_kof)
    if level and fields.get("engagement_level") != level:
        derive("engagement_level", level, f"{engagement:,} engagements" + (" from a KOF" if is_kof else ""))
    if alertable and track:
        if extra.get("burson_name_format"):
            expected_suffix = (
                "Ongoing Issue"
                if status == "ONGOING"
                else (extra.get("burson_status_suffix") or "New / not previously reported over the past 14 days")
            )
            if status == "NEW" and "ongoing" in str(expected_suffix).lower():
                expected_suffix = "New / not previously reported over the past 14 days"
            expected_name = f"{issue_name or tag_name or 'Alert'} / {expected_suffix}"
            if str(fields.get("alert_name") or "").strip() != expected_name.strip():
                derive("alert_name", expected_name, f"status: {status}")
        else:
            tags = ("[YOUTUBE CHAT] " if alert_action == "YOUTUBE_CHAT_ONLY" else "") + \
                f"[{'URGENT' if track == 'URGENT' else 'HIGH ENGAGEMENT'}] [{status}]"
            name = str(fields.get("alert_name") or "")
            current = (_PREFIX_RE.match(name).group(0) if _PREFIX_RE.match(name) else "")
            rest = _PREFIX_RE.sub("", name).strip()
            norm = lambda s: re.sub(r"\s+", "", s.upper())  # noqa: E731
            reasons = []
            if norm(current) != norm(tags):
                reasons.append(f"track/status: {track.replace('_', ' ')} · {status}")
            for dash in (" – ", " — ", " - "):
                if product and dash in rest:
                    named, issue_part = rest.split(dash, 1)
                    named_distro = config.distribution.product(named.strip())
                    if named.strip().lower() != product.lower() and (named_distro is None or named_distro.name != product):
                        if named_distro is not None or named.strip().lower() == str(fields_in.get("product") or "").lower():
                            rest = f"{product} – {issue_part.strip()}"
                            reasons.append(f"product: {named.strip()} → {product}")
                    break
            if not name:
                derive("alert_name", f"{tags} {product or 'Google'} – {issue_name or tag_name or 'alert'}", "built from the alert fields")
            elif reasons:
                derive("alert_name", f"{tags} {rest}", "; ".join(reasons))

    # -- conflicts worth a human look -------------------------------------------------------------
    if flags.get("meets_p0") and priority != "P0" and track != "URGENT":
        review.append(f"Burson marked 'meets P0 criteria' but the exposure tag is {priority or 'unknown'}")

    a = AlertAssessment(
        track=track if alertable else None, alert_action=alert_action, reason_codes=reason_codes,
        issue_status=status, issue_name=issue_name, issue_fingerprint=fingerprint or None,
        related_case_id=related.case_id if related else None, priority=priority, exposure_tag=tag_name,
        product=product, sensitive_topics=topics_out, briefed_topics=briefed, risk_topics=risk_topics, is_kof=is_kof, kof_lists=kof_lists,
        engagement_total=total, engagement_level=level, platform=platform, platform_tier=tier.name if tier else None,
        sla_minutes=sla_minutes if alertable else None,
        sla_due_at=(received_at + timedelta(minutes=sla_minutes)) if (alertable and sla_minutes) else None,
        alertable=alertable, suppression_reason=suppression,
        sundar_mention=_rx(config, "sundar", text_all) or enr.sundar_mention, non_us_markets=markets,
        secondary_products=secondary, owned_post=tag_name == "Content - Negative reaction to owned social post" or enr.owned_post,
        owned_profile_url=enr.owned_profile_url, video_timestamp=str(timestamp) if timestamp else None,
        video_timestamp_needed=long_video and not timestamp,
        youtube_subject=yt_subject, youtube_protocol=yt_protocol, bias_allegation=bias,
        doodle_protocol=doodle, leadership_protocol=leadership,
        ts_recommended=bool(ts_reasons) and alertable, ts_reasons=ts_reasons,
    )
    if alertable:
        text_for_routing = f"{text_all}\n{issue_text}"
        a.recipients = plan_recipients(config, a, text_for_routing)
        a.suggested_actions = suggest_actions(config, a, text_for_routing)
    if a.video_timestamp_needed:
        warnings.append(Issue(field="video_timestamp", rule="video_needs_timestamp", severity=Severity.WARNING,
                              fix="Long video: add the timestamp of the Google mention."))
    if a.owned_post and not a.owned_profile_url:
        warnings.append(Issue(field=None, rule="owned_profile_url_needed", severity=Severity.WARNING,
                              fix="Owned-post reaction: add the Google profile URL."))
    return RequirementsResult(assessment=a, fields=fields, corrections=corrections, warnings=warnings, review_reasons=review)
