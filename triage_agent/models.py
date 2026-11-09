"""Shared data models for the SLRR alert triage agent.

Every component (agent core, Workspace Studio add-on contract, Agent Console)
uses these models. Keep them backwards compatible: add optional fields rather
than renaming or removing existing ones. See docs/CONTRACTS.md.
"""

from datetime import datetime, timezone
from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, Field, computed_field


def utcnow() -> datetime:
    """Timezone-aware UTC now (single place so tests can monkeypatch)."""
    return datetime.now(timezone.utc)


# ---------------------------------------------------------------------------
# Chat input (normalized from Workspace Studio starter variables)
# ---------------------------------------------------------------------------


class ChatUser(BaseModel):
    name: str | None = None  # display name
    email: str | None = None
    type: Literal["HUMAN", "BOT", "UNKNOWN"] = "UNKNOWN"


class ChatMessage(BaseModel):
    """A Chat message as passed in by a Studio custom step (or a test/batch).

    Studio exposes starter variables whose exact names are confirmed during the
    Phase 0 spike; the add-on maps them onto this shape.
    """

    message_id: str | None = None  # stable id or link exposed by Studio
    text: str
    sender: ChatUser = Field(default_factory=ChatUser)
    space_id: str | None = None
    space_name: str | None = None
    thread_id: str | None = None
    link: str | None = None
    create_time: datetime | None = None
    conversation_type: Literal["SPACE", "DM", "UNKNOWN"] = "UNKNOWN"


# ---------------------------------------------------------------------------
# Triage
# ---------------------------------------------------------------------------


class Verdict(str, Enum):
    PASS = "PASS"  # correct as received -> clean space
    CORRECTED = "CORRECTED"  # alertable after high-confidence auto-corrections -> clean space
    SUPPRESSED = "SUPPRESSED"  # doesn't meet the Collection Requirements -> logged, not posted
    NEEDS_REVIEW = "NEEDS_REVIEW"  # low confidence / conflicting -> IM on shift decides
    FAIL = "FAIL"  # unfixable source data -> bounce to the Burson on-call ("needs Burson")


class Severity(str, Enum):
    BLOCKING = "blocking"
    WARNING = "warning"


class IssueSource(str, Enum):
    PARSER = "parser"
    RULE = "rule"
    REFERENCE = "reference"
    LLM = "llm"


class Issue(BaseModel):
    """One problem found in an alert. Unfixable blocking issues are rendered to the Burson on-call."""

    field: str | None = None
    rule: str  # machine code, e.g. "required", "not_in_future", "llm:summary_mismatch"
    severity: Severity = Severity.BLOCKING
    found: str | None = None
    expected: str | None = None
    fix: str | None = None  # human instruction
    source: IssueSource = IssueSource.RULE
    confidence: float = 1.0


class ParsedAlert(BaseModel):
    template_id: str
    fields: dict[str, Any] = Field(default_factory=dict)
    raw_text: str
    parse_method: Literal["template", "llm", "structured"] = "template"  # structured = in-house / Watchdog row
    unmatched_lines: list[str] = Field(default_factory=list)
    missing_labels: list[str] = Field(default_factory=list)
    looks_like_alert: bool = True  # False => not a Zapier alert (ignore / treat as chat)
    flags: dict[str, bool] = Field(default_factory=dict)  # alert_template.flag_patterns hits, e.g. meets_p0
    extra: dict[str, Any] = Field(default_factory=dict)  # source context (Sonar relevance, language, transcript…)


class Correction(BaseModel):
    """A field the agent fixed instead of asking Burson to correct + retrigger."""

    field: str
    old: Any = None
    new: Any = None
    reason: str = ""
    confidence: float = 1.0
    source: IssueSource = IssueSource.RULE
    applied: bool = True  # False => proposed only (below auto-apply threshold; IM confirms)
    reverted_by: str | None = None  # IM reverted it (Console / chat)


class RecipientPlan(BaseModel):
    to: list[str] = Field(default_factory=list)
    cc: list[str] = Field(default_factory=list)
    groups: list[str] = Field(default_factory=list)  # e.g. "Gemini App", "AI Overviews 2K+", "Civics"
    reasons: dict[str, str] = Field(default_factory=dict)  # group -> why it was included
    missing: list[str] = Field(default_factory=list)  # groups that matched but have no recipients (placeholders)
    notes: list[str] = Field(default_factory=list)  # e.g. "Gemini App Execs not added (rule: suggest)"


