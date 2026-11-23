"""Agent configuration schema + loader.

Effective config = config/default_config.yaml (+ config/distribution.yaml merged
under `distribution`) deep-merged with the latest overrides saved by the Agent
Console (Store.get_config_overrides()). Every event records `config_version`.
"""

import copy
import hashlib
import json
import logging
import os
from pathlib import Path
from typing import Any, Literal

import yaml
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from .models import Roster, Severity

log = logging.getLogger(__name__)

CONFIG_DIR = Path(__file__).resolve().parent.parent / "config"
DEFAULT_CONFIG_PATH = CONFIG_DIR / "default_config.yaml"
DISTRIBUTION_PATH = CONFIG_DIR / "distribution.yaml"

FieldType = Literal[
    "string", "text", "url", "datetime", "date", "integer", "number", "enum", "boolean", "list"
]


class ConfigModel(BaseModel):
    """Base of every config model below: a key the model doesn't know is an error, never dropped silently.

    pydantic's default (extra="ignore") threw such keys away, so a misspelled setting, or an unquoted comma inside a
    YAML flow mapping (`{id: x, instruction: accurately, descriptively}` gives instruction "accurately" plus a stray
    key "descriptively"), quietly did nothing and the Generated.gs build went on without it. Now load_config, the
    build (scripts/build_apps_script.py) and the tests fail and name the key. Console and chat edits already refused
    unknown keys before saving them."""

    model_config = ConfigDict(extra="forbid")


# ---------------------------------------------------------------------------
# Alert template (how to read + validate an incoming alert message)
# ---------------------------------------------------------------------------


class FieldSpec(ConfigModel):
    name: str  # canonical field name used everywhere else
    labels: list[str]  # labels/aliases as they appear in the message ("Post URL", "View Post")
    type: FieldType = "string"
    required: bool = False
    allowed: list[str] | None = None  # enum values (case-insensitive match, normalized to this casing)
    # key into AgentConfig.reference_lists, or one of the built-ins:
    # "exposure_tags" | "sensitive_topics" | "products" (distribution)
    reference_list: str | None = None
    pattern: str | None = None  # Python regex the (string) value must fully match
    min: float | None = None
    max: float | None = None
    min_length: int | None = None
    max_length: int | None = None
    not_in_future: bool = False  # datetime/date
    max_age_days: int | None = None  # datetime/date
    correctable: bool = False  # the agent may auto-correct this field (vs. bounce to Burson)
    numeric_fallback: str | None = None  # a numeric value under this label belongs to that field ("Engagement: 1.2K")
    description: str = ""  # shown in the Console and given to Gemini
    fix_hint: str | None = None  # appended to the issue's fix text


class CrossFieldRule(ConfigModel):
    """Deterministic rule across fields.

    kind:
      - "require_if": when all `when` field/value pairs match, `require` fields must be present
      - "sum_equals": `target` must equal the sum of `fields` (tolerance allowed)
      - "url_domain_matches": the domain of `url_field` must be in reference_lists[`domain_map`][value of `key_field`]
    """

    id: str
    kind: Literal["require_if", "sum_equals", "url_domain_matches"]
    description: str = ""
    when: dict[str, Any] = Field(default_factory=dict)
    require: list[str] = Field(default_factory=list)
    target: str | None = None
    fields: list[str] = Field(default_factory=list)
    tolerance: float = 0
    url_field: str | None = None
    key_field: str | None = None
    domain_map: str | None = None
    severity: Severity = Severity.BLOCKING
    fix: str = ""


class LLMCheck(ConfigModel):
    id: str
    instruction: str  # what Gemini must verify
    fields: list[str]  # fields given to Gemini for this check
    severity: Severity = Severity.BLOCKING
    correctable_field: str | None = None  # Gemini may propose a corrected value for this field
    enabled: bool = True


class DetectionRule(ConfigModel):
    """How to recognize an alert message vs. a normal human chat message."""

    sender_names: list[str] = Field(default_factory=lambda: ["Zapier"])
    sender_emails: list[str] = Field(default_factory=list)
    text_regex: str | None = None
    min_labels_matched: int = 3


class AlertTemplate(ConfigModel):
    id: str = "burson_sonar_alert_v1"
    name: str = "Burson Sonar alert"
    is_placeholder: bool = True  # flip to False once real samples are wired in
    detection: DetectionRule = Field(default_factory=DetectionRule)
    separator: str = ":"
    fields: list[FieldSpec] = Field(default_factory=list)
    record_key_fields: list[str] = Field(default_factory=list)
    cross_field_rules: list[CrossFieldRule] = Field(default_factory=list)
    llm_checks: list[LLMCheck] = Field(default_factory=list)
    clean_post_fields: list[str] = Field(default_factory=list)  # order for the clean-space post
    # Free-text flags detected anywhere in the message, e.g. {"meets_p0": "(?i)this alert meets p0 criteria"}
    flag_patterns: dict[str, str] = Field(default_factory=dict)

    def field(self, name: str) -> FieldSpec | None:
        return next((f for f in self.fields if f.name == name), None)


def _lookup(items: list, name: str | None):
    """Case-insensitive lookup by exact `name`, then by `aliases` (exact names win)."""
    if not name:
        return None
    key = name.strip().lower()
    for item in items:
        if item.name.lower() == key:
            return item
    for item in items:
        if key in (a.lower() for a in item.aliases):
            return item
    return None


# ---------------------------------------------------------------------------
# SLRR Collection Requirements (March 5, 2026). The rule knobs mirror
# brand_safety_alerting/sql/02_brand_safety_alerts.sql so Path A (QA of Burson
# alerts) and Path B (in-house alerts) agree.
# ---------------------------------------------------------------------------


class ExposureTag(ConfigModel):
    name: str
    priority: Literal["P0", "P1", "P2"]
    category: Literal["Brand", "Content", "Employees", "Product"] | None = None
    description: str = ""
    aliases: list[str] = Field(default_factory=list)  # merged / renamed tags
    customer_support: bool = False  # gUP-type issue (adds gUP POCs)
    always_alert: bool = False  # e.g. "All Content Response issues, regardless of novelty"
    notes: str = ""


class SensitiveTopic(ConfigModel):
    name: str
    description: str = ""
    aliases: list[str] = Field(default_factory=list)  # Sonar risk-tag names
    notes: str = ""


class EngagementLevel(ConfigModel):
    name: str  # VERY LOW | LOW | MODERATE | HIGH
    emoji: str = ""
    min: int  # inclusive lower bound (likes + comments + shares)


class PlatformTier(ConfigModel):
    name: Literal["strong", "partial", "limited"]
    platforms: list[str]
    sla_minutes: int | None = None  # None = no SLA


class ExclusionRule(ConfigModel):
    """Exclusion from the Collection Requirements. Known ids have SQL-equivalent logic in
    triage_agent.qa.requirements; unknown ids with a `pattern` are generic regex exclusions."""

    id: str  # google_as_verb | drive_link | spam | ai_comparison | benchmark | <custom>
    description: str
    pattern: str | None = None  # regex over post text (case-insensitive)
    unless_risk_keywords: bool = True  # skip the exclusion when a risk signal is present
    enabled: bool = True


class RedundantPair(ConfigModel):
    """A risk tag that merely restates the exposure tag (doesn't make the post Sensitive)."""

    exposure_tag: str
    risk_tag: str


class BriefedTopic(ConfigModel):
    """Briefed launch / initiative treated as a Sensitive Topic (escalates at 0 engagement)."""

    label: str
    product_regex: str | None = None
    text_regex: str | None = None
    starts_at: str | None = None  # ISO date/datetime; None = open
    ends_at: str | None = None
    active: bool = True


class CollectionRequirements(ConfigModel):
    version: str = "2026-03-05"
    language: str = "en"
    high_engagement_threshold: int = 2000
    novelty_days: int = 14  # alerted within N days => Ongoing
    novelty_min_jaccard: float = 0.6  # issue-name token similarity for "same issue"
    urgent_max_detect_age_hours: int = 24
    ongoing_urgent_requires_kof: bool = True  # Ongoing URGENT alerts suppressed unless KOF
    remap_suspension_bias: bool = True  # Account deletion/suspension + censorship claim -> Product - Perceived bias
    viral_kof_label: str = "VIRAL KOF"
    politics_us_locations: list[str] = Field(default_factory=lambda: ["US", "USA", "United States"])
    exposure_tags: list[ExposureTag] = Field(default_factory=list)
    sensitive_topics: list[SensitiveTopic] = Field(default_factory=list)
    redundant_pairs: list[RedundantPair] = Field(default_factory=list)
    briefed_topics: list[BriefedTopic] = Field(default_factory=list)
    engagement_levels: list[EngagementLevel] = Field(default_factory=list)
    platform_tiers: list[PlatformTier] = Field(default_factory=list)
    exclusions: list[ExclusionRule] = Field(default_factory=list)
    hallucination_tags: list[str] = Field(default_factory=list)  # Gemini + these => T&S
    hallucination_products: list[str] = Field(default_factory=list)  # other AI/Search products + these => T&S
    product_mistake_tags: list[str] = Field(default_factory=list)  # leadership protocol context
    bias_tags: list[str] = Field(default_factory=list)
    generic_criticism_tags: list[str] = Field(default_factory=list)
    long_video_platforms: list[str] = Field(default_factory=list)
    issue_stopwords: list[str] = Field(default_factory=list)
    # Named regexes (case-insensitive): google_verb, drive_link, spam, comparison, ai_context,
    # benchmark, censorship, election, youtube, google_products, doodle, sundar, exec, leak
    patterns: dict[str, str] = Field(default_factory=dict)
    do_not_escalate: list[str] = Field(default_factory=list)  # judgment rules given to Gemini

    def tag(self, name: str | None) -> ExposureTag | None:
        return _lookup(self.exposure_tags, name)

    def topic(self, name: str | None) -> SensitiveTopic | None:
        return _lookup(self.sensitive_topics, name)

    def tier_for(self, platform: str | None) -> PlatformTier | None:
        if not platform:
            return None
        key = platform.strip().lower()
        if key in ("x (twitter)", "twitter"):
            key = "x"
        return next((t for t in self.platform_tiers if key in (p.lower() for p in t.platforms)), None)

    def level_for(self, engagement: int | None, is_kof: bool = False) -> str | None:
        """Engagement level label (KOF authors are always the viral-KOF level, like the SQL)."""
        if is_kof:
            return self.viral_kof_label
        if engagement is None:
            return None
        levels = sorted(self.engagement_levels, key=lambda lv: lv.min)
        name = None
        for lv in levels:
            if engagement >= lv.min:
                name = lv.name
        return name

    def is_redundant(self, exposure_tag: str | None, risk_tag: str) -> bool:
        return any(
            p.exposure_tag.lower() == (exposure_tag or "").lower() and p.risk_tag.lower() == risk_tag.lower()
            for p in self.redundant_pairs
        )


# ---------------------------------------------------------------------------
# Distribution (product + non-product alert POCs)
# ---------------------------------------------------------------------------


class ConditionalRecipients(ConfigModel):
    label: str  # e.g. "High-engaging posts (2K+)"
    min_engagement: int
    recipients: list[str]


class ProductDistro(ConfigModel):
    name: str
    group_name: str | None = None  # exact row title in the Brand safety groups worksheet when different from name
    aliases: list[str] = Field(default_factory=list)  # product names as they appear in alerts
    pa: list[str] = Field(default_factory=list)  # Marketing & Comms alert POCs (📦)
    gup: list[str] = Field(default_factory=list)  # gUP (social customer support) POCs (💬)
    conditional: list[ConditionalRecipients] = Field(default_factory=list)
    execs: list[str] = Field(default_factory=list)  # e.g. Gemini App "Execs"
    # When execs are added: "suggest" (never auto-added; the IM is told), "always", "p0",
    # "high_engagement" (>= collection.high_engagement_threshold), "p0_or_high_engagement"
    execs_rule: Literal["suggest", "always", "p0", "high_engagement", "p0_or_high_engagement"] = "suggest"
    deprecated: bool = False
    redirect_to: list[str] = Field(default_factory=list)  # deprecated -> reclassify to one of these
    notes: str = ""


