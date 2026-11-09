"""Typed domain, state, conversation, and API payload models for slrr-campaigns."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

AllowedFrequency = Literal[5, 15, 30, 60, 720, 1440, 10080]
SentimentValue = Literal["positive", "neutral", "negative"]
ThreadEntryTypeValue = Literal["post", "reply", "share"]
CampaignStatus = Literal["provisioning", "active", "paused", "closed", "failed"]
QueryOrigin = Literal["existing", "created"]


AlertTypeValue = Literal["scheduled", "instant"]


def _default_alert_types() -> list[AlertTypeValue]:
    return ["scheduled"]


def _default_sentiments() -> list[SentimentValue]:
    return ["positive", "neutral", "negative"]


class CustomAlertFilterPayload(BaseModel):
    """Typed Brandwatch Custom Alert filter holding only chosen documented fields."""

    model_config = ConfigDict(extra="forbid")

    pageType: list[str] | None = None
    threadEntryType: list[ThreadEntryTypeValue] | None = None
    sentiment: list[SentimentValue] | None = None

    def to_api_dict(self) -> dict[str, Any]:
        """Serialize only non-empty filter fields."""
        out: dict[str, Any] = {}
        if self.pageType:
            out["pageType"] = list(self.pageType)
        if self.threadEntryType:
            out["threadEntryType"] = list(self.threadEntryType)
        if self.sentiment:
            out["sentiment"] = list(self.sentiment)
        return out


class CustomAlertPayload(BaseModel):
    """Strict Brandwatch Custom Alert payload containing zero deprecated fields."""

    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1)
    queryIds: list[int] = Field(min_length=1)
    frequency: AllowedFrequency = 5
    alertTypes: list[AlertTypeValue] = Field(default_factory=_default_alert_types)
    mentionsPerAlert: int = Field(default=50, ge=0, le=50)
    recipients: list[str] = Field(min_length=1)
    filter: CustomAlertFilterPayload = Field(default_factory=CustomAlertFilterPayload)
    enabled: bool | None = None

    @model_validator(mode="after")
    def _validate_recipients(self) -> CustomAlertPayload:
        cleaned = [r.strip() for r in self.recipients if r.strip()]
        if not cleaned:
            raise ValueError("recipients must contain at least one email address")
        self.recipients = cleaned
        return self

    def to_api_dict(self) -> dict[str, Any]:
        """Produce exact JSON body for POST or PUT /projects/{projectId}/alerts."""
        body: dict[str, Any] = {
            "name": self.name,
            "queryIds": list(self.queryIds),
            "frequency": self.frequency,
            "alertTypes": list(self.alertTypes),
            "mentionsPerAlert": self.mentionsPerAlert,
            "recipients": list(self.recipients),
            "filter": self.filter.to_api_dict(),
        }
        if self.enabled is not None:
            body["enabled"] = self.enabled
        return body


class LocationFilterPayload(BaseModel):
    """Documented Brandwatch locationFilter object on queries and /query-validation."""

    model_config = ConfigDict(extra="forbid")

    includedLocations: list[str] = Field(default_factory=list)
    excludedLocations: list[str] = Field(default_factory=list)

    def to_api_dict(self) -> dict[str, list[str]]:
        return {
            "includedLocations": list(self.includedLocations),
            "excludedLocations": list(self.excludedLocations),
        }


class CreateQueryPayload(BaseModel):
    """Typed Brandwatch query creation payload with explicit startDate and lockedQuery."""

    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1)
    booleanQuery: str = Field(min_length=1)
    contentSources: list[str] = Field(default_factory=list)
    languages: list[str] = Field(default_factory=list)
    locationFilter: LocationFilterPayload | None = None
    startDate: str = Field(min_length=10)
    lockedQuery: bool = True
    exclusionSnippets: list[int] = Field(default_factory=list)
    description: str = Field(min_length=1)

    def to_api_dict(self) -> dict[str, Any]:
        body: dict[str, Any] = {
            "name": self.name,
            "booleanQuery": self.booleanQuery,
            "contentSources": list(self.contentSources),
            "languages": list(self.languages),
            "startDate": self.startDate,
            "lockedQuery": self.lockedQuery,
            "exclusionSnippets": list(self.exclusionSnippets),
            "description": self.description,
        }
        if self.locationFilter and (
            self.locationFilter.includedLocations or self.locationFilter.excludedLocations
        ):
            body["locationFilter"] = self.locationFilter.to_api_dict()
        return body


class RegistrySettings(BaseModel):
    """Operational people, defaults, and limits stored in the Registry Settings tab."""

    model_config = ConfigDict(extra="forbid")

    approver_emails: list[str] = Field(min_length=1)
    default_daily_cap: int = Field(ge=1)
    max_campaign_duration_days: int = Field(ge=1)
    per_tick_post_cap: int = Field(ge=1)
    exclusion_snippet_names: list[str] = Field(default_factory=list)


class ThreadOwnershipRecord(BaseModel):
    """Ownership record written by the alerts space app and consumed by slrr-campaigns."""

    model_config = ConfigDict(extra="ignore")

    space: str
    thread: str
    requester: str
    source_message: str
    source_text: str = ""
    alert_text: str = ""
    created_at: str
    handled_initial: bool = False


class CachedQuerySummary(BaseModel):
    """Cached Brandwatch query summary across accessible projects."""

    model_config = ConfigDict(extra="ignore")

    project_id: int
    project_name: str
    query_id: int
    name: str
    boolean_query: str = ""
    content_sources: list[str] = Field(default_factory=list)
    languages: list[str] = Field(default_factory=list)


class QueryBuilderDraft(BaseModel):
    """Answers collected during the interactive Brandwatch Query Builder."""

    model_config = ConfigDict(extra="forbid")

    short_name: str = ""
    core_terms: list[str] = Field(default_factory=list)
    context_proximity: str = ""
    alternate_phrases: list[str] = Field(default_factory=list)
    exclusions: list[str] = Field(default_factory=list)
    content_sources: list[str] = Field(default_factory=list)
    languages: list[str] = Field(default_factory=lambda: ["en"])
    locations: list[str] = Field(default_factory=list)
    start_date: str = ""
    daily_cap: int = 0
    boolean_query: str = ""
    validation_errors: list[str] = Field(default_factory=list)
    query_limit_usage: str = ""


class CampaignDraftSettings(BaseModel):
    """Campaign settings collected before provisioning."""

    model_config = ConfigDict(extra="forbid")

    base_space_name: str = ""
    member_emails: list[str] = Field(default_factory=list)
    member_users: list[str] = Field(default_factory=list)
    external_user_allowed: bool = False
    platforms: list[str] = Field(default_factory=list)
    post_types: list[ThreadEntryTypeValue] = Field(default_factory=list)
    sentiments: list[SentimentValue] = Field(default_factory=_default_sentiments)
    threshold: int = 200
    also_post_in_alerts_space: bool = False
    end_time_utc: str = ""


class ConversationState(BaseModel):
    """Per-thread conversation state persisted in Firestore."""

    model_config = ConfigDict(extra="ignore")

    thread: str
    space: str
    requester_user: str
    requester_email: str = ""
    flow: Literal["deep_dive", "campaign", "completed", "cancelled", "expired"]
    step: str
    clarifications_asked: int = 0
    last_prompted_at_utc: str
    alert_text: str = ""
    alert_name: str = ""
    deep_dive_days: int = 1
    campaign_id: str = ""
    project_id: int = 0
    project_name: str = ""
    candidate_queries: list[CachedQuerySummary] = Field(default_factory=list)
    selected_query_id: int = 0
    selected_query_name: str = ""
    query_origin: QueryOrigin = "existing"
    prefilled_filter: CustomAlertFilterPayload = Field(default_factory=CustomAlertFilterPayload)
    builder: QueryBuilderDraft = Field(default_factory=QueryBuilderDraft)
    approver_user: str = ""
    approver_email: str = ""
    settings: CampaignDraftSettings = Field(default_factory=CampaignDraftSettings)
    return_to_confirm: bool = False


class TopPostedMention(BaseModel):
    """Compact summary of a top posted mention for closing campaign summaries."""

    model_config = ConfigDict(extra="ignore")

    url: str
    author: str
    network: str
    engagement: int
    summary: str


class CampaignRecord(BaseModel):
    """Canonical campaign state stored in Firestore and projected onto the Registry tab."""

    model_config = ConfigDict(extra="ignore")

    campaign_id: str
    status: CampaignStatus
    close_reason: str = ""
    source_space: str
    source_thread: str
    requester_user: str
    requester_email: str = ""
    approver_user: str = ""
    approver_email: str = ""
    project_id: int
    query_id: int
    query_name: str
    query_origin: QueryOrigin
    query_limit_usage: str = ""
    alert_id: int = 0
    alert_name: str
    space_name: str = ""
    space_display_name: str = ""
    space_uri: str = ""
    external_user_allowed: bool = False
    space_history_state: str = ""
    member_users: list[str] = Field(default_factory=list)
    sheet_id: str = ""
    sheet_url: str = ""
    threshold: int = 200
    sentiments: list[SentimentValue] = Field(default_factory=list)
    platforms: list[str] = Field(default_factory=list)
    post_types: list[ThreadEntryTypeValue] = Field(default_factory=list)
    daily_cap: int = 0
    also_post_in_alerts_space: bool = False
    end_time_utc: str
    created_at_utc: str
    updated_at_utc: str
    last_activity_utc: str = ""
    last_email_utc: str = ""
    mentions_today: int = 0
    posted_today: int = 0
    total_received: int = 0
    total_posted: int = 0
    stats_day_ny: str = ""
    warned_80_day_ny: str = ""
    shutdown_notice_sent: bool = False
    last_result: str = "Provisioning"
    saga_steps: dict[str, str] = Field(default_factory=dict)
    top_posted: list[TopPostedMention] = Field(default_factory=list)


class ParsedBrandwatchMention(BaseModel):
    """Single mention parsed from a Brandwatch Custom Alert email or API/BigQuery row."""

    model_config = ConfigDict(extra="forbid")

    url: str
    normalized_url: str
    network: str
    author: str
    followers: str
    snippet: str
    sentiment: str
    engagement_tier: str
    engagement_score: int
    kof_status: str = "No"
    product: str = ""