class AlertAssessment(BaseModel):
    """Everything the IM used to work out by hand (and type into the SLRR Alert Assistant)."""

    track: Literal["URGENT", "HIGH_ENGAGEMENT"] | None = None
    alert_action: Literal["EMAIL_ALERT", "YOUTUBE_CHAT_ONLY"] | None = None  # same values as brand_safety_alert_log
    reason_codes: list[str] = Field(default_factory=list)  # P0_TOPIC, SENSITIVE_TOPIC, KOF, HIGH_ENGAGEMENT, EXCLUDED_*…
    issue_status: Literal["NEW", "ONGOING"] | None = None
    issue_name: str | None = None
    issue_fingerprint: str | None = None
    related_case_id: str | None = None  # ongoing issue -> case whose email thread to reply on
    priority: Literal["P0", "P1", "P2"] | None = None
    exposure_tag: str | None = None
    product: str | None = None  # distro name (after redirects / reclassification)
    sensitive_topics: list[str] = Field(default_factory=list)
    briefed_topics: list[str] = Field(default_factory=list)  # briefed launches treated as Sensitive Topics
    risk_topics: list[str] = Field(default_factory=list)  # every Sensitive Topic on the alert (routing), incl. ones restating the tag
    is_kof: bool = False
    kof_lists: list[str] = Field(default_factory=list)
    engagement_total: int | None = None
    engagement_level: str | None = None  # VERY LOW | LOW | MODERATE | HIGH | VIRAL KOF
    platform: str | None = None
    platform_tier: str | None = None  # strong | partial | limited
    sla_minutes: int | None = None
    sla_due_at: datetime | None = None
    alertable: bool = True
    suppression_reason: str | None = None  # machine code, e.g. below_threshold, ongoing_no_kof, EXCLUDED_SPAM
    # manual inputs from the SLRR Alert Assistant
    sundar_mention: bool = False
    non_us_markets: list[str] = Field(default_factory=list)
    secondary_products: list[str] = Field(default_factory=list)
    owned_post: bool = False
    owned_profile_url: str | None = None
    video_timestamp: str | None = None
    video_timestamp_needed: bool = False
    # protocols
    youtube_subject: bool = False
    youtube_protocol: Literal["none", "chat_only", "email_and_ping", "sensitive_ping"] = "none"
    bias_allegation: bool = False
    doodle_protocol: bool = False
    leadership_protocol: bool = False
    ts_recommended: bool = False
    ts_reasons: list[str] = Field(default_factory=list)
    # routing
    suggested_actions: list[str] = Field(default_factory=list)  # emoji-legend action codes
    recipients: RecipientPlan | None = None


class TriageResult(BaseModel):
    verdict: Verdict
    confidence: float = 1.0
    issues: list[Issue] = Field(default_factory=list)  # blocking + warnings
    corrections: list[Correction] = Field(default_factory=list)
    assessment: AlertAssessment | None = None
    record_key: str | None = None
    normalized: dict[str, Any] = Field(default_factory=dict)  # fields AFTER corrections
    checks_run: list[str] = Field(default_factory=list)
    review_reasons: list[str] = Field(default_factory=list)  # why NEEDS_REVIEW
    extra: dict[str, Any] = Field(default_factory=dict)  # source context (ParsedAlert.extra) for re-evaluation
    flags: dict[str, bool] = Field(default_factory=dict)  # ParsedAlert.flags (e.g. meets_p0)
    model: str | None = None
    rules_version: str | None = None
    latency_ms: int = 0

    @property
    def blocking(self) -> list[Issue]:
        return [i for i in self.issues if i.severity == Severity.BLOCKING]

    @property
    def warnings(self) -> list[Issue]:
        return [i for i in self.issues if i.severity == Severity.WARNING]

    @property
    def applied_corrections(self) -> list[Correction]:
        return [c for c in self.corrections if c.applied and not c.reverted_by]

    @property
    def proposed_corrections(self) -> list[Correction]:
        return [c for c in self.corrections if not c.applied]