class GroupTrigger(ConfigModel):
    exposure_tags: list[str] = Field(default_factory=list)
    exposure_tag_prefixes: list[str] = Field(default_factory=list)  # e.g. "Brand - ", "Employees - "
    priorities: list[str] = Field(default_factory=list)  # e.g. ["P0"]
    sensitive_topics: list[str] = Field(default_factory=list)
    # True: a Sensitive Topic only matches when it's why the alert is urgent (a KOF author, or under the high-engagement
    # threshold); topics in sensitive_topics_any_engagement match at any engagement
    sensitive_topics_urgent_only: bool = False
    sensitive_topics_any_engagement: list[str] = Field(default_factory=list)
    keywords: list[str] = Field(default_factory=list)  # regexes over post text + issue name + summary
    sundar_mention: bool = False
    non_us_market: bool = False
    owned_post: bool = False
    exclude_products: list[str] = Field(default_factory=list)  # never matches alerts about these products
    match: Literal["any", "all"] = "any"  # "all": every non-empty condition must hold

    def is_empty(self) -> bool:
        return not (
            self.exposure_tags or self.exposure_tag_prefixes or self.priorities or self.sensitive_topics
            or self.keywords or self.sundar_mention or self.non_us_market or self.owned_post
        )


class NonProductGroup(ConfigModel):
    name: str
    action_code: str | None = None  # emoji-legend action that adds this group (e.g. "civics")
    recipients: list[str] = Field(default_factory=list)
    auto_include: bool = False  # include automatically when a trigger matches (else suggest only)
    triggers: GroupTrigger = Field(default_factory=GroupTrigger)
    is_placeholder: bool = False
    notes: str = ""


class RegionalLeadEntry(ConfigModel):
    region: str
    aliases: list[str] = Field(default_factory=list)
    parent_region: str | None = None
    recipients: list[str] = Field(default_factory=list)
    reputational_risk_recipients: list[str] = Field(default_factory=list)
    names: str = ""
    advanced_notice: list[str] = Field(default_factory=list)


class ChannelOwnerEntry(ConfigModel):
    account_url: str = ""
    handle: str = ""
    owners: list[str] = Field(default_factory=list)
    region: str = ""
    account_name: str = ""
    platform: str = ""
    team_brand: str = ""
    language: str = ""
    owner_in_marketing: bool = False


class Distribution(ConfigModel):
    version: str = "2026-03"
    products: list[ProductDistro] = Field(default_factory=list)
    groups: list[NonProductGroup] = Field(default_factory=list)
    regional_leads: list[RegionalLeadEntry] = Field(default_factory=list)
    channel_owners: list[ChannelOwnerEntry] = Field(default_factory=list)
    fallback_product: str = "Brand"

    def product(self, name: str | None) -> ProductDistro | None:
        """Exact name first (so deprecated entries like "Gems" are found), then aliases."""
        return _lookup(self.products, name)

    def group(self, name_or_code: str) -> NonProductGroup | None:
        key = name_or_code.strip().lower()
        return next((g for g in self.groups if g.name.lower() == key or (g.action_code or "").lower() == key), None)


# ---------------------------------------------------------------------------
# Protocols, IM actions (emoji legend), email + T&S settings
# ---------------------------------------------------------------------------


class YouTubeProtocol(ConfigModel):
    enabled: bool = True
    space_target: str = "youtube"  # OutboxTarget for [S-F] YouTube Social
    high_engagement_threshold: int = 2000
    sensitive_topics_for_low_engagement: list[str] = Field(
        default_factory=lambda: ["Child Safety", "Violence / Weapons", "Hate Speech"]
    )
    sensitive_exposure_tags: list[str] = Field(
        default_factory=lambda: [
            "Employees - Physical safety of Googlers or campuses",
            "Employees - Hate speech toward or criticism of Googlers",
        ]
    )
    notes: str = ""


class DoodleProtocol(ConfigModel):
    enabled: bool = True
    space_target: str = "doodle"
    products: list[str] = Field(default_factory=lambda: ["Doodles", "Easter Eggs and Delight Features"])
    message: str = "Hey Doodle team, sharing the below alert for visibility."


class LeadershipProtocol(ConfigModel):
    """[Internal] SLRR P0 + Sensitive Topics + Product Failure Escalation Protocol."""

    enabled: bool = True
    recipients: list[str] = Field(default_factory=list)  # Kelsey / Angie / Jon
    require_new_issue: bool = True
    priorities: list[str] = Field(default_factory=lambda: ["P0"])
    include_sensitive_topics: bool = True
    product_failure_tags: list[str] = Field(default_factory=list)
    include_content_tags: bool = True  # "Content - …" tags count as Google mistakes
    dedupe_days: int = 14  # "if a topic has already been pinged, no need to ping again"
    doc_url: str | None = None


class Protocols(ConfigModel):
    youtube: YouTubeProtocol = Field(default_factory=YouTubeProtocol)
    doodle: DoodleProtocol = Field(default_factory=DoodleProtocol)
    leadership: LeadershipProtocol = Field(default_factory=LeadershipProtocol)


ActionKind = Literal[
    "ack", "email_pa", "tns", "add_group", "post_space", "dm", "close", "superseded", "feedback", "none"
]


class ActionDef(ConfigModel):
    """One entry of the IM emoji legend and what the agent does when the IM reacts with it."""

    emoji: str
    code: str  # stable id used in events/metrics
    label: str  # legend text, e.g. "Reported to Trust & Safety (T&S)"
    kind: ActionKind
    group: str | None = None  # add_group: Distribution group name/action_code
    target: str | None = None  # post_space: OutboxTarget
    recipients: list[str] = Field(default_factory=list)  # dm recipients


class EmailTemplate(ConfigModel):
    id: str
    name: str
    when: str  # plain-language selection guidance for Gemini
    subject: str  # format string
    body_guidance: str
    to: list[str] = Field(default_factory=list)
    cc: list[str] = Field(default_factory=list)


class EscalationConfig(ConfigModel):
    from_name: str = "Brand Social"
    from_email: str = ""
    auto_draft_tracks: list[str] = Field(default_factory=lambda: ["URGENT"])  # draft 📦 before the IM reacts
    subject_format: str = "{alert_name}"
    reply_subject_prefix: str = "Re: "
    signature: str = "Brand Social"
    email_templates: list[EmailTemplate] = Field(default_factory=list)
    default_to: list[str] = Field(default_factory=list)  # used only if no product distro matches
    default_cc: list[str] = Field(default_factory=list)
    brand_social_updates_cc: list[str] = Field(default_factory=list)
    recipients_in: Literal["to", "bcc"] = "to"  # where distro recipients go (confirm with a sample email)
    # Testing: while set, every Social Alert email and escalation-protocol DM goes only to this address (Apps Script bot)
    stand_in: str = ""
    max_body_chars: int = 12000

    @property
    def from_header(self) -> str:
        return f"{self.from_name} <{self.from_email}>" if self.from_email else self.from_name


class TnsCriterion(ConfigModel):
    id: str
    description: str
    category: str | None = None


class TnsField(ConfigModel):
    entry_id: str  # Google Forms pre-fill parameter, e.g. "entry.1234567890"
    label: str
    type: Literal[
        "short_text", "paragraph", "multiple_choice", "checkboxes", "dropdown", "date", "time"
    ] = "short_text"
    # How to fill: "field:<alert field>" | "const:<text>" | "llm" | "analyst_email" | "case_id" | "escalation_id"
    source: str = "llm"
    options: list[str] = Field(default_factory=list)  # exact option text for choice questions
    required: bool = False
    max_len: int | None = None


class TnsConfig(ConfigModel):
    form_url: str = ""  # go/WD-Triage .../forms/d/e/<id>/viewform
    is_placeholder: bool = True  # entry ids not yet discovered (Phase 0)
    urgent_alias: str = ""
    urgent_when: list[str] = Field(default_factory=lambda: ["viral_kof", "high_engagement", "child_safety"])
    submitter_team_option: str = "Marketing"  # "Make sure to select 'Marketing' … so we get credit"
    criteria_doc_url: str | None = None
    evidence_required: bool = True  # evidence of input (screenshot with query) or replicability
    criteria: list[TnsCriterion] = Field(default_factory=list)
    categories: list[str] = Field(default_factory=list)
    fields: list[TnsField] = Field(default_factory=list)
    max_url_length: int = 7000
    # The description field carries this reference so the WD intake email can be matched back.
    reference_format: str = "[SLRR {escalation_id} / {case_id}]"
    # Email parsing for the WD intake loop
    intake_subject_regex: str = r"Issue\s*\[?#?(?P<issue>\d{6,})\]?\s*:\s*WD Intake Request"
    outcome_regex: str = r"\b(?P<outcome>Fixed|Infeasible)\b"
    bug_id_regex: str = r"(?:\bb/|go/bad/|\bbug\s*(?:id)?[:#\s]*)(?P<bug>\d{6,})\b"


class WatchdogConfig(ConfigModel):
    """'Watchdog Anti-Abuse Alert' emails from T&S -> create an alert if none exists."""

    enabled: bool = True
    subject_regex: str = r"Watchdog Anti-Abuse Alert"
    skip_subject_regexes: list[str] = Field(default_factory=lambda: [r"Early Warning"])
    skip_content: list[str] = Field(default_factory=lambda: ["jailbreak", "NSFW generated image"])


class CorrectionPolicy(ConfigModel):
    mode: Literal["auto", "propose"] = "auto"  # auto-apply high-confidence corrections (IM can revert)
    auto_apply_min_confidence: float = 0.85
    never_auto_correct: list[str] = Field(default_factory=lambda: ["post_url"])  # bounce to Burson instead


class BursonFeedback(ConfigModel):
    mode: Literal["digest", "realtime", "off"] = "digest"
    digest_hour_local: int = 9
    recipients: list[str] = Field(default_factory=list)  # Burson leads (mentioned in the digest)
    post_digest_to_burson_space: bool = True
    silent_in_burson_space: bool = False  # True = never emit burson_text; route bounces/digests to clean_text instead


class BursonResource(ConfigModel):
    """A document the V1 bot may link when Burson asks about the alert requirements (must be one Burson can open)."""

    name: str
    url: str
    covers: str = ""  # what it covers, so Gemini links the right one


