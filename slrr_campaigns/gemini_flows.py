"""Schema-constrained Vertex AI Gemini 3.8 Flash flows reusing triage_agent.llm.VertexGemini."""

from __future__ import annotations

import json
import logging
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field
from triage_agent.llm import LLMError, VertexGemini

from .config import CampaignsConfig
from .logging_utils import log_event, strip_emojis
from .models import CachedQuerySummary, ParsedBrandwatchMention, QueryBuilderDraft

logger = logging.getLogger(__name__)

GEMINI_MODEL_ID = "gemini-3.8-flash"
GEMINI_LOCATION = "global"

NO_EMOJI_INSTRUCTION = "Never output any emojis, emoticons, or pictographic Unicode characters in any field."


class InitialIntentSchema(BaseModel):
    """Schema for classifying an initial owned-thread message."""

    model_config = ConfigDict(extra="forbid")

    intent: Literal["deep_dive", "campaign", "chat_command"]
    deep_dive_days: int = Field(default=1, ge=1, le=7)
    search_topic: str = ""
    alert_name_hint: str = ""
    command_name: Literal["none", "pause", "resume", "shut_down", "extend", "threshold"] = "none"
    command_int: int = 0


class SemanticQueryRankingSchema(BaseModel):
    """Schema for ranking up to 5 cached Brandwatch queries by meaning."""

    model_config = ConfigDict(extra="forbid")

    ranked_query_ids: list[int] = Field(default_factory=list)


class QueryBuilderPrefillSchema(BaseModel):
    """Schema for prefilling Query Builder fields from an alert thread."""

    model_config = ConfigDict(extra="forbid")

    short_name: str
    core_terms: list[str]
    context_proximity: str
    alternate_phrases: list[str]
    exclusions: list[str]
    content_sources: list[str]
    languages: list[str]
    locations: list[str]


class BooleanDraftSchema(BaseModel):
    """Schema for drafting a Brandwatch booleanQuery."""

    model_config = ConfigDict(extra="forbid")

    boolean_query: str


class StepReplyParseSchema(BaseModel):
    """Schema for parsing a plain-text user reply in a conversation step."""

    model_config = ConfigDict(extra="forbid")

    outcome: Literal["parsed", "unclear", "cancel", "edit_field", "approve", "command"]
    clarifying_question: str = ""
    choice_number: int = 0
    bool_value: bool = False
    int_value: int = 0
    text_value: str = ""
    list_values: list[str] = Field(default_factory=list)
    iso_utc_value: str = ""
    edit_field_name: str = ""
    command_name: Literal["none", "pause", "resume", "shut_down", "extend", "threshold"] = "none"
    command_arg: int = 0


class MentionSummaryItem(BaseModel):
    """Single mention summary in a batched Gemini call."""

    model_config = ConfigDict(extra="forbid")

    normalized_url: str
    one_line_summary: str
    sentiment: Literal["Positive", "Neutral", "Negative"]
    product: str


class MentionSummariesBatchSchema(BaseModel):
    """Batched response for qualifying campaign mentions."""

    model_config = ConfigDict(extra="forbid")

    items: list[MentionSummaryItem]


class DeepDiveSynthesisSchema(BaseModel):
    """Structured narrative synthesis for a Brandwatch + BigQuery deep dive."""

    model_config = ConfigDict(extra="forbid")

    headline_summary: str
    key_findings: list[str]
    narrative_themes: list[str]
    timeline_takeaway: str
    data_gap_notes: str