# ---------------------------------------------------------------------------
# Cases (one per alert record; reruns attach as new attempts)
# ---------------------------------------------------------------------------


class CaseStatus(str, Enum):
    VERIFIED = "VERIFIED"  # PASS/CORRECTED and posted to the clean space (IM actions pending/ongoing)
    FAILED = "FAILED"  # bounced to the Burson on-call (unfixable data); awaiting a rerun
    NEEDS_REVIEW = "NEEDS_REVIEW"  # waiting on the IM's forward/bounce decision
    SUPPRESSED = "SUPPRESSED"  # doesn't meet the Collection Requirements (logged only)
    CLOSED = "CLOSED"  # IM finished (❌ no action, or actions done) / superseded (⬇️)
    ABANDONED = "ABANDONED"  # no corrected rerun before the wait limit, or closed manually


class Attempt(BaseModel):
    attempt: int  # 1 = first submission, >1 = rerun / update
    message: ChatMessage
    received_at: datetime
    result: TriageResult


class OnCallNotice(BaseModel):
    kind: Literal["bounce", "reminder", "backup", "fallback", "analyst", "sla_risk"]
    to_email: str | None = None
    at: datetime


class ReviewDecision(BaseModel):
    decided_by: str
    decision: Literal["forward", "bounce", "suppress"]
    reason: str | None = None
    at: datetime


class ActionRecord(BaseModel):
    """An IM action from the emoji legend (👍 📦 ✍️ 📰 💬 🔥 … ❌)."""

    code: str  # config.actions[].code, e.g. "pa", "tns", "gup", "no_action"
    emoji: str
    actor: str
    at: datetime
    escalation_id: str | None = None
    note: str | None = None


CaseSource = Literal["burson_chat", "inhouse", "watchdog", "manual"]


class Case(BaseModel):
    case_id: str  # e.g. TRG-1042
    record_key: str | None = None
    source: CaseSource = "burson_chat"
    source_ref: str | None = None  # e.g. brand_safety_alert_log.alert_id or Watchdog email id
    status: CaseStatus
    # Denormalized from the latest attempt for Console filters + 14-day novelty lookups
    alert_name: str | None = None
    product: str | None = None
    exposure_tag: str | None = None
    priority: str | None = None
    track: str | None = None
    platform: str | None = None
    issue_name: str | None = None
    issue_fingerprint: str | None = None
    attempts: list[Attempt] = Field(default_factory=list)
    oncall_notices: list[OnCallNotice] = Field(default_factory=list)
    current_oncall_email: str | None = None  # Burson on-call (FAILED) or IM (NEEDS_REVIEW / SLA)
    clean_posted_at: datetime | None = None  # = "alerted at" for the 14-day novelty rule
    clean_message_ref: str | None = None  # clean-space message id/link (record_post), for reaction lookup
    acknowledged_at: datetime | None = None  # first IM reaction (👍 or any action)
    sla_due_at: datetime | None = None
    sla_met: bool | None = None  # alert email sent before sla_due_at (set on email.sent)
    review: ReviewDecision | None = None
    actions: list[ActionRecord] = Field(default_factory=list)
    escalation_ids: list[str] = Field(default_factory=list)
    alert_email_message_ids: list[str] = Field(default_factory=list)  # RFC 822 ids of sent alert emails
    superseded_by: str | None = None  # ⬇️ addressed on updated post below
    counterpart_case_id: str | None = None  # parity: same post alerted by the other path (Burson vs in-house)
    leadership_pinged_at: datetime | None = None
    closed_reason: str | None = None
    verdict_overridden_by: str | None = None  # IM reacted 👎 (agent verdict/classification wrong)
    created_at: datetime
    updated_at: datetime
    env: str = "dev"

    @property
    def latest(self) -> Attempt | None:
        return self.attempts[-1] if self.attempts else None


# ---------------------------------------------------------------------------
# Escalations (email drafts + T&S form)
# ---------------------------------------------------------------------------

    @computed_field  # type: ignore[prop-decorator]
    @property
    def clean_message_key(self) -> str | None:
        """Last segment of clean_message_ref (stored so Store.find_case_by_message_ref can query it)."""
        from .ids import message_key

        return message_key(self.clean_message_ref)