class BursonQAConfig(ConfigModel):
    """V1 Burson QA bot settings, consumed by the Apps Script bot in apps-script-chat-bot/ (regenerate its
    Generated.gs with `python -m scripts.build_apps_script`). The bot polls the Burson space, reviews every Zapier
    alert, asks Burson in the alert's thread to fix mistakes, answers their questions, and silently forwards every
    alert (already corrected) to the analyst space. Bot ON/OFF and the two spaces are set on the Control tab of the
    bot's Google Sheet, so they can be changed without a rebuild."""

    react: bool = True  # emoji legend on Burson's posts: 👍 (ack) once reviewed, ⬇️ (superseded) when the fix is posted below
    mirror_analyst_reactions: bool = True  # legend emojis analysts add on the forwarded copy also go on Burson's post
    never_mirror: list[str] = Field(default_factory=lambda: ["agent_wrong"])  # legend codes never shown to Burson
    corrections_footer: bool = True  # analysts see one line listing what the bot corrected
    dry_run: bool = False  # True: nothing posted/reacted in the Burson space; "would reply" notes go under the forward
    llm_min_confidence: float = 0.9  # Gemini suggestions below this become "double-check" notes for analysts only
    # Gemini checks that may become fix requests: blocking = exposure tag, product, Sensitive Topics; warning = KOF,
    # issue name, summary wording. Anything below llm_min_confidence is a "double-check" note for analysts instead.
    llm_fix_severities: list[str] = Field(default_factory=lambda: ["blocking", "warning"])
    # The Apps Script bot's Auto-correct space (B10) only: Gemini's value is applied from this confidence (the agentic
    # assistant decides instead of leaving a double-check; below it Burson's value stays), never on the summary or on a
    # field the rules already corrected
    autocorrect_min_confidence: float = 0.6
    # The Apps Script bot's Auto-correct space (B10) only: the review call also writes the alert's summary paragraph
    # (its web background only when the call came back with web sources), for the corrected alert, its thread note and
    # the Social Alert email
    autocorrect_writeup: bool = True
    check_issue_status: bool = True  # "New" when the same issue was already alerted in the last 14 days -> fix request
    pending_fix_hours: int = 48  # an alert for the same post within this window of a fix request is Burson's fix
    start_lookback_minutes: int = 15  # a new Burson space (first run or after a switch) is read from N minutes back
    overlap_minutes: int = 5  # each run re-reads this much before the cursor (late or clock-skewed messages)
    max_messages_per_run: int = 100
    max_attempts: int = 3  # a message that keeps failing is forwarded unreviewed after N attempts, never dropped
    # Corrected for analysts but never requested from Burson (derived from other fields, or internal):
    silent_fields: list[str] = Field(default_factory=lambda: ["alert_name", "ts", "code"])
    # Web search for the alert review and analyst answers (Gemini.gs): "enterprise" = Vertex AI Web Grounding for
    # Enterprise, "google" = Grounding with Google Search, "off". Answers to Burson never search.
    web_grounding: Literal["enterprise", "google", "off"] = "enterprise"
    # Look back at earlier alerts before escalating: the same post alerted again, or the same author following up on an
    # alert that already went out (a reply on their own post, a thread). Nothing new -> no second Social Alert (❌);
    # something new -> an update on the earlier email's thread.
    follow_ups: bool = True
    follow_up_min_confidence: float = 0.8  # Gemini's "adds nothing new" must be at least this sure
    # Look up the post itself before the review (Post.gs): X and Bluesky (text, the thread it's in, what it quotes, its
    # video and photos), TikTok (caption and cover image), YouTube (Gemini watches it directly). Gemini watches and
    # listens to the whole video; a reply under (or quote of) an alerted post is a follow-up for certain.
    post_lookup: bool = True
    # Cloud Storage bucket for videos too big for Vertex AI to read from their link (over 15 MB, up to 50 MB): copied
    # under burson-qa-bot/staging/ for the review, then deleted. "" = never copy (Gemini gets a frame instead).
    media_bucket: str = "brand-social-central-data-slrr-automations"
    # Gemini may ❌ an alert escalated only because the author is a KOF when it's at least llm_min_confidence sure
    # and one of its no-alert checks holds and is backed up (an earlier alert that went out, or the leads' guidance).
    kof_no_alert: bool = True
    # Gemini's own reading alone (a knowledge base document says so, the alert is a mistake, or nothing actionable) may
    # also ❌ a KOF alert. Off: it names a document on almost every review (125 of 127), and on 24 KOF alerts from
    # May-June it called 15 a mistake or not actionable (90%+ sure) and the IMs had sent 8 of those 15.
    kof_no_alert_judgment: bool = False
    # Gemini also reads the SLRR leads' (protocols.leadership.recipients) recent emails about alerts as guidance
    guidance_from_email: bool = True
    guidance_email_days: int = 7
    # The Speed tab of the bot's sheet (Speed.gs): how fast the bot sent each Social Alert compared with the IMs, matched
    # on the post's link. IM drafts come from the SLRR Assistant's log (speed_im_table), IM emails from the mailbox the bot
    # runs as (from speed_im_sender; speed_gmail), and the IMs' call is backed by the SLRR alert log (speed_log_table).
    speed_tab: bool = True
    speed_days: int = 7
    speed_im_table: str = "brand-social-central-data.slrr_feedback.alert_sends"
    speed_log_table: str = "brand-social-central-data.slrr_alerts.slrr_alerts"
    speed_im_sender: str = ""
    speed_gmail: bool = True
    # Rollback settings: each guards one behaviour of the Apps Script bot, so that behaviour can be turned off here (then
    # a rebuild and a clasp push) without reverting code. A true/false one is read as `settings.<name> !== false`; a
    # number set to 0 keeps the rule the bot had before. Outside the Auto-correct flow none of them changes what the bot
    # posts, queues or emails.
    # The one-space setup (the Auto-correct space working alone): the Early Detection check and its reviews run before
    # the Direct BigQuery poll. false: the poll runs first, as before.
    early_detection_first: bool = True
    # The Auto-correct flow: ordinary story signals queued for review in a clock hour (Eastern). 0: the old rule (40
    # queued a day, whatever they are).
    early_wave_reviews_per_hour: int = 6
    # ...and story signals queued a day at most (used only while early_wave_reviews_per_hour is above 0). 0: the old
    # rule too, as with early_wave_reviews_per_hour at 0.
    early_wave_reviews_per_day: int = 150
    # The Auto-correct flow: a pace jump on a whole topic under this multiple of its usual count is noted, not reviewed.
    # 0: every topic count is queued and reviewed, as before.
    early_wave_topic_min_ratio: float = 3
    # The "Early Detection" tab (every story signal and what happened to it). false: no tab is made or written.
    early_detection_tab: bool = True
    # The Auto-correct flow: a note under another alert's card when two alert types meet on one post or story (story,
    # watch and Direct BigQuery notes; the watch's "Same story" reply goes under its alert's card as such a note), and a
    # bigger post (2,000+ engagements) on an issue already alerted gets its own card. false: as before: no such notes,
    # the same-story reply goes in the thread as it used to, a post or story already covered is skipped and counted,
    # and no extra card for a bigger post.
    cross_alert_notes: bool = True
    # The Auto-correct flow: the "Alert requirements" line in the note that follows each review, and the BSIP card's
    # [KOF] line from the feed's influencer list ("Yes (<list>)"), which can start a Social Alert at any size; while it
    # is on, an "Alert requirements: ...?" question asked under a card from the account the bot runs as is not taken for
    # one of the bot's notes. false: as before: no such line, the BSIP card's [KOF] line says No.
    requirement_line: bool = True
    # New sources in Early Detection (Control rows 48-49, OFF until the owner turns them on): how their posts share the
    # check with today's sources. None of these does anything while those rows are OFF.
    # Of the 400 texts embedded a check, the new sources' share (today's sources keep the rest; room one side leaves
    # goes to the other).
    early_wave_new_embed_per_check: int = 100
    # The new sources' texts embedded a UTC day at most (they also stop once the day's total nears its pace).
    early_wave_new_embed_per_day: int = 5000
    # A new source's post first seen more than this many minutes after it was posted can only join a story.
    early_wave_new_late_minutes: int = 180
    # Of the 1,200 unjoined posts kept to start stories, at most this many from the new sources, each kept this many
    # minutes at most.
    early_wave_new_pool_max: int = 300
    early_wave_new_pool_minutes: int = 120
    # The new sources' posts not embedded in a check, kept for the next one (2 hours at most).
    early_wave_new_carry_max: int = 100
    # Days after a source is first read when stories only the new sources lift over the bar are listed, not sent
    # for review, and stories only they lift to the early watch are not asked about. 0 (the default): no trial (sent
    # from the first day, within the two caps below).
    early_wave_new_trial_days: int = 0
    # After the trial (with no trial, from the first day): such lifted stories sent for review in an hour, and in a day, at most (the rest are listed).
    early_wave_new_lifted_per_hour: int = 2
    early_wave_new_lifted_per_day: int = 20
    # The AMIE table in Early Detection (Control row 48, OFF until the owner turns it on). None of these does anything
    # while row 48 is OFF. New rows read a check at most; how many minutes each read starts before the newest row it
    # last took (rows that land late); the gigabytes one read may scan (a dry run checks it each day); the hours with no
    # new row after which the row's note says so; and the alert feeds of Google's staff and KOFs, left out (a regular
    # expression on the feed's name).
    amie_rows_per_check: int = 300
    amie_overlap_minutes: int = 60
    amie_max_gb: float = 1
    amie_stale_hours: float = 3
    amie_staff_feeds_rx: str = r"kof|kol|\binfs?\b|exec|googler|reps|posts by google"
    # Brandwatch read live for Early Detection (Control row 49, OFF until the owner turns it on): new mentions, never X,
    # from the queries ticked on the New sources tab. None of these does anything while row 49 is OFF. The project read;
    # the sources asked for (X and LinkedIn are refused in code whatever this says); ticked queries read at most; mentions
    # a page and handed over a read; the least minutes between reads; how far back the first read goes; this reader's
    # own calls in 10 minutes; the shared login's calls used at which it pauses; and new mentions only.
    bw_live_project_id: int = 1998344909
    bw_live_sources: list[str] = Field(default_factory=lambda: [
        "reddit", "bluesky", "facebook", "facebook_public", "instagram", "instagram_public", "tiktok", "youtube",
        "threads", "tumblr", "forum"])
    bw_live_queries_max: int = 20
    bw_live_page_size: int = 300
    bw_live_parcel_max: int = 300
    bw_live_every_minutes: int = 10
    bw_live_first_minutes: int = 30
    bw_live_calls_per_10min: int = 20
    bw_live_pause_at_used: int = 450
    bw_live_source_type_new: bool = True
    # Step 3a of the new sources: while Control row 50 is ON, every post a carded Early Detection story links is seen by
    # that card in the alert memory, as its main post is. With row 50 OFF nothing changes.
    early_detection_claim_members: bool = True
    # The open engine (Control row 51, OpenEngine.gs; step S2): the day's safety stop and the run-time and outside-call
    # guards. Blank budgets come from the account type, read by the bot once a day.
    open_daily_stop: int = 2000
    open_runtime_budget_hours: float | None = None
    open_runtime_other_hours: float = 1.5
    open_lock_loss_seconds: float = 2
    open_fetch_day: int | None = None
    open_burson_pickup_p90_s: float = 120
    open_check_minutes: int = 5
    open_queue_max: int = 24
    open_requirements_first: bool = True
    open_first_screen: bool = True
    open_hold_none_at: float = 0.8
    open_equal_lanes: bool = True
    open_fresh_minutes: int = 180
    open_lane_bars: str = ''
    open_velocity_fix: bool = True
    open_velocity_lag_minutes: int = 60
    # What the Resources tab of the bot's sheet starts with: documents the bot links when Burson asks about the alert
    # requirements. After that the tab is what the bot uses (people edit it there). Only links Burson can open.
    resources: list[BursonResource] = Field(default_factory=list)


class SonarLookup(ConfigModel):
    """Optional ground truth: look up the Sonar record behind an alert (BigQuery)."""

    enabled: bool = True
    project: str = "brand-social-central-data"
    table: str = "bsip-s-bsip-gg-26-2cf3.google_bg.sonar_raw"
    alert_log_table: str = ""
    slrr_table: str = "brand-social-central-data.slrr_alerts.slrr_alerts"
    location: str = "us-central1"
    lookback_days: int = 7


class InhouseSource(ConfigModel):
    """Path B: in-house alerts from BigQuery (DSD / google_bg / slrr_alerts)."""

    enabled: bool = True
    project: str = "brand-social-central-data"
    outbox_view: str = "brand-social-central-data.DSD.DSD-story-selection"
    alert_log_table: str = "brand-social-central-data.slrr_alerts.slrr_alerts"
    sonar_table: str = "bsip-s-bsip-gg-26-2cf3.google_bg.sonar_raw"
    location: str = "US"
    sonar_location: str = "us-central1"
    mark_delivered: bool = False  # True only after cutover (parity mode leaves the log untouched)
    parity_mode: bool = True  # in-house alerts are recorded (nothing posted to chat) and reconciled against Burson's
    max_rows_per_run: int = 200


class OutboxSettings(ConfigModel):
    """How queued posts reach Studio. doorbell: "sheet" appends a row to the Agent Outbox
    Sheet (Studio "When a sheet changes" starts the Outbox flow); "email" sends a short
    email to the Triage Agent account (Studio "When I get an email"); "none" = manual/tests."""

    doorbell: Literal["sheet", "email", "none"] = "none"
    sheet_id: str | None = None
    sheet_tab: str = "outbox"
    email_subject: str = "[triage-agent outbox]"
    clean_items_per_drain: int = 1  # one alert per clean-space message (reactions map to one case)
    max_items_per_target: int = 10  # other targets aggregate up to N items into one message


class HandoverConfig(ConfigModel):
    enabled: bool = True
    post_to_team: bool = True  # 24/7 SL team chat
    append_to_doc: bool = True  # Handover doc via the Outbox flow's "Add to a doc" step
    minutes_after_shift_end: int = 5


class MetricsConfig(ConfigModel):
    burson_retrigger_minutes: int = 30  # median wait for a Burson correction + retrigger (time-saved metric)
    im_minutes_per_alert: int = 10  # manual Alert Assistant + email work replaced per drafted alert


class Shift(ConfigModel):
    name: str
    start: str  # HH:MM
    end: str
    tz: str = "America/New_York"


# ---------------------------------------------------------------------------
# Everything else
# ---------------------------------------------------------------------------


