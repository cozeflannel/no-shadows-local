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
from pydantic import BaseModel, ConfigDict, Field, ValidationError

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
    # What the Resources tab of the bot's sheet starts with: documents the bot links when Burson asks about the alert
    # requirements. After that the tab is what the bot uses (people edit it there). Only links Burson can open.
    resources: list[BursonResource] = Field(default_factory=list)


class SonarLookup(ConfigModel):
    """Optional ground truth: look up the Sonar record behind an alert (BigQuery)."""

    enabled: bool = True
    project: str = "brand-social-central-data"
    table: str = "bsip-s-bsip-gg-26-2cf3.google_bg.sonar_post_aggregates_7d_materialized"
    alert_log_table: str = "bsip-s-bsip-gg-26-2cf3.google_bg.collection_alerts"
    slrr_table: str = "brand-social-central-data.slrr_alerts.slrr_alerts"
    location: str = "us-central1"
    lookback_days: int = 7


class InhouseSource(ConfigModel):
    """Path B: in-house alerts from BigQuery (google_bg / slrr_alerts)."""

    enabled: bool = True
    project: str = "brand-social-central-data"
    outbox_view: str = "brand-social-central-data.slrr_alerts.slrr_source_mirror"
    alert_log_table: str = "brand-social-central-data.slrr_alerts.slrr_alerts"
    sonar_table: str = "bsip-s-bsip-gg-26-2cf3.google_bg.sonar_post_aggregates_7d_materialized"
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