class EmailStatus(str, Enum):
    DRAFTED = "DRAFTED"
    REVISION_REQUESTED = "REVISION_REQUESTED"
    REDRAFTED = "REDRAFTED"
    SENT = "SENT"
    DISCARDED = "DISCARDED"
    FAILED = "FAILED"  # e.g. IM has not connected Gmail


class DraftVersion(BaseModel):
    version: int
    subject: str
    to: list[str] = Field(default_factory=list)
    cc: list[str] = Field(default_factory=list)
    bcc: list[str] = Field(default_factory=list)  # escalation.recipients_in == "bcc"
    body: str
    instruction: str | None = None  # revision request that produced this version
    created_at: datetime


EmailPurpose = Literal["alert", "tns_urgent", "bug_followup", "group"]


class EmailState(BaseModel):
    purpose: EmailPurpose = "alert"
    status: EmailStatus
    from_alias: str | None = None  # e.g. "Brand Social" or configured From header
    groups: list[str] = Field(default_factory=list)  # distro groups included (routing audit)
    draft_id: str | None = None
    message_id: str | None = None  # Gmail API message id
    thread_id: str | None = None  # Gmail API thread id (in the drafting IM's mailbox)
    rfc822_message_id: str | None = None  # Message-ID header of the sent email
    in_reply_to: str | None = None  # Ongoing issue: Message-ID of the original alert email
    versions: list[DraftVersion] = Field(default_factory=list)
    revision_requests: int = 0
    drafted_at: datetime | None = None
    sent_at: datetime | None = None
    error: str | None = None


class TnsStatus(str, Enum):
    ASSESSED = "ASSESSED"
    NOT_ELIGIBLE = "NOT_ELIGIBLE"
    PREPARED = "PREPARED"
    SUBMITTED = "SUBMITTED"
    WITHDRAWN = "WITHDRAWN"


class TnsState(BaseModel):
    status: TnsStatus
    eligible: bool = False
    urgent: bool = False  # viral/significant -> also email the T&S urgent alias
    category: str | None = None
    rationale: str = ""
    criteria_ids: list[str] = Field(default_factory=list)
    evidence: Literal["input_shown", "replicable", "none"] | None = None
    fields: dict[str, str] = Field(default_factory=dict)  # form entry id -> value
    prefill_url: str | None = None
    truncated_fields: list[str] = Field(default_factory=list)
    prepared_at: datetime | None = None
    submitted_at: datetime | None = None
    submitted_by: str | None = None
    wd_issue_id: str | None = None  # "Issue [#######]: WD Intake Request"
    outcome: Literal["Fixed", "Infeasible"] | None = None
    outcome_at: datetime | None = None
    bug_id: str | None = None  # go/Bad bug id
    bug_followup_sent_at: datetime | None = None


class Escalation(BaseModel):
    escalation_id: str  # e.g. ESC-1207
    case_id: str
    analyst_email: str  # IM whose Gmail holds the drafts
    requested_at: datetime
    requested_by: str | None = None  # IM email, or "agent" (URGENT auto-draft)
    trigger: Literal["auto_urgent", "reaction", "chat", "console", "email"] = "reaction"
    emails: list[EmailState] = Field(default_factory=list)
    tns: TnsState | None = None
    chat_message_ref: str | None = None  # clean-space message the action emoji was placed on
    updated_at: datetime
    env: str = "dev"

    def email_for(self, purpose: str) -> EmailState | None:
        """Most recent email with this purpose."""
        matches = [e for e in self.emails if e.purpose == purpose]
        return matches[-1] if matches else None


# ---------------------------------------------------------------------------
# Rosters: "slrr_im" (Incident Manager shifts) and "burson" (Burson on-call)
# ---------------------------------------------------------------------------