class Thresholds(ConfigModel):
    needs_review_below: float = 0.70  # overall confidence below this => NEEDS_REVIEW
    llm_block_min_confidence: float = 0.80  # LLM blocking issue below this => NEEDS_REVIEW instead
    llm_checks_enabled: bool = True
    url_check_enabled: bool = False  # HTTP reachability check of URL fields
    url_check_timeout_s: float = 4.0
    max_correction_wait_min: int = 240  # NEEDS_BURSON case abandoned after this
    sla_warn_fraction: float = 0.6  # DM the IM when this fraction of the SLA has elapsed unacknowledged
    review_reminder_min: int = 10  # NEEDS_REVIEW still undecided -> remind the IM, then leads


class ModelConfig(ConfigModel):
    # Gemini 2.5 retires 2026-10-20. Gemini 3.x models are served from the `global` endpoint
    # (and the us/eu multi-regions), not from us-central1.
    triage: str = "gemini-3.8-flash"
    drafting: str = "gemini-3.8-flash"
    converse: str = "gemini-3.8-flash"
    location: str = "global"
    temperature_triage: float = 0.0
    temperature_drafting: float = 0.4


class SpaceRef(ConfigModel):
    key: str  # burson | clean | youtube | doodle | team | crisis
    display_name: str
    space_id: str | None = None  # filled in after the Phase 0 spike
    url: str | None = None


class AgentIdentity(ConfigModel):
    display_name: str = "Triage Agent"
    email: str = ""
    message_prefix: str = "🤖"


class Analyst(ConfigModel):
    name: str
    email: str
    role: Literal["analyst", "admin", "lead", "im"] = "analyst"


class Stakeholder(ConfigModel):
    """Q&A routing directory (who owns which topics). Alert emails use `distribution`."""

    id: str
    team: str
    topics: list[str] = Field(default_factory=list)
    contacts: list[str] = Field(default_factory=list)
    chat_space: str | None = None
    email: str | None = None
    autonomy: Literal["answer_only", "notify_with_approval", "auto_notify"] = "answer_only"
    notes: str = ""


class FAQ(ConfigModel):
    question: str
    answer: str
    source: str = "config"


class KnowledgeConfig(ConfigModel):
    drive_folder_url: str | None = None
    vertex_search_datastore: str | None = None
    docs: dict[str, str] = Field(default_factory=dict)  # name -> URL (collection requirements, protocols…)
    faq: list[FAQ] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Platform settings (Console → Settings). Every value is set in the Console; nothing operational is
# written in code or in the YAML. Empty = not configured yet; every switch starts OFF.
# ---------------------------------------------------------------------------


class AccessConfig(ConfigModel):
    """Who may open the Console."""

    viewer_domains: list[str] = Field(default_factory=lambda: ["google.com"], description="Signed-in users at these domains may read the Console (role: viewer).")
    bootstrap_admins: list[str] = Field(default_factory=list, description="Extra admins, by email. Until an admin exists, the deployer set at deploy time is the only admin.")


class FeatureFlags(ConfigModel):
    """What the agent and the Console may do on their own. Every switch starts OFF.

    Each switch has a plain name (its title) and says what ON and OFF mean; messages name a switch by that title.
    """

    classification_layer: bool = Field(False, title="Sort alerts into classes", description="ON: the agent first decides what kind of alert it is, then reads only the documents kept for that kind. OFF: it reads any document that matches.")
    knowledge_rag: bool = Field(False, title="Read the Knowledge documents", description="ON: the agent reads the matching parts of your Knowledge documents when it checks an alert or answers a question, and names the documents it used. OFF: it works from its built-in rules only.")
    pubsub_delivery: bool = Field(False, title="Retry posts that fail", description="ON: the agent's posts go out through Google Pub/Sub: each is sent as soon as it is queued, tried again when it fails and set aside after the last try. OFF: each post waits for the minute run (with Post queued messages in Chat ON) or for a Chat flow to pick it up.")
    console_chat_agent: bool = Field(False, title="Let the chat agent act", description="ON: the assistant on the Chat agent page can do things for you (review an alert, start an email, run a temp check) after you confirm. OFF: it only answers questions.")
    temp_checks: bool = Field(False, title="Temp checks", description="ON: temp checks can be run from the Console and from Chat. OFF: nobody can run one.")
    auto_temp_checks: bool = Field(False, title="Start temp checks on its own", description="ON: the agent drafts a temp check when an issue meets the conditions under Settings, Temp check. OFF: only when a person asks.")
    temp_check_web: bool = Field(False, title="Search the web in a temp check", description="ON: on a temp check, an analyst can have Gemini search Google for what they need to know about that issue. What it finds is shown to that analyst only, is not kept, and is in none of the numbers. Google bills each search. OFF: nobody can.")
    workforce_forecasting: bool = Field(False, title="Forecast alert volume", description="ON: the agent forecasts alert volume on a schedule and suggests staffing changes for a lead to accept. OFF: a lead can still run a forecast by hand.")
    forecast_gap_alerts: bool = Field(False, title="Warn when volume beats the forecast", description="ON: the leads get a direct message when alerts come in faster than forecast by more than the set margin. OFF: no message.")
    campaigns: bool = Field(False, title="Change campaigns here", description="ON: campaigns can be changed and ended from the Console. OFF: they can only be viewed. Campaigns are always started in Chat.")
    watches: bool = Field(False, title="Watches", description="ON: watches can be created, changed and run. OFF: they can only be viewed.")
    golden_set_capture: bool = Field(False, title="Keep checked examples", description="ON: every fix, review decision and IM assessment is kept as an example of the right answer, used later to test the agent. OFF: only assessments an IM records are kept.")
    bigquery_admin: bool = Field(False, title="Change BigQuery from here", description="ON: admins can create and change datasets, tables and views from the Console. OFF: the Console only reads them.")
    secret_admin: bool = Field(False, title="Add secrets from here", description="ON: admins can add secrets (API tokens) from the Console. OFF: secrets are added in Google Cloud.")
    decisions_review: bool = Field(False, title="Gemini Decisions scores each alert", description="ON: Gemini Decisions gives the probability that each fix Gemini proposes is right, and the chance the alert needs a person; a fix at or above the bar is applied. OFF: every fix Gemini proposes waits for a person.")
    decisions_classifier: bool = Field(False, title="Gemini Decisions sorts alerts", description="ON: Gemini Decisions picks each alert's class; when it is unsure or fails, Gemini picks. OFF: Gemini picks every class.")
    early_detection: bool = Field(False, title="Early Detection", description="ON: the post tables are read in BigQuery every few minutes, posts on one theme are grouped into a story, and a story that reaches the bar is raised. OFF: nothing is read.")
    early_fast_triage: bool = Field(False, title="Score early stories with Gemini Decisions", description="ON: Gemini Decisions scores each story first; plain noise is held back, the most severe are written up first, and a small story that scores high is raised as an early signal. OFF: every story goes straight to its write-up.")
    early_cards: bool = Field(False, title="Post early stories in Chat", description="ON: each written-up story is posted in the second space on the Routing page. OFF: stories show in the Console only.")
    story_reads: bool = Field(False, title="Gemini reads each story", description="ON: Gemini names each story's topic, gives it a neutral name, writes a short summary and labels each post negative, neutral or positive; the Stories page counts the labels. OFF: stories show no topic, summary or sentiment.")
    chat_review: bool = Field(False, title="Review alerts read from Chat", description="ON: every minute the QA chatbot reads the source space on the Routing page and reviews each new alert there, with no Chat flow in between. What the review wants posted is queued. OFF: alerts are reviewed only when a Chat flow hands them over.")
    chat_answers: bool = Field(False, title="Answer mentions in Chat", description="ON: every minute the QA chatbot reads the spaces it works in and answers each message that mentions it, in that message's thread, through its own Chat sign-in, with no Chat flow in between. A reply for the source space follows the Routing page's rules. OFF: mentions are answered only when a Chat flow hands them over.")
    chat_questions: bool = Field(False, title="Answer questions without a mention", description="ON: with Answer mentions in Chat ON too, the QA chatbot also answers what the sheet-based bot answered without being mentioned. In Burson's space: a question, or in an alert's thread a follow-up about the alert (its fields, status or escalation). In the other spaces it reads: a question, or in a thread a follow-up about the alert or about what to do next. Short replies like \"ok, will fix\", messages that mention someone else and alerts a person pastes are left alone. OFF: only messages that mention it are answered.")
    campaign_handoff: bool = Field(False, title="Hand threads to the campaigns assistant", description="ON: with Answer mentions in Chat ON too, when someone in the second space on the Routing page asks, in a thread, for a Brandwatch deep dive or an alert campaign, the QA chatbot hands that thread to the campaigns assistant, says so in the thread and leaves the thread to it, as the sheet-based bot did. Needs the campaigns database under Settings, Campaigns. OFF: nothing is handed over. Either way the QA chatbot never answers in a thread the campaigns assistant owns.")
    chat_delivery: bool = Field(False, title="Post queued messages in Chat", description="ON: the QA chatbot posts what is queued, in its space or in each person's direct message, through its own Chat sign-in, with no Chat flow in between: every minute, or as soon as it is queued when Retry posts that fail is ON too. Each post passes the Routing page's rules and the leak guard again first. OFF: queued posts wait for a Chat flow.")
    alert_popups: bool = Field(False, title="Alert pop-ups", description="ON: people in the Console get a pop-up when an alert comes in; each person can mute their own. OFF: no pop-ups.")
    own_alerts: bool = Field(False, title="Agent alerts", description="ON: every few minutes the sources under Settings, Agent alerts are read. Personal details are taken out of each post before it is kept, each post is checked against the rules, like posts are grouped into stories in BigQuery, and what passes is reviewed. OFF: nothing is read and nothing is reviewed.")
    own_alerts_post: bool = Field(False, title="Post agent alerts in Chat", description="ON: each alert the review raises is posted in the space named under Settings, Agent alerts. OFF: raised alerts show in the Console only.")


def switch_title(name: str) -> str:
    """A switch's plain name, as Settings shows it."""
    field = FeatureFlags.model_fields.get(name)
    return (field.title if field and field.title else name.replace("_", " ").capitalize())


def switch_off(what: str, name: str) -> str:
    """The sentence a person reads when a switch is OFF: what is off, and the switch to turn on."""
    return f'{what} is switched off. An admin can turn on "{switch_title(name)}" under Settings, Switches.'


class PubSubConfig(ConfigModel):
    """Outbound delivery. Topic and subscription ids are short names inside `project`."""

    project: str = Field("", description="Project that holds the topics. Blank = the project the service runs in.")
    outbound_topic: str = Field("", description="Topic outbound actions are published to.")
    outbound_subscription: str = Field("", description="Push subscription that delivers outbound actions to the worker.")
    dead_letter_topic: str = Field("", description="Topic an action goes to after the delivery attempts run out.")
    dead_letter_subscription: str = Field("", description="Push subscription that hands dead letters to the worker.")
    max_delivery_attempts: int = Field(5, ge=5, le=100, description="Delivery attempts before an action is dead-lettered (Pub/Sub allows 5 to 100).")
    ack_deadline_s: int = Field(60, ge=10, le=600, description="Seconds the worker has to finish one delivery.")
    min_backoff_s: int = Field(10, ge=0, le=600, description="Shortest wait before a retry.")
    max_backoff_s: int = Field(600, ge=0, le=600, description="Longest wait before a retry.")
    worker_url: str = Field("", description="Base URL of the worker service that receives pushes.")
    push_service_account: str = Field("", description="Service account Pub/Sub signs its pushes as. The worker accepts only this identity.")
    push_audience: str = Field("", description="Audience in the push token. Blank = the worker URL.")


class BigQueryConfig(ConfigModel):
    """The agent's own BigQuery connection and where each kind of row lives."""

    project: str = Field("", description="Project queries run in and are billed to. Blank = the project the service runs in.")
    location: str = Field("", description="Location of the agent's dataset, for example US.")
    dataset: str = Field("", description="The agent's own dataset. New tables the Console creates go here.")
    tables: dict[str, str] = Field(default_factory=dict, description="Which table holds what: events, volume, forecasts, golden, llm_usage, chat_activity, audit. Each value is project.dataset.table.")
    hot_window_hours: int = Field(48, ge=1, le=720, description="Recent events kept in the fast store for live views. Older ranges are read from BigQuery.")
    max_bytes_billed: int = Field(0, ge=0, description="Cap on bytes one Console query may bill. 0 = no cap.")
    admin_allowed_datasets: list[str] = Field(default_factory=list, description="Datasets the Console may create or change objects in. Others are read-only.")