class GeminiFlows:
    """Typed Gemini 3.8 Flash client wrapper enforcing JSON schemas and zero emojis."""

    def __init__(self, cfg: CampaignsConfig) -> None:
        self._llm = VertexGemini(project=cfg.gcp_project_id, location=GEMINI_LOCATION)

    def _call_schema(
        self,
        *,
        purpose: str,
        system: str,
        prompt: str,
        schema: type[Any],
        temperature: float,
    ) -> Any:
        try:
            return self._llm.generate_json(  # type: ignore[no-untyped-call]
                model=GEMINI_MODEL_ID,
                system=f"{system}\n{NO_EMOJI_INSTRUCTION}",
                prompt=prompt,
                schema=schema,
                temperature=temperature,
                purpose=purpose,
            )
        except LLMError as exc:
            log_event(
                logger,
                logging.ERROR,
                "gemini_call_failed",
                purpose=purpose,
                model=GEMINI_MODEL_ID,
                error_message=str(exc)[:300],
            )
            raise

    def preflight_ping(self) -> str:
        """Execute one live schema-constrained Gemini 3.8 Flash call for setup preflight."""
        parsed: BooleanDraftSchema = self._call_schema(
            purpose="preflight.ping",
            system="Return a minimal valid Brandwatch boolean query and one-sentence explanation.",
            prompt='Draft a Brandwatch boolean query matching "Google Chrome" AND "update".',
            schema=BooleanDraftSchema,
            temperature=0.0,
        )
        return strip_emojis(parsed.boolean_query)

    def parse_initial_intent(self, *, user_text: str, alert_text: str) -> InitialIntentSchema:
        """Classify whether the requester asked for a deep dive, a campaign, or a lifecycle command."""
        prompt = (
            f"User message:\n{user_text}\n\n"
            f"Thread alert context:\n{alert_text[:2500]}\n\n"
            "Rules:\n"
            "- If the user asks for a deep dive, report, breakdown, or historical lookback, "
            "set intent='deep_dive'. Extract deep_dive_days between 1 and 7 (default 1 when unspecified).\n"
            "- If the user asks to start/create/set up a campaign, ongoing alert, dedicated space, "
            "or focused monitoring, set intent='campaign'.\n"
            "- If the user issues a campaign command (pause, resume, shut down, extend N days, threshold N), "
            "set intent='chat_command' and populate command_name and command_int.\n"
            "- Extract search_topic and alert_name_hint from the alert context and user message."
        )
        result: InitialIntentSchema = self._call_schema(
            purpose="conversation.initial_intent",
            system="You classify SLRR alert thread requests into structured parameters.",
            prompt=prompt,
            schema=InitialIntentSchema,
            temperature=0.0,
        )
        return result

    def rank_queries(
        self,
        *,
        topic: str,
        alert_text: str,
        candidates: list[CachedQuerySummary],
    ) -> list[CachedQuerySummary]:
        """Rank candidate Brandwatch queries semantically and return up to 5."""
        if not candidates:
            return []
        compact = [
            {
                "query_id": c.query_id,
                "project_name": c.project_name,
                "name": c.name,
                "boolean_preview": c.boolean_query[:220],
            }
            for c in candidates[:60]
        ]
        prompt = (
            f"Requested topic: {topic}\n"
            f"Alert context: {alert_text[:1200]}\n"
            f"Candidate Brandwatch queries JSON:\n{json.dumps(compact)}\n\n"
            "Return up to 5 query_id integers ordered from best semantic match to weakest."
        )
        ranked: SemanticQueryRankingSchema = self._call_schema(
            purpose="query.semantic_rank",
            system="You rank Brandwatch queries by semantic relevance to an incident or topic.",
            prompt=prompt,
            schema=SemanticQueryRankingSchema,
            temperature=0.0,
        )
        by_id = {c.query_id: c for c in candidates}
        ordered: list[CachedQuerySummary] = []
        for qid in ranked.ranked_query_ids:
            if qid in by_id and by_id[qid] not in ordered:
                ordered.append(by_id[qid])
            if len(ordered) >= 5:
                break
        return ordered

    def prefill_builder(self, *, user_text: str, alert_text: str) -> QueryBuilderPrefillSchema:
        """Prefill Query Builder fields from the alert thread."""
        prompt = (
            f"User request:\n{user_text}\n\n"
            f"Alert context:\n{alert_text[:2500]}\n\n"
            "Propose concise defaults for a narrow Brandwatch search query:\n"
            "- short_name: 2-5 words naming the topic\n"
            "- core_terms: key product names, handles, hashtags, or domains\n"
            "- context_proximity: plain-language description of which context words should appear near "
            "core terms (e.g. 'outage OR crash within 5 words of Chrome')\n"
            "- alternate_phrases: common alternate wordings\n"
            "- exclusions: noisy terms, sites, or authors to exclude\n"
            "- content_sources: Brandwatch contentSource IDs from "
            "['twitter','reddit','youtube','news','blog','forum','instagram','facebook','bluesky']\n"
            "- languages: ISO 639-1 language codes such as ['en']\n"
            "- locations: location codes if geographic scope is central, else []"
        )
        result: QueryBuilderPrefillSchema = self._call_schema(
            purpose="builder.prefill",
            system="You prefill Brandwatch Query Builder answers from a social alert.",
            prompt=prompt,
            schema=QueryBuilderPrefillSchema,
            temperature=0.0,
        )
        return result

    def draft_boolean(
        self,
        *,
        builder: QueryBuilderDraft,
        example_booleans: list[str],
        previous_errors: list[str],
    ) -> BooleanDraftSchema:
        """Draft or repair a Brandwatch booleanQuery obeying strict Brandwatch syntax."""
        examples_block = "\n---\n".join(ex[:400] for ex in example_booleans[:4] if ex.strip())
        errors_block = "\n".join(previous_errors) if previous_errors else "None"
        prompt = (
            f"Core terms: {builder.core_terms}\n"
            f"Context and proximity: {builder.context_proximity}\n"
            f"Alternate phrases: {builder.alternate_phrases}\n"
            f"Exclusions: {builder.exclusions}\n\n"
            f"Team's existing Brandwatch booleanQuery examples:\n{examples_block or 'None available'}\n\n"
            f"Validation errors from previous attempt to fix:\n{errors_block}\n\n"
            "Brandwatch boolean syntax rules (mandatory):\n"
            "1. Logical operators AND, OR, NOT must be ALL CAPS.\n"
            "2. Proximity: a NEAR/5 b matches within 5 words either order; a NEAR/5f b requires "
            'first term first; NEAR/0 means adjacent; "a b c"~5 keeps phrase words within 5.\n'
            "3. Each NEAR operator has exactly two sides; group alternatives in (...) on each side.\n"
            "4. Never use short wildcards like a* or j*.\n"
            "5. Quote multi-word exact phrases with double quotes.\n"
            "6. Exclude sites with NOT site:domain.com and authors with NOT author:handle when requested."
        )
        result: BooleanDraftSchema = self._call_schema(
            purpose="builder.draft_boolean",
            system="You write syntactically valid Brandwatch Consumer Research boolean queries.",
            prompt=prompt,
            schema=BooleanDraftSchema,
            temperature=0.0,
        )
        return result

    def parse_step_reply(
        self,
        *,
        step_name: str,
        step_instructions: str,
        current_Time_ny: str,
        user_reply: str,
    ) -> StepReplyParseSchema:
        """Parse a user's plain-text reply at temperature 0 into StepReplyParseSchema."""
        prompt = (
            f"Current time in America/New_York: {current_Time_ny}\n"
            f"Current conversation step: {step_name}\n"
            f"Step prompt / expected schema:\n{step_instructions}\n\n"
            f"User reply:\n{user_reply}\n\n"
            "Classification rules:\n"
            "- If the user says 'cancel', 'abort', or 'never mind', set outcome='cancel'.\n"
            "- If step_name == 'await_approval' and user replies 'approve' (or starts with 'approve'), "
            "set outcome='approve'.\n"
            "- If user issues a live campaign command ('pause', 'resume', 'shut down', "
            "'extend N days', 'threshold N'), set outcome='command', command_name, and command_arg.\n"
            "- At confirmation steps, 'yes' / 'confirm' sets outcome='parsed' and bool_value=true; "
            "naming a field to edit sets outcome='edit_field' and edit_field_name.\n"
            "- When parsing dates or shutdown times, interpret user input in America/New_York and convert "
            "to UTC ISO-8601 (YYYY-MM-DDTHH:MM:SSZ) in iso_utc_value (or YYYY-MM-DD in text_value).\n"
            "- If the reply cannot be unambiguously mapped to the step, set outcome='unclear' and provide "
            "a concise plain-text clarifying_question."
        )
        result: StepReplyParseSchema = self._call_schema(
            purpose=f"step.parse.{step_name}",
            system="You parse plain-text Google Chat replies into structured step values at temperature 0.",
            prompt=prompt,
            schema=StepReplyParseSchema,
            temperature=0.0,
        )
        return result

    def summarize_mentions(
        self,
        *,
        campaign_topic: str,
        mentions: list[ParsedBrandwatchMention],
    ) -> dict[str, MentionSummaryItem]:
        """Generate one-line plain-text summaries for qualifying mentions in a single batched call."""
        if not mentions:
            return {}
        payload = [
            {
                "normalized_url": m.normalized_url,
                "network": m.network,
                "author": m.author,
                "snippet": m.snippet[:450],
                "initial_sentiment": m.sentiment,
                "initial_product": m.product,
            }
            for m in mentions
        ]
        prompt = (
            f"Campaign topic: {campaign_topic}\n"
            f"Mentions JSON:\n{json.dumps(payload)}\n\n"
            "For every item, return normalized_url, a factual one_line_summary "
            "(max 160 characters, zero emojis), sentiment ('Positive', 'Neutral', or 'Negative'), "
            "and product (e.g. 'Chrome', 'Search', 'Pixel', 'Google')."
        )
        batch: MentionSummariesBatchSchema = self._call_schema(
            purpose="ingest.batch_summaries",
            system="You summarize social media mentions concisely in plain text with zero emojis.",
            prompt=prompt,
            schema=MentionSummariesBatchSchema,
            temperature=0.1,
        )
        return {item.normalized_url: item for item in batch.items}

    def synthesize_deep_dive(
        self,
        *,
        topic: str,
        window_label: str,
        total_mentions: int,
        sentiment_counts: dict[str, int],
        top_topics: list[str],
        top_authors: list[str],
        sample_posts: list[dict[str, Any]],
        lacking_text_sources: list[str],
    ) -> DeepDiveSynthesisSchema:
        """Synthesize executive deep-dive findings from collected BigQuery / Brandwatch data."""
        prompt = (
            f"Topic / Alert: {topic}\n"
            f"Window: {window_label}\n"
            f"Total mentions: {total_mentions}\n"
            f"Sentiment breakdown: {json.dumps(sentiment_counts)}\n"
            f"Top topics/phrases: {json.dumps(top_topics[:15])}\n"
            f"Top authors: {json.dumps(top_authors[:15])}\n"
            f"Top posts sample: {json.dumps(sample_posts[:20])}\n"
            f"Sources where API stripped full text: {json.dumps(lacking_text_sources)}\n\n"
            "Produce a factual, plain-text synthesis with zero emojis. "
            "Explicitly describe any sources that lacked full text."
        )
        result: DeepDiveSynthesisSchema = self._call_schema(
            purpose="deep_dive.synthesize",
            system="You write concise executive social-listening deep-dive syntheses with zero emojis.",
            prompt=prompt,
            schema=DeepDiveSynthesisSchema,
            temperature=0.1,
        )
        return result