Weekday = Literal["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
RosterName = Literal["slrr_im", "burson"]


class Person(BaseModel):
    id: str
    name: str
    email: str
    org: str = "burson"


class RotationSlot(BaseModel):
    """Weekly recurring coverage. If end <= start, the slot spans midnight."""

    person_id: str
    days: list[Weekday]
    start: str = "09:00"  # HH:MM local to tz
    end: str = "18:00"
    tz: str = "America/New_York"


class Override(BaseModel):
    override_id: str
    person_id: str
    start: datetime
    end: datetime
    reason: str | None = None
    set_by: str
    set_via: Literal["console", "chat"] = "console"
    created_at: datetime


class ReminderPolicy(BaseModel):
    reping_after_min: int = 30
    backup_after_min: int = 60
    notify_analyst_after_min: int = 120
    max_reminders: int = 2


class Roster(BaseModel):
    people: list[Person] = Field(default_factory=list)
    rotation: list[RotationSlot] = Field(default_factory=list)
    overrides: list[Override] = Field(default_factory=list)
    backup_person_id: str | None = None
    fallback: Person | None = None
    reminders: ReminderPolicy = Field(default_factory=ReminderPolicy)
    updated_at: datetime | None = None
    updated_by: str | None = None


class OnCallResolution(BaseModel):
    person: Person | None = None
    source: Literal["override", "rotation", "backup", "fallback", "none"] = "none"
    until: datetime | None = None


# ---------------------------------------------------------------------------
# Learning / configuration changes proposed via chat
# ---------------------------------------------------------------------------


class ProposalStatus(str, Enum):
    PENDING = "PENDING"
    APPROVED = "APPROVED"
    REJECTED = "REJECTED"


class ConfigChangeProposal(BaseModel):
    proposal_id: str
    proposed_by: str
    via: Literal["chat", "console"] = "chat"
    summary: str
    patch: dict[str, Any] = Field(default_factory=dict)  # JSON merge patch against AgentConfig
    status: ProposalStatus = ProposalStatus.PENDING
    created_at: datetime
    decided_by: str | None = None
    decided_at: datetime | None = None


class KnowledgeFact(BaseModel):
    """A fact taught in chat ("remember that…"). Used only once APPROVED."""

    fact_id: str
    text: str
    source: str  # who taught it / where
    status: ProposalStatus = ProposalStatus.PENDING
    created_by: str
    created_at: datetime
    decided_by: str | None = None
    decided_at: datetime | None = None


# ---------------------------------------------------------------------------
# Outbox: chat posts that don't originate in a Studio run (jobs: SLA timers,
# reminders, in-house alerts, handovers, digests; Console decisions; email
# ingestion follow-ups). There is no Chat API, so the Studio "Outbox" flow
# delivers them (op drain_outbox). It starts when the agent appends a doorbell
# row to the Agent Outbox Sheet ("When a sheet changes"); flows that are
# already running also piggyback queued items (config.outbox.piggyback).
# ---------------------------------------------------------------------------

# Chat targets. Every space target is a space the Triage Agent account belongs to,
# with its own "Post in a space" step in the flows (space chosen at design time).
# "handover" is not a space: the Outbox flow appends it to the Handover doc ("Add to a doc").
OutboxTarget = Literal["burson", "clean", "dm", "youtube", "doodle", "team", "crisis", "handover"]
SPACE_TARGETS: tuple[str, ...] = ("burson", "clean", "youtube", "doodle", "team", "crisis")


class OutboxItem(BaseModel):
    outbox_id: str
    target: OutboxTarget
    text: str
    recipients: list[str] = Field(default_factory=list)  # dm only (emails)
    case_id: str | None = None
    escalation_id: str | None = None
    source: str = "agent"  # op or subsystem that queued it
    created_at: datetime
    delivered_at: datetime | None = None
    delivered_by: str | None = None  # op/flow that returned it to Studio
    env: str = "dev"


# ---------------------------------------------------------------------------
# Analytics event (BigQuery `agent_events`, local SQLite in dev)
# ---------------------------------------------------------------------------

SpaceKind = Literal[
    "burson", "clean", "dm", "youtube", "doodle", "team", "crisis", "handover", "shadow",
    "stakeholder", "email", "console", "system",
]


class AgentEvent(BaseModel):
    event_id: str
    event_ts: datetime
    event_type: str  # see triage_agent.events.EventType
    env: str = "dev"
    case_id: str | None = None
    escalation_id: str | None = None
    actor: str = "agent"  # "agent" or a user email
    space: SpaceKind | None = None
    message_ref: str | None = None
    attempt: int | None = None
    verdict: str | None = None
    error_codes: list[str] = Field(default_factory=list)
    latency_ms: int | None = None
    model: str | None = None
    prompt_version: str | None = None
    config_version: str | None = None
    payload: dict[str, Any] = Field(default_factory=dict)


# ---------------------------------------------------------------------------
# Operations API (Studio custom step / Agent Console / jobs -> Agent Engine `query`)
# ---------------------------------------------------------------------------

OperationName = Literal[
    # invoked by Workspace Studio custom steps
    "triage_message",  # Burson chat alert (Path A)
    "start_escalation",  # legacy alias of record_reaction for the 📦 action
    "converse",
    "record_reaction",  # emoji legend actions + feedback
    "record_post",  # optional: remember the message id/link of a post the flow just made
    "ingest_email",  # WD intake / Watchdog / T&S outcome emails (agent account inbox)
    "drain_outbox",  # Outbox flow (doorbell sheet starter): deliver queued posts
    "health",
    # invoked by jobs (Cloud Scheduler -> Cloud Run job); delivered through the outbox
    "run_followups",  # SLA timers, Burson reminders, sent detection, digest, handover
    "generate_handover",
    "ingest_inhouse",  # brand_safety_alert_outbox rows (Path B)
    # invoked by the Agent Console (delivered through the outbox)
    "review_decision",
    "revert_correction",
    "close_case",
    "decide_proposal",
    "decide_fact",
]

# Uniform output variables returned to EVERY Studio flow. A flow adds one
# "Check if <flag> is yes" block per target it needs (see flows/FLOW_SETUP.md):
#   has_reply    -> "Reply to a message" (clean space / DM only; Burson-space replies
#                   need owner approval because external users are present)
#   has_burson   -> "Post in a space" Burson space ("Notify space members" ON)
#   has_clean    -> "Post in a space" clean triage space
#   has_dm       -> "Send a message" to dm_recipients
#   has_youtube  -> "Post in a space" [S-F] YouTube Social (YouTube protocol)
#   has_doodle   -> "Post in a space" Doodle Team (Doodle protocol)
#   has_team     -> "Post in a space" 24/7 SL team chat (handover, SLA risk)
#   has_crisis   -> "Post in a space" crisis chat (🔥)
#   has_handover -> "Add to a doc" Handover doc (Outbox flow only)
STUDIO_OUTPUT_KEYS = (
    "has_reply", "reply_text",
    "has_burson", "burson_text",
    "has_clean", "clean_text",
    "has_dm", "dm_text", "dm_recipients",
    "has_youtube", "youtube_text",
    "has_doodle", "doodle_text",
    "has_team", "team_text",
    "has_crisis", "crisis_text",
    "has_handover", "handover_text",
    "case_id", "escalation_id", "verdict", "summary",
)


class RequestContext(BaseModel):
    invoked_by: str | None = None  # flow owner (Triage Agent account), Console user, or job
    flow: str | None = None  # e.g. "triage", "actions", "converse", "email", "outbox", "console", "job"
    run_id: str | None = None
    env: str | None = None
    # "return": chat output goes in `outputs` for the calling Studio flow to post now.
    # "outbox": chat output is queued (Console calls, jobs) for the Outbox flow.
    deliver: Literal["return", "outbox"] = "return"
    # Targets the calling flow has post steps for (e.g. ["reply", "clean", "dm"]); None = all.
    # Outputs for other targets are queued in the outbox instead of being dropped.
    targets: list[str] | None = None


class OperationRequest(BaseModel):
    op: str  # an OperationName; validated against the handler registry at dispatch
    payload: dict[str, Any] = Field(default_factory=dict)
    context: RequestContext = Field(default_factory=RequestContext)


class ReactionEvent(BaseModel):
    """Payload of record_reaction / start_escalation (Studio "When an emoji reaction is added")."""

    emoji: str
    user: ChatUser = Field(default_factory=ChatUser)
    message: ChatMessage  # the reacted message (text may be empty if Studio only exposes the id/link)


class InboundEmail(BaseModel):
    """Payload of ingest_email (Studio "When I get an email" on the Triage Agent account)."""

    subject: str = ""
    from_email: str | None = None
    from_name: str | None = None
    to: list[str] = Field(default_factory=list)
    cc: list[str] = Field(default_factory=list)
    body: str = ""  # plain text (Studio's email-body variable)
    message_id: str | None = None  # Gmail id or RFC 822 Message-ID if exposed
    thread_id: str | None = None
    received_at: datetime | None = None
    link: str | None = None


class ChatOutputs(BaseModel):
    """What the agent wants posted. Converted to flat Studio variables."""

    reply_text: str = ""
    burson_text: str = ""
    clean_text: str = ""
    dm_text: str = ""
    dm_recipients: list[str] = Field(default_factory=list)
    youtube_text: str = ""
    doodle_text: str = ""
    team_text: str = ""
    crisis_text: str = ""
    handover_text: str = ""
    case_id: str = ""
    escalation_id: str = ""
    verdict: str = ""
    summary: str = ""  # one-line description of what the agent did (for logs/Studio)

    def merge(self, other: "ChatOutputs") -> "ChatOutputs":
        """Combine two outputs (texts joined with a blank line; ids keep the first non-empty)."""

        def join(a: str, b: str) -> str:
            return "\n\n".join(t for t in (a.strip(), b.strip()) if t)

        return ChatOutputs(
            reply_text=join(self.reply_text, other.reply_text),
            burson_text=join(self.burson_text, other.burson_text),
            clean_text=join(self.clean_text, other.clean_text),
            dm_text=join(self.dm_text, other.dm_text),
            dm_recipients=list(dict.fromkeys(self.dm_recipients + other.dm_recipients)),
            youtube_text=join(self.youtube_text, other.youtube_text),
            doodle_text=join(self.doodle_text, other.doodle_text),
            team_text=join(self.team_text, other.team_text),
            crisis_text=join(self.crisis_text, other.crisis_text),
            handover_text=join(self.handover_text, other.handover_text),
            case_id=self.case_id or other.case_id,
            escalation_id=self.escalation_id or other.escalation_id,
            verdict=self.verdict or other.verdict,
            summary="; ".join(s for s in (self.summary, other.summary) if s),
        )

    def target_texts(self) -> dict[str, str]:
        """Non-empty texts keyed by OutboxTarget (space targets + handover; dm handled separately)."""
        texts = {
            "burson": self.burson_text, "clean": self.clean_text, "youtube": self.youtube_text,
            "doodle": self.doodle_text, "team": self.team_text, "crisis": self.crisis_text,
            "handover": self.handover_text,
        }
        return {k: v for k, v in texts.items() if v.strip()}

    def set_target(self, target: str, text: str) -> None:
        """Set the text for an OutboxTarget other than dm (inverse of target_texts)."""
        setattr(self, f"{target}_text", text)

    def is_empty(self) -> bool:
        return not (self.reply_text.strip() or self.target_texts() or (self.dm_text.strip() and self.dm_recipients))

    def to_studio(self) -> dict[str, str]:
        def flag(text: str) -> str:
            return "yes" if text.strip() else "no"

        return {
            "has_reply": flag(self.reply_text),
            "reply_text": self.reply_text,
            "has_burson": flag(self.burson_text),
            "burson_text": self.burson_text,
            "has_clean": flag(self.clean_text),
            "clean_text": self.clean_text,
            "has_dm": "yes" if (self.dm_text.strip() and self.dm_recipients) else "no",
            "dm_text": self.dm_text,
            "dm_recipients": ",".join(self.dm_recipients),
            "has_youtube": flag(self.youtube_text),
            "youtube_text": self.youtube_text,
            "has_doodle": flag(self.doodle_text),
            "doodle_text": self.doodle_text,
            "has_team": flag(self.team_text),
            "team_text": self.team_text,
            "has_crisis": flag(self.crisis_text),
            "crisis_text": self.crisis_text,
            "has_handover": flag(self.handover_text),
            "handover_text": self.handover_text,
            "case_id": self.case_id,
            "escalation_id": self.escalation_id,
            "verdict": self.verdict,
            "summary": self.summary,
        }


class OperationResponse(BaseModel):
    ok: bool = True
    op: str
    # Flat string map returned to Workspace Studio as output variables
    # (always contains every key in STUDIO_OUTPUT_KEYS).
    outputs: dict[str, str] = Field(default_factory=dict)
    # Structured details for logs, tests and the Console (not used by Studio).
    data: dict[str, Any] = Field(default_factory=dict)
    error: str | None = None
    retryable: bool = False