class ForecastingConfig(ConfigModel):
    """Volume forecast and the staffing math built on it."""

    model: Literal["timesfm", "arima_plus"] = Field("timesfm", description="Primary method: timesfm (AI.FORECAST) or arima_plus (explainable).")
    fallback: Literal["arima_plus", "timesfm", "none"] = Field("arima_plus", description="Used when the primary method fails.")
    timesfm_version: str = Field("", description="Model name passed to AI.FORECAST, for example TimesFM 2.5. Blank = BigQuery's default.")
    arima_model: str = Field("", description="dataset.model the ARIMA_PLUS model is trained into. Blank = <dataset>.alert_volume_arima.")
    horizon_hours: int = Field(48, ge=1, le=720, description="Hours ahead to forecast.")
    confidence_level: float = Field(0.9, gt=0, lt=1, description="Confidence level of the prediction interval.")
    history_days: int = Field(56, ge=7, le=730, description="Days of past volume the forecast reads.")
    volume_event_types: list[str] = Field(default_factory=lambda: ["alert.received"], description="Events counted as volume.")
    refresh_minutes: int = Field(60, ge=15, le=1440, description="How often the forecast is rerun.")
    minutes_per_alert: float = Field(10, gt=0, description="Handling time one alert takes an IM.")
    target_utilization: float = Field(0.7, gt=0, le=1, description="Share of an IM's hour planned for alert work.")
    min_staff: int = Field(1, ge=0, description="Fewest IMs on shift in any hour.")
    use_upper_bound: bool = Field(False, description="Staff to the upper bound of the interval instead of the forecast value.")
    gap_alert_pct: float = Field(25, ge=0, description="Live volume over forecast by this percent raises a gap alert.")
    gap_alert_min_alerts: int = Field(5, ge=0, description="Gap alerts need at least this many alerts over forecast.")
    timezone: str = Field("", description="Timezone for hour-of-day views. Blank = the display timezone.")


class ChatAgentConfig(ConfigModel):
    """The in-Console chat agent."""

    model: str = Field("", description="Model for the chat agent. Blank = the converse model.")
    temperature: float = Field(0.2, ge=0, le=2, description="How freely the assistant words its answers. 0 = the same answer every time.")
    max_steps: int = Field(8, ge=1, le=30, description="Tool calls allowed in one turn.")
    history_turns: int = Field(20, ge=0, le=200, description="Earlier turns sent with each message.")
    retrieval_top_k: int = Field(6, ge=0, le=30, description="Knowledge passages retrieved for a question.")
    confirm_actions: bool = Field(True, description="Ask before running a tool that changes something.")


class ClassDef(ConfigModel):
    name: str = Field(..., description="The name of this kind of alert, as people will see it.")
    description: str = Field("", description="What makes an alert this kind, in a sentence. The agent sorts by it.")
    knowledge_tags: list[str] = Field(default_factory=list, description="Knowledge docs with any of these tags are read for this class.")
    knowledge_docs: list[str] = Field(default_factory=list, description="Knowledge doc ids always read for this class.")


class ClassificationConfig(ConfigModel):
    """The classification layer: the classes an alert can fall in and the knowledge each one reads."""

    classes: list[ClassDef] = Field(default_factory=list, description="Blank = one class for each exposure tag category in the taxonomy.")
    model: str = Field("", description="Model for classification. Blank = the triage model.")
    min_confidence: float = Field(0.5, ge=0, le=1, description="When Gemini Decisions picks the class: below this probability the class is not trusted and all knowledge is searched.")
    fallback_class: str = Field("", description="Class used when none fits. Blank = no class.")


class KnowledgeRagConfig(ConfigModel):
    """How knowledge docs are stored and retrieved."""

    embedding_model: str = Field("", description="Embedding model for retrieval. Blank = keyword retrieval only.")
    embedding_location: str = Field("", description="Location for the embedding model. Blank = the model location.")
    embedding_dimensions: int = Field(0, ge=0, description="Output size to ask for. 0 = the model's own.")
    chunk_chars: int = Field(1200, ge=200, le=8000, description="A document is split into passages of about this many characters.")
    chunk_overlap: int = Field(150, ge=0, le=2000, description="Characters each passage shares with the one before it, so a sentence is not cut in two.")
    top_k: int = Field(6, ge=1, le=30, description="How many passages the agent reads for one alert or question.")
    min_score: float = Field(0.12, ge=0, le=1, description="Passages scoring lower are left out.")
    max_doc_chars: int = Field(1000000, ge=1000, description="Characters kept of one document.")
    max_upload_mb: int = Field(20, ge=1, le=100, description="The largest file that can be uploaded as a document, in megabytes.")
    refresh_minutes: int = Field(15, ge=5, description="How often linked documents are checked for changes.")
    web_refresh_hours: int = Field(6, ge=1, description="How often web pages are read again.")
    past_cases_days: int = Field(30, ge=0, description="Past cases searched as context. 0 = none.")
    past_cases_top_k: int = Field(3, ge=0, le=20, description="How many similar earlier alerts the agent reads. 0 = none.")


class TempCheckSource(ConfigModel):
    """One table of posts a temp check searches."""

    key: str = Field(..., description="A short name for this table, with no spaces.")
    label: str = Field("", description="The name people see for this table.")
    what: str = Field("", description="What this table holds, in a sentence. Shown where the tables are picked.")
    table: str = Field("", description="project.dataset.table")
    location: str = Field("", description="BigQuery location of the table. Blank = the agent's own.")
    enabled: bool = Field(True, description="OFF: temp checks skip this table.")
    read_sql: str = Field("", description="How the table is read, for a table the columns below can't describe: one SELECT that gives each post as platform, author, text, url, posted, followers, eng, sentiment, language, shares, replies, seen (when the row arrived) and one (what makes a row one post). Write {table} where the table's name goes; @t_from and @t_to are the stretch being searched. Blank = the columns below are used.")
    has: list[Literal["text", "author", "url", "platform", "followers", "language"]] = Field(default_factory=list, description="With a read above: which of text, author, url, platform, followers and language it fills. A part of a query that needs one the table lacks is left out for that table.")
    x_lookup: bool = Field(True, description="ON: X posts that came without their words are looked up in this table.")
    text_columns: list[str] = Field(default_factory=list, description="Columns searched for the query's words.")
    url_column: str = Field("", description="The column that holds the post's link.")
    id_column: str = Field("", description="Row id, for tables where many rows share one link (comments).")
    author_column: str = Field("", description="The column that holds who posted it.")
    time_column: str = Field("", description="When the post was made (TIMESTAMP).")
    platform_column: str = Field("", description="The column that holds the platform (X, Reddit, YouTube).")
    platform_value: str = Field("", description="Platform name for a table that holds one platform only.")
    followers_column: str = Field("", description="The column that holds the author's follower count.")
    language_column: str = Field("", description="The column that holds the post's language.")
    engagement_expr: str = Field("", description="SQL expression for a post's engagement.")
    sentiment_column: str = Field("", description="The column that holds the post's sentiment.")
    filter_sql: str = Field("", description="Extra WHERE condition, for example to leave out the company's own posts.")
    dedupe_by: Literal["url", "id"] = Field("url", description="How the same post is recognised when it appears twice: by its link or by its id.")
    freshness: str = Field("", description="How fresh the table is, shown beside its results.")

    @model_validator(mode="after")
    def _read_is_one_select(self) -> "TempCheckSource":
        read = self.read_sql.strip()
        if not read:
            return self
        if not read.lower().startswith("select") or ";" in read:
            raise ValueError("The read must be one statement that starts with SELECT.")
        if "{table}" not in read:
            raise ValueError("Write {table} in the read where the table's name goes.")
        if "text" not in self.has:
            raise ValueError("Say what the read fills: at least text.")
        return self


class ConcernBand(ConfigModel):
    label: str = Field(..., description="The name of this level of concern (for example Low, Elevated, High).")
    top_pct: int = Field(..., ge=1, le=100, description="The issue is above all but this percent of past issues, or fewer.")
    action: str = Field("", description="What the team does at this level. Shown in the write-up.")


class TempCheckConfig(ConfigModel):
    """Temp checks: numbers from Brandwatch, posts from the team's own tables, a write-up by Gemini."""

    brandwatch_api_base: str = Field("https://api.brandwatch.com", description="Brandwatch API base URL.")
    brandwatch_project_id: str = Field("", description="Brandwatch project the queries live in.")
    brandwatch_token_secret: str = Field("", description="Name of the secret (Settings → Secrets) holding the Brandwatch token.")
    event_query_prefix: str = Field("", description="Name prefix of the event queries offered in the picker and used for the concern level.")
    standing_query_name: str = Field("", description="Standing queries are found by name: the active Brandwatch queries whose name starts with this are searched when the issue has no query of its own yet. Blank = only the ids below.")
    standing_query_skip: str = Field("", description="A standing query whose name has this word is left out. Blank = none is.")
    landscape_query_ids: list[str] = Field(default_factory=list, description="Standing queries named by id, searched as well as the ones found by name.")
    sources: list[TempCheckSource] = Field(default_factory=list, description="The tables searched for posts.")
    model: str = Field("", description="Model that writes the write-up. Blank = the drafting model.")
    timezone: str = Field("", description="Timezone the write-up's times are given in. Blank = the display timezone.")
    top_posts: int = Field(25, ge=1, le=200, description="Most-engaged posts read.")
    top_negative_posts: int = Field(15, ge=0, le=200, description="Most-engaged negative posts read.")
    writeup_posts: int = Field(7, ge=1, le=25, description="Highest-engaging posts listed in the write-up.")
    gemini_posts: int = Field(25, ge=1, le=100, description="Posts Gemini reads for the summary, negativity drivers and themes.")
    x_lookup_max: int = Field(40, ge=0, le=200, description="X posts whose words are looked up for one temp check (Brandwatch gives X posts without their words).")
    x_embed_url: str = Field("https://cdn.syndication.twimg.com/tweet-result", description="X's public embed data, where an X post's words are read from. Blank = not asked.")
    lookback_hours: int = Field(168, ge=1, le=720, description="How far back an issue's start is looked for.")
    spike_mentions: int = Field(100, ge=1, description="An issue counts from the first hour with this many mentions.")
    before_query_hours: int = Field(48, ge=0, le=720, description="An issue's start is looked for from this many hours before its Brandwatch query was made.")
    no_query_hours: int = Field(24, ge=1, le=720, description="With no Brandwatch query yet: the hours before the alert (or before now) that are counted.")
    since_max_days: int = Field(31, ge=1, le=365, description="How many days back 'Count from: a time I choose' may reach.")
    query_list_minutes: int = Field(30, ge=0, le=1440, description="Minutes Brandwatch's list of queries is kept before it is read again.")
    keep_posts: int = Field(3000, ge=0, le=20000, description="Posts from our own tables kept with a temp check, so a later one can reuse them. 0 = none kept.")
    keep_posts_days: int = Field(31, ge=1, le=365, description="Days those kept posts stay before they are removed.")
    row_limit: int = Field(3000, ge=100, le=5000, description="Posts read from one table.")
    max_scan_gb: float = Field(0, ge=0, description="Largest scan one search may bill, in GB. 0 = no cap.")
    daily_limit: int = Field(20, ge=0, description="Automatic temp checks started in one day.")
    high_engagement_share: float = Field(0.9, gt=0, lt=1, description="High-engaging: more engagement than this share of recent alerts.")
    high_min_alerts: int = Field(100, ge=1, description="Recent alerts needed before that share is used.")
    high_floor: int = Field(20000, ge=0, description="Engagements that count as high-engaging until enough alerts are known.")
    multiple_alerts_count: int = Field(3, ge=2, description="This many different posts alerted on one issue starts one.")
    multiple_alerts_hours: int = Field(24, ge=1, description="The hours within which that many alerts on one issue start a temp check.")
    momentum_recheck_minutes: list[int] = Field(default_factory=lambda: [30, 90], description="When an alert's post is read again for momentum.")
    momentum_growth: float = Field(0.5, gt=0, description="Growth between two readings that starts one (0.5 = up by half).")
    momentum_within_hours: int = Field(6, ge=1, description="A post must grow that much within this many hours to count as gaining momentum.")
    momentum_min: int = Field(500, ge=0, description="Engagements the later reading needs.")
    refresh_min_minutes: int = Field(60, ge=5, description="Shortest time between refreshes of one temp check.")
    keep_refreshed_hours: int = Field(24, ge=1, le=168, description="'Keep refreshed for a day': the hours a temp check goes on being refreshed.")
    benchmark_min_issues: int = Field(20, ge=1, description="Past issues needed before a concern level is given.")
    benchmark_fill_per_run: int = Field(3, ge=0, le=50, description="Past issues' volume read from Brandwatch in one run, for the concern level.")
    concern_bands: list[ConcernBand] = Field(default_factory=lambda: [
        ConcernBand(label="HIGH", top_pct=20, action="Action"), ConcernBand(label="MODERATELY HIGH", top_pct=39, action="Action"),
        ConcernBand(label="MODERATE", top_pct=59, action="Monitor"), ConcernBand(label="MODERATELY LOW", top_pct=79, action="Monitor"),
        ConcernBand(label="LOW", top_pct=100, action="No action")], description="Concern levels, highest first.")
    relevance_posts: int = Field(40, ge=5, le=100, description="Posts Gemini reads to check a drafted query.")
    relevance_min_share: float = Field(0.5, gt=0, le=1, description="Share of the posts read that must be about the issue for a count to be given.")
    web_search: Literal["google", "enterprise"] = Field("google", description="Which search Gemini uses when an analyst searches the web from a temp check: google = Grounding with Google Search (the whole index; Google says it logs these searches for up to 30 days), enterprise = Web Grounding for Enterprise (a smaller index; Google says it logs nothing).")
    web_sites: list[str] = Field(default_factory=lambda: ["x.com", "reddit.com", "linkedin.com"], description="Sites Gemini is told to look at first in a web search. None = it is not pointed anywhere first.")
    web_exclude_sites: list[str] = Field(default_factory=list, description="Sites a web search leaves out.")
    docs_folder_id: str = Field("", description="Drive folder temp check documents are kept in. Blank = no document is made.")
    post_to_space: str = Field("", description="Space key temp check results are posted to. Blank = Console only.")


class ModelPrice(ConfigModel):
    input_per_million: float = Field(0, ge=0, description="Price for a million tokens the model reads.")
    output_per_million: float = Field(0, ge=0, description="Price for a million tokens the model writes.")


class CostConfig(ConfigModel):
    """Cost views. Prices are entered here; nothing is assumed."""

    currency: str = Field("USD", description="The currency costs are shown in.")
    model_prices: dict[str, ModelPrice] = Field(default_factory=dict, description="Price per million tokens for each model name.")
    billing_export_table: str = Field("", description="BigQuery billing export table for the service cost view.")
    monthly_budget: float = Field(0, ge=0, description="Shown as the budget line. 0 = none.")


class StoriesConfig(ConfigModel):
    """How alerts are grouped into stories (the Chat bot's alert memory rules) and what the story map shows."""

    same_story_similarity: float = Field(0.85, ge=0, le=1, description="Two alerts this alike in meaning are the same story.")
    gray_similarity: float = Field(0.80, ge=0, le=1, description="This alike is the same story only with the same exposure tag and product.")
    summary_chars: int = Field(400, ge=0, le=4000, description="Characters of the summary that count toward a story's text.")
    boilerplate_patterns: list[str] = Field(
        default_factory=lambda: [r"Automated Alert via Burson[\s\S]*?(?:\n|$)", r"Note: This is an automated message[\s\S]*?(?:\n|$)"],
        description="Text removed from a summary before stories are compared (regular expressions).")
    keep_days: int = Field(14, ge=1, le=365, description="A story with no new alert for this many days is over; a later alert starts a new one.")
    active_hours: int = Field(6, ge=1, le=168, description="A story with an alert in the last this many hours shows as growing.")
    map_hours: int = Field(72, ge=1, le=24 * 30, description="Hours the story map shows when it opens.")
    size_by: Literal["engagement", "alerts"] = Field("engagement", description="What a circle's size stands for.")
    read_model: str = Field("", description="Model that reads a story. Blank = the drafting model.")
    read_posts: int = Field(40, ge=1, le=200, description="Posts of one story Gemini reads, the most engaged first.")
    read_post_chars: int = Field(500, ge=50, le=4000, description="Characters of each post Gemini reads.")
    reads_per_run: int = Field(5, ge=0, le=100, description="Stories Gemini reads in one run, the biggest unread first.")
    reread_minutes: int = Field(30, ge=1, le=24 * 60, description="A story that grew is read again only after this many minutes.")
    topics_offered: int = Field(30, ge=0, le=200, description="Topics already in use that Gemini is shown, so one subject keeps one name.")
    negative_share: float = Field(0.5, gt=0, le=1, description="A story is negative (red) when at least this share of its rated posts is negative.")
    positive_share: float = Field(0.5, gt=0, le=1, description="A story is positive when at least this share of its rated posts is positive.")
    min_rated_share: float = Field(0.25, ge=0, le=1, description="A story or group gets a sentiment only when at least this share of its posts is rated.")


class NotificationsConfig(ConfigModel):
    """Pop-ups in the Console (switch: Alert pop-ups)."""

    popup_event_types: list[str] = Field(default_factory=lambda: ["alert.received"], description="Events that raise a pop-up.")
    popup_sources: list[str] = Field(default_factory=lambda: ["burson_chat"], description="Alert sources that raise a pop-up. Blank = every source.")
    popup_seconds: int = Field(12, ge=3, le=120, description="Seconds a pop-up stays on screen.")
    max_on_screen: int = Field(3, ge=1, le=10, description="Pop-ups shown at once; older ones give way.")


class TelemetryConfig(ConfigModel):
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = Field("INFO", description="How much the services write to their logs. INFO is the usual choice; DEBUG writes the most.")
    tracing: bool = Field(False, description="Export traces to Cloud Trace.")
    trace_sample_rate: float = Field(0.1, ge=0, le=1, description="The share of requests traced when tracing is ON. 0.1 = one in ten.")
    audit_retention_days: int = Field(400, ge=1, description="Days audit entries are kept in the fast store.")
    chat_retention_days: int = Field(90, ge=1, description="Days Chat activity is kept in the fast store.")
    tick_late_minutes: int = Field(5, ge=1, le=1440, description="Admin shows the scheduled work as late after this many minutes without a run.")


class SafetyConfig(ConfigModel):
    """Runtime guards. A failed check blocks the action it protects."""

    external_spaces: list[str] = Field(default_factory=lambda: ["burson"], description="Space keys people outside the company can read. The leak guard runs on everything bound for them.")
    leak_terms: list[str] = Field(default_factory=list, description="Words that must never appear in a message to an external space.")
    testing: bool = Field(True, description="Testing: emails go only to the testing recipients below and nothing is sent when there are none.")
    testing_recipients: list[str] = Field(default_factory=list, description="Who receives every email while Testing is ON (5 at most).")
    allowed_recipient_domains: list[str] = Field(default_factory=list, description="Email is only ever drafted to these domains. Blank = no restriction.")
    allowed_post_targets: list[str] = Field(default_factory=lambda: ["burson", "clean", "dm", "youtube", "doodle", "team", "crisis", "handover"], description="Targets the agent may post to. A target not listed is held, never posted.")
    block_on_failed_check: bool = Field(True, description="A failed runtime check stops outbound delivery until it passes.")


class CampaignsConfig(ConfigModel):
    """Campaigns and watches shown in the Console."""

    firestore_database: str = Field("", description="Firestore database the campaigns service keeps its state in.")
    firestore_project: str = Field("", description="Project of that database. Blank = the project the service runs in.")
    watch_sources: list[str] = Field(default_factory=list, description="Keys of the post tables (Temp check → sources) a watch reads.")
    watch_interval_minutes: int = Field(5, ge=1, description="How often the watches look.")
    watch_max_enabled: int = Field(5, ge=1, le=20, description="Watches ON at once (each post costs one question a watch).")
    watch_default_bar: float = Field(7, ge=1, le=10, description="A watch's bar when its own is blank.")
    watch_near_miss: float = Field(2, ge=0, le=9, description="Scores within this of the bar are kept as near misses, to tune the bar.")
    watch_posts_per_look: int = Field(60, ge=1, le=500, description="Posts one source hands over in one look.")
    watch_posted_within_hours: int = Field(72, ge=1, description="Only posts made within this many hours are asked about.")
    watch_min_followers: int = Field(1000, ge=0, description="A post is asked about when its author has this many followers...")
    watch_min_engagement: int = Field(100, ge=0, description="...or the post has this many engagements.")
    watch_first_look_minutes: int = Field(60, ge=5, description="How far back a source's first look goes.")
    watch_max_look_minutes: int = Field(360, ge=5, description="The most one look covers after a pause.")
    watch_default_topics: list[str] = Field(default_factory=list, description="Topics offered when a watch names none.")
    watch_ai_connection: str = Field("", description="BigQuery connection for the AI functions. Blank = the service's own credentials.")
    watch_post_target: str = Field("", description="Space key detections at the bar are posted to. Blank = recorded only.")
    watch_lead_window_hours: int = Field(72, ge=1, description="A detection counts as catching an alert on the same post within this many hours.")


class GcpConfig(ConfigModel):
    project: str = Field("", description="Project the agent runs in. Blank = detected from the runtime.")
    region: str = Field("", description="Region of the Cloud Run services.")
    agent_runtime_resource: str = Field("", description="Agent Runtime resource name the Studio flows call.")
    secret_prefix: str = Field("", description="Only secrets whose name starts with this are shown and managed in the Console.")
    console_url: str = Field("", description="Public URL of the Console, used in links the agent posts.")


class RoutingConfig(ConfigModel):
    """Which Chat space the QA chatbot reads, where it copies it, and whether it may write back (the Routing page)."""

    bot_on: bool = Field(False, description="ON: the QA chatbot reads the source space every minute and copies it. OFF: it reads and writes nothing in Chat.")
    source: str = Field("", description="The space the messages come from: Burson's space, or any other. A link or an id.")
    mirror: str = Field("", description="Second space: gets a copy of every message from the source, in the same order. A link or an id. Blank = no copy.")
    third: str = Field("", description="Third space: gets a copy of every message that reached the second space. A link or an id. Blank = none.")
    copy_everything: bool = Field(False, description="ON: replies, people's messages and emojis are copied too. OFF: only alerts are copied.")
    ask_before_source: bool = Field(False, description="ON: each message for the source space waits for a person to press Send or Skip. OFF: it is posted straight away.")
    start_minutes: int = Field(15, ge=0, le=1440, description="When a space is set or changed, copying starts this many minutes back.")
    max_per_run: int = Field(25, ge=1, le=200, description="The most messages copied in one minute. The rest follow on the next.")
    max_tries: int = Field(5, ge=1, le=50, description="A message that fails this many times in a row is given up on, with the reason shown.")
    emoji_hours: int = Field(24, ge=1, le=72, description="Emojis are copied on messages up to this many hours old.")
    keep_days: int = Field(30, ge=1, le=365, description="How long the record of what was copied is kept.")
    answer_spaces: list[str] = Field(default_factory=list, description="More spaces where a mention of the QA chatbot is answered, picked from the agent's spaces under Integrations, Google Chat. The source, second and third spaces are always read. Empty = only those three.")


class DecisionsConfig(ConfigModel):
    """Gemini Decisions: the decision maker. It answers set questions with probabilities and writes no text."""

    secret: str = Field("", description="Name of the secret that holds the Gemini API key. Blank = Gemini Decisions is not used.")
    model: str = Field("gemini-decision-1", description="The Decisions model.")
    base_url: str = Field("https://generativelanguage.googleapis.com", description="Where the Decisions API is reached.")
    api_version: str = Field("v1beta", description="The API version in the address.")
    max_per_day: int = Field(300, ge=0, le=100000, description="The most questions-calls in a day. Past it, work goes on without Gemini Decisions.")
    slow_ms: int = Field(10000, ge=500, le=120000, description="An answer slower than this many milliseconds counts as failed.")
    pause_minutes: int = Field(15, ge=1, le=1440, description="After a failure no call is made for this long.")
    input_max_chars: int = Field(4000, ge=200, le=20000, description="The longest input sent in one call.")
    class_min_confidence: float = Field(0.7, ge=0, le=1, description="Sorting alerts: at or above this, the class Gemini Decisions picked is used. Below it, Gemini picks.")
    hold_about_max: float = Field(0.10, ge=0, le=1, description="Early stories: a low-severity story is held back when 'about the company' is at or below this.")
    hold_noise_min: float = Field(0.90, ge=0, le=1, description="Early stories: a low-severity story is held back when 'routine chatter' is at or above this.")
    confidence_min: float = Field(0.55, ge=0, le=1, description="Early stories: an answer below this confidence holds nothing back and raises nothing.")
    watch_min: float = Field(0.80, ge=0, le=1, description="Early signal: 'about the company' and 'a risk to the brand' must each reach this.")
    independent_min: float = Field(0.30, ge=0, le=1, description="Early signal: 'separate accounts report it first-hand' must reach this.")
    watch_min_level: int = Field(2, ge=0, le=4, description="Early signal: the lowest severity that raises one (0 none, 1 low, 2 medium, 3 high, 4 critical).")


class EarlyConfig(ConfigModel):
    """Early Detection: posts on one theme are grouped into a story inside BigQuery, before anyone raises an alert."""

    sources: list[str] = Field(default_factory=list, description="Keys of the post tables read (Settings, Temp check, sources).")
    interval_minutes: int = Field(15, ge=1, le=1440, description="How often the post tables are read.")
    embedding_endpoint: str = Field("text-embedding-005", description="The Vertex AI model that turns each post into numbers, run from BigQuery.")
    ai_connection: str = Field("", description="BigQuery connection for the Vertex AI call (project.location.name). Blank = the service's own sign-in.")
    company: str = Field("Google or Alphabet", description="Who the stories must be about, as Gemini Decisions is asked.")
    about_true: str = Field("They are about Google or Alphabet, an executive of theirs, or a product or service of theirs, such as Search, AI Overviews, Gemini, Pixel, Android, Chrome, Chromebook, YouTube, Gmail, Workspace, Maps, Waze, Photos, Drive, Cloud, Play, Pay, Wallet, Ads, Nest, Fitbit, Waymo, DeepMind, NotebookLM, Veo or Imagen.",
                            description="What counts as about the company.")
    about_false: str = Field("An unrelated keyword or homonym: the generic verb (\"google it\"), Gemini the star sign (season, moon, rising, horoscope, zodiac), Chrome Hearts or chrome wheels and rims, a store badge (\"Available on Google Play\", \"Get it on Google Play\"), or posts about something else entirely.",
                             description="What does not count as about the company.")
    max_followers: int = Field(5000, ge=0, description="Only posts by accounts with this many followers or fewer are read (bigger accounts reach alerts another way).")
    max_engagement: int = Field(500, ge=0, description="Only posts with fewer engagements than this are read.")
    min_chars: int = Field(40, ge=1, description="A post needs at least this many characters.")
    min_words: int = Field(7, ge=1, description="A post needs at least this many words.")
    posted_within_hours: int = Field(24, ge=1, le=168, description="Only posts made within this many hours are read.")
    lag_minutes: int = Field(30, ge=0, le=720, description="Each read goes this far back again, for posts that reach the table late. None is read twice.")
    skip_authors: list[str] = Field(default_factory=lambda: ["grok", "automoderator", "[deleted]"], description="Accounts whose posts are left out.")
    posts_per_check: int = Field(200, ge=1, le=2000, description="The most new posts one table hands over in one read.")
    pool_hours: int = Field(6, ge=1, le=72, description="A post with no story yet can start or join one for this many hours.")
    active_hours: int = Field(24, ge=1, le=168, description="A story takes new posts for this many hours after its last one.")
    join_similarity: float = Field(0.82, ge=0.5, le=1, description="A post joins a story when it is at least this close to the story's centre.")
    start_similarity: float = Field(0.80, ge=0.5, le=1, description="Posts start a story together when they are at least this close to each other.")
    neighbours: int = Field(20, ge=2, le=200, description="How many of a post's closest posts are looked at when a story starts.")
    window_minutes: int = Field(180, ge=15, le=1440, description="A story is measured over its last this many minutes.")
    min_accounts: int = Field(5, ge=2, description="A story is raised at this many separate accounts...")
    min_accounts_two_platforms: int = Field(4, ge=2, description="...or at this many when it is on two or more platforms.")
    min_links: int = Field(2, ge=1, description="A story needs at least this many separate posts.")
    early_accounts: int = Field(3, ge=2, description="An early signal looks at stories with at least this many accounts (with Gemini Decisions scoring ON).")
    max_per_check: int = Field(5, ge=1, le=100, description="The most stories raised from one read.")
    max_per_day: int = Field(40, ge=1, le=1000, description="The most stories raised in a day.")
    reviews_per_minute: int = Field(2, ge=1, le=20, description="How many raised stories Gemini writes up each minute.")
    posts_shown: int = Field(12, ge=1, le=50, description="How many of a story's posts are kept with it.")
    keep_days: int = Field(14, ge=1, le=365, description="How long raised stories are kept in the Console.")


class OwnAlertsConfig(ConfigModel):
    """Agent alerts: the sources are read, personal details are taken out of each post, each post is checked against the
    rules, like posts are grouped into stories in BigQuery, and what passes is reviewed and raised."""

    # -- what is read ---------------------------------------------------------------------------------------------
    sources: list[str] = Field(default_factory=list, title="Tables read", description="Keys of the post tables read (Settings, Temp check, sources). Tick them on the Integrations page.")
    brandwatch_queries: list[str] = Field(default_factory=list, description="Ids of the Brandwatch queries read through Brandwatch's API. Blank = none.")
    other_alerts_space: str = Field("", description="The Chat space other tools post their alerts in. A link or an id. Blank = not read.")
    other_alerts_mandatory: bool = Field(True, title="Always review what other tools post", description="ON: every alert another tool posts in that space goes to review and is raised; the review sets its severity and path. OFF: those alerts are checked against the rules like any other post.")
    interval_minutes: int = Field(2, ge=1, le=1440, title="Minutes between runs", description="How often the sources are read.")
    first_read_minutes: int = Field(15, ge=1, le=1440, title="Minutes the first read goes back", description="How far back a source's first read goes.")
    max_read_minutes: int = Field(360, ge=5, le=10080, title="Most minutes one read covers", description="The most one read covers after a pause.")
    lag_minutes: int = Field(2, ge=0, le=720, title="Minutes read again", description="Each read goes this far back again, for posts that reach a source late. None is kept twice.")
    posted_within_hours: int = Field(72, ge=1, le=720, title="Only posts this many hours old", description="Only posts made within this many hours are kept.")
    posts_per_read: int = Field(500, ge=1, le=5000, description="The most new posts one source hands over in one read. The rest follow on the next.")
    english_only: bool = Field(True, description="ON: posts a source marks as not English are left out.")

    # -- personal details -----------------------------------------------------------------------------------------
    snippet_chars: int = Field(500, ge=50, le=2000, title="Characters of a post kept", description="The most characters of a post that are kept.")
    dlp_info_types: list[str] = Field(default_factory=lambda: ["EMAIL_ADDRESS", "PHONE_NUMBER", "PERSON_NAME", "STREET_ADDRESS", "IP_ADDRESS",
                                                               "CREDIT_CARD_NUMBER", "US_SOCIAL_SECURITY_NUMBER"],
                                      title="Personal details taken out", description="The kinds of personal detail Google's Sensitive Data Protection takes out of each post, by its own names.")
    dlp_location: str = Field("", title="Where Sensitive Data Protection runs", description="Where Sensitive Data Protection is called. Blank = the region the service runs in.")
    hash_salt_secret: str = Field("", title="Secret that holds the salt", description="Name of the secret that holds the salt an author's handle is hashed with. Nothing is read until it is set.")
    keep_days: int = Field(30, ge=1, le=30, title="Days posts are kept", description="How long posts, stories and the vault of KOF names and links are kept. Never more than 30 days.")
    decisions_keep_days: int = Field(90, ge=1, le=365, title="Days decisions are kept", description="How long decisions and verdicts are kept. They hold no personal details.")

    # -- the KOF list ---------------------------------------------------------------------------------------------
    kof_sheet: str = Field("", title="KOF sheet", description="Link to the Google Sheet that lists the KOFs. Share it with the service's account (Viewer). Blank = no author counts as a KOF.")
    kof_refresh_minutes: int = Field(60, ge=1, le=1440, title="Minutes between reads of the KOF sheet", description="How often the KOF list is read again.")
    kof_handle_columns: list[str] = Field(default_factory=list, title="KOF sheet: handle columns", description="The headers of the columns that hold handles or profile links. Blank = any cell of a row may name the handle.")
    kof_name_column: str = Field("", title="KOF sheet: name column", description="The header of the column that holds a KOF's name. Blank = the first filled cell of the row.")

    # -- the models BigQuery calls --------------------------------------------------------------------------------
    ai_connection: str = Field("", title="BigQuery connection for the models", description="BigQuery connection the models are called through (project.location.name).")
    embedding_endpoint: str = Field("gemini-embedding-001", title="Embedding model", description="The Vertex AI model that turns each post into numbers, so like posts can be grouped.")
    embedding_dimensions: int = Field(768, ge=128, le=3072, title="Numbers per post", description="How many numbers each post is turned into.")
    fast_endpoint: str = Field("gemini-4-hydrogen", title="Fast model in BigQuery", description="The Gemini model BigQuery asks first: one post against a rule, and whether a story is worth a review.")
    deep_model: str = Field("gemini-4-argon", title="Review model", description="The Gemini model that reviews what passed, before it is raised.")

    # -- the first pass, in BigQuery ------------------------------------------------------------------------------
    doc_guidelines: str = Field("Strictly enforce all Process Doc hard mandates without override.", title="What Gemini is told about the process document", description="What Gemini is told about the process document's rules.")
    discovery_guidelines: str = Field("Surface coordinated velocity anomalies, executive safety threats, and novel brand safety risks.",
                                      title="What Gemini looks for in a story", description="What Gemini is told to look for in a story no rule covers.")
    single_min_score: float = Field(0.65, ge=0, le=1, title="Score a post needs", description="A post checked against a rule goes to review at this risk score or above.")
    story_min_score: float = Field(0.65, ge=0, le=1, title="Score a story needs", description="A story goes to review at this rank or above.")
    cos_threshold: float = Field(0.22, ge=0.01, le=1, title="How alike posts in a story must be", description="A post joins a story when it is this close to it or closer (cosine distance; smaller is closer).")
    min_vel_ratio: float = Field(1.5, ge=0, le=100, title="Pace a story must reach", description="A story is looked at when its last 15 minutes run at this many times its hourly pace.")
    min_story_posts: int = Field(3, ge=1, le=1000, title="Posts a story needs in 15 minutes", description="...and it has at least this many posts in those 15 minutes.")
    cooldown_minutes: int = Field(120, ge=1, le=10080, title="Minutes before a story is looked at again", description="A story that was raised, or looked at and passed over, is not looked at again for this long.")
    regrowth: float = Field(2.0, ge=1.1, le=100, title="Growth that brings a story back sooner", description="...unless it has grown to this many times the posts it had when it was last looked at.")
    story_snippets: int = Field(8, ge=1, le=50, title="Posts of a story Gemini is shown", description="How many of a story's posts Gemini is shown.")
    story_active_hours: int = Field(24, ge=1, le=168, title="Hours a story stays open", description="A story takes new posts for this many hours after its last one.")
    neighbours: int = Field(50, ge=2, le=500, title="Closest posts compared", description="How many of a new post's closest new posts are looked at when posts start a story together.")
    catch_up_hours: int = Field(6, ge=1, le=72, title="Hours made up after an outage", description="After an outage, posts up to this many hours old are still checked.")

    # -- the review -----------------------------------------------------------------------------------------------
    review_engine: Literal["agent_runtime", "worker"] = Field("agent_runtime", title="Where the review runs", description="Where the review runs: on the Agent Runtime (the worker takes over when it cannot be reached), or always in the worker.")
    reviews_per_minute: int = Field(25, ge=1, le=200, description="The most posts and stories reviewed each minute.")
    review_seconds: int = Field(45, ge=5, le=600, title="Seconds a run may start reviews", description="A run stops starting new reviews after this many seconds. The rest wait for the next minute.")
    runtime_timeout_seconds: int = Field(60, ge=5, le=300, title="Seconds the Agent Runtime is given", description="How long the Agent Runtime is given to answer one review before the worker reviews it.")
    precedents: int = Field(10, ge=0, le=50, title="Earlier verdicts shown", description="How many earlier decisions with an analyst's verdict are shown to the reviewer, the most alike first.")
    precedent_days: int = Field(60, ge=1, le=365, title="Days of earlier verdicts", description="Only decisions this recent are shown.")
    severities: list[str] = Field(default_factory=lambda: ["P0", "P1", "P2"], description="The severities the review may give, the most severe first.")
    escalation_paths: list[str] = Field(default_factory=lambda: ["EXEC_SECURITY", "PR_COMMS", "LEGAL", "BRAND_SOCIAL"], title="Who an alert can go to", description="Who an alert may be routed to.")
    default_severity: str = Field("P1", title="Severity when none is given", description="The severity used when neither a rule nor the review gives one.")
    default_path: str = Field("BRAND_SOCIAL", title="Goes to, when none is given", description="The path used when neither a rule nor the review gives one.")

    # -- raising and following up ---------------------------------------------------------------------------------
    post_target: Literal["", "clean", "youtube", "doodle", "team", "crisis"] = Field(
        "", title="Space alerts are posted in", description="The space raised alerts are posted in. Blank = shown in the Console only. The source space cannot be chosen.")
    links_shown: int = Field(5, ge=1, le=20, title="Links on a story's alert", description="How many of a story's posts are linked in its alert.")
    surge_min_minutes: int = Field(30, ge=1, le=1440, title="Follow-up: soonest, minutes after the alert", description="Follow-up: a raised story is looked at again no sooner than this after its alert...")
    surge_max_hours: int = Field(4, ge=1, le=72, title="Follow-up: latest, hours after the alert", description="...and no later than this.")
    surge_min_posts: int = Field(25, ge=1, le=100000, title="Follow-up: posts in 15 minutes", description="Follow-up: it needs at least this many posts in its last 15 minutes...")
    surge_ratio: float = Field(3.0, ge=1, le=100, title="Follow-up: pace", description="...running at this many times its hourly pace.")
    console_keep_days: int = Field(30, ge=1, le=30, title="Days alerts stay in the Console", description="How long raised alerts stay on the Agent alerts page.")

    @model_validator(mode="after")
    def _fallbacks_are_allowed(self) -> "OwnAlertsConfig":
        if self.default_severity not in self.severities:
            raise ValueError("The fallback severity must be one of the severities.")
        if self.default_path not in self.escalation_paths:
            raise ValueError("The fallback path must be one of the escalation paths.")
        return self


class PlatformConfig(ConfigModel):
    access: AccessConfig = Field(default_factory=AccessConfig)
    flags: FeatureFlags = Field(default_factory=FeatureFlags)
    gcp: GcpConfig = Field(default_factory=GcpConfig)
    pubsub: PubSubConfig = Field(default_factory=PubSubConfig)
    bigquery: BigQueryConfig = Field(default_factory=BigQueryConfig)
    forecasting: ForecastingConfig = Field(default_factory=ForecastingConfig)
    chat_agent: ChatAgentConfig = Field(default_factory=ChatAgentConfig)
    classification: ClassificationConfig = Field(default_factory=ClassificationConfig)
    knowledge: KnowledgeRagConfig = Field(default_factory=KnowledgeRagConfig)
    temp_check: TempCheckConfig = Field(default_factory=TempCheckConfig)
    costs: CostConfig = Field(default_factory=CostConfig)
    telemetry: TelemetryConfig = Field(default_factory=TelemetryConfig)
    stories: StoriesConfig = Field(default_factory=StoriesConfig)
    notifications: NotificationsConfig = Field(default_factory=NotificationsConfig)
    safety: SafetyConfig = Field(default_factory=SafetyConfig)
    routing: RoutingConfig = Field(default_factory=RoutingConfig)
    decisions: DecisionsConfig = Field(default_factory=DecisionsConfig)
    early: EarlyConfig = Field(default_factory=EarlyConfig)
    own_alerts: OwnAlertsConfig = Field(default_factory=OwnAlertsConfig)
    campaigns: CampaignsConfig = Field(default_factory=CampaignsConfig)

    def flag(self, name: str) -> bool:
        return bool(getattr(self.flags, name, False))


def space_id_of(value: str | None) -> str | None:
    """Bare (lower-cased) space id from spaces/ID, ID, a room URL (…/room/ID?cls=…) or a Gmail chat URL
    (…#chat/space/ID). None for display names and other URLs."""
    v = (value or "").strip()
    if not v:
        return None
    for marker in ("/room/", "#chat/space/", "/chat/space/"):
        if marker in v:
            v = v.split(marker, 1)[1]
            break
    else:
        if v.lower().startswith("spaces/"):
            v = v[len("spaces/"):]
        elif "://" in v or " " in v:
            return None
    v = v.split("?", 1)[0].split("#", 1)[0].split("/", 1)[0]
    return v.lower() or None


class AgentConfig(ConfigModel):
    version: str = "dev"
    env: Literal["dev", "prod"] = "dev"
    timezone: str = "America/New_York"  # display timezone for chat messages
    case_id_prefix: str = "TRG"
    escalation_id_prefix: str = "ESC"
    agent: AgentIdentity = Field(default_factory=AgentIdentity)
    spaces: list[SpaceRef] = Field(default_factory=list)
    analysts: list[Analyst] = Field(default_factory=list)
    shifts: list[Shift] = Field(default_factory=list)
    alert_template: AlertTemplate = Field(default_factory=AlertTemplate)
    collection: CollectionRequirements = Field(default_factory=CollectionRequirements)
    distribution: Distribution = Field(default_factory=Distribution)
    protocols: Protocols = Field(default_factory=Protocols)
    actions: list[ActionDef] = Field(default_factory=list)
    reference_lists: dict[str, Any] = Field(default_factory=dict)
    thresholds: Thresholds = Field(default_factory=Thresholds)
    corrections: CorrectionPolicy = Field(default_factory=CorrectionPolicy)
    burson_feedback: BursonFeedback = Field(default_factory=BursonFeedback)
    burson_qa: BursonQAConfig = Field(default_factory=BursonQAConfig)
    sonar_lookup: SonarLookup = Field(default_factory=SonarLookup)
    inhouse: InhouseSource = Field(default_factory=InhouseSource)
    outbox: OutboxSettings = Field(default_factory=OutboxSettings)
    handover: HandoverConfig = Field(default_factory=HandoverConfig)
    metrics: MetricsConfig = Field(default_factory=MetricsConfig)
    models: ModelConfig = Field(default_factory=ModelConfig)
    stakeholders: list[Stakeholder] = Field(default_factory=list)
    escalation: EscalationConfig = Field(default_factory=EscalationConfig)
    tns: TnsConfig = Field(default_factory=TnsConfig)
    watchdog: WatchdogConfig = Field(default_factory=WatchdogConfig)
    knowledge: KnowledgeConfig = Field(default_factory=KnowledgeConfig)
    seed_rosters: dict[str, Roster] = Field(default_factory=dict)  # "slrr_im", "burson"; seeds an empty store
    platform: PlatformConfig = Field(default_factory=PlatformConfig)  # Console-managed: connections, switches, models

    # -- helpers -------------------------------------------------------------
    def config_version(self) -> str:
        """Human version + short content hash, recorded on every event."""
        payload = self.model_dump(
            mode="json",
            exclude={"seed_rosters": True, "distribution": {"channel_owners"}},
        )
        digest = hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()[:8]
        return f"{self.version}+{digest}"

    def space(self, key: str) -> SpaceRef | None:
        return next((s for s in self.spaces if s.key == key), None)

    def space_key_for(self, space_id: str | None, space_name: str | None) -> str | None:
        """Which configured space a message came from: id first, then display name.

        Either argument may hold a resource name (spaces/ID), a bare id, a room URL or a display
        name (Studio exposes "Space (id or name)")."""
        ids = {i for i in (space_id_of(space_id), space_id_of(space_name)) if i}
        if ids:
            for s in self.spaces:
                if (s.space_id and space_id_of(s.space_id) in ids) or (s.url and space_id_of(s.url) in ids):
                    return s.key
        for value in (space_name, space_id):
            if value:
                for s in self.spaces:
                    if s.display_name.strip().lower() == value.strip().lower():
                        return s.key
        return None

    def action(self, emoji_or_code: str) -> ActionDef | None:
        key = _strip_variation(emoji_or_code)
        return next((a for a in self.actions
                     if _strip_variation(a.emoji) == key or a.code.lower() == key.strip().lower()), None)

    def analyst(self, email: str | None) -> Analyst | None:
        key = (email or "").strip().lower()
        return next((a for a in self.analysts if a.email.lower() == key), None)

    def analyst_emails(self) -> list[str]:
        return [a.email for a in self.analysts]

    def admin_emails(self) -> list[str]:
        return [a.email for a in self.analysts if a.role == "admin"]

    def lead_emails(self) -> list[str]:
        return [a.email for a in self.analysts if a.role in ("lead", "admin")]


def _strip_variation(value: str | None) -> str:
    """Normalize emoji for comparison (drop variation selectors / keycap combiners, trim)."""
    return (value or "").strip().replace("\ufe0f", "").replace("\u20e3", "")


# ---------------------------------------------------------------------------
# Loading
# ---------------------------------------------------------------------------


def deep_merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    """RFC 7386-style merge: dicts merge recursively, None deletes, lists replace."""
    out = copy.deepcopy(base)
    for key, value in (override or {}).items():
        if value is None:
            out.pop(key, None)
        elif isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = deep_merge(out[key], value)
        else:
            out[key] = copy.deepcopy(value)
    return out


_DEFAULT_RAW_CACHE: dict[tuple[str, str], dict[str, Any]] = {}


def load_default_dict(path: str | Path | None = None) -> dict[str, Any]:
    path = Path(path or os.environ.get("TRIAGE_CONFIG_PATH") or DEFAULT_CONFIG_PATH)
    dist_path = Path(os.environ.get("TRIAGE_DISTRIBUTION_PATH") or path.parent / DISTRIBUTION_PATH.name)
    cache_key = (str(path.resolve()), str(dist_path.resolve()))
    cached = _DEFAULT_RAW_CACHE.get(cache_key)
    if cached is not None:
        return copy.deepcopy(cached)
    with open(path, encoding="utf-8") as fh:
        data = yaml.safe_load(fh) or {}
    if "distribution" not in data and dist_path.exists():
        with open(dist_path, encoding="utf-8") as fh:
            data["distribution"] = yaml.safe_load(fh) or {}
    co_path = dist_path.parent / "channel_owners.json"
    if isinstance(data.get("distribution"), dict) and "channel_owners" not in data["distribution"] and co_path.exists():
        with open(co_path, encoding="utf-8") as fh:
            data["distribution"]["channel_owners"] = json.load(fh) or []
    _DEFAULT_RAW_CACHE[cache_key] = data
    return copy.deepcopy(data)


def load_config(store: Any | None = None, path: str | Path | None = None) -> AgentConfig:
    """Load the effective config (defaults + Console overrides from the store).

    A key the config models don't know fails the load (ConfigModel). One exception: settings saved in the store
    earlier (the Console and chat refuse unknown keys when they save) that this version no longer knows are ignored
    with a warning, as before, so removing a setting can't stop the agent, or the Console that would reset it. The
    YAML is always checked strictly."""
    defaults = load_default_dict(path)
    overrides = (store.get_config_overrides() or {}) if store is not None else {}
    data = deep_merge(defaults, overrides) if overrides else defaults
    env = os.environ.get("TRIAGE_ENV")
    if env:
        data["env"] = defaults["env"] = env
    def _validate(raw: dict[str, Any]) -> AgentConfig:
        try:
            return AgentConfig.model_validate(raw)
        except ValidationError as exc:
            unknown = [e for e in exc.errors() if e.get("type") == "extra_forbidden"]
            if not overrides or len(unknown) != len(exc.errors()):
                raise
            AgentConfig.model_validate(defaults)  # raises when the YAML has them: that must be fixed, not ignored
            log.warning("saved config overrides have settings this version doesn't know, ignored: %s",
                        ", ".join(".".join(str(p) for p in e.get("loc", ())) for e in unknown))
            return AgentConfig.model_validate(raw, extra="ignore")

    cfg = _validate(data)
    should_fetch = (
        os.environ.get("SLRR_FETCH_SHEET_GROUPS") == "1"
        or (
            os.environ.get("TRIAGE_BACKEND") == "gcp"
            and os.environ.get("SLRR_FETCH_SHEET_GROUPS") != "0"
        )
    )
    if should_fetch:
        from .brand_safety_groups import apply_brand_safety_groups, fetch_workbook_email_config

        try:
            rows, raw_testers = fetch_workbook_email_config()
            apply_brand_safety_groups(cfg, rows, raw_testers=raw_testers)
        except Exception as exc:  # noqa: BLE001
            log.warning("could not load Brand safety groups from Google Sheets: %s", exc)
    return cfg
