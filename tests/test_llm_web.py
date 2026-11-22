"""Gemini with Google Search: what is sent, and how the answer's sources are read.

No model is called. Vertex is stood in for at the SDK's own call, and each answer is built in the SDK's own types,
so the field names here are the SDK's. Everything between (the tool that is chosen, the reading of the answer, the
record each call leaves) is the real code.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest
from google.genai import types

from triage_agent import prompts
from triage_agent.llm import FakeLLM, LLMError, VertexGemini, WebFound
from triage_agent.events import PlatformEvent as P

CHIPS = '<style>.chip{color:#1f1f1f}@media (prefers-color-scheme: dark){.chip{color:#fff}}</style><div class="container"><a class="chip" href="https://www.google.com/search?q=gmail+outage">gmail outage</a></div>'


class Models:
    """Stands in for the SDK's models.generate_content: gives one answer and keeps what was asked."""

    def __init__(self, answer: Any):
        self.answer, self.asked = answer, []

    def generate_content(self, *, model: str, contents: Any, config: Any) -> Any:
        self.asked.append({"model": model, "contents": contents, "config": config})
        if isinstance(self.answer, Exception):
            raise self.answer
        return self.answer


def answer(parts: list[dict[str, Any]], *, queries: list[str] | None = None, chunks: list[dict[str, str]] | None = None,
           supports: list[dict[str, Any]] | None = None, chips: str = "") -> types.GenerateContentResponse:
    """A Gemini answer in the SDK's own shape. `supports`: {start, end, part, sources} with start and end in bytes, as the API gives them."""
    found: dict[str, Any] = {}
    if queries is not None:
        found["web_search_queries"] = queries
    if chunks is not None:
        found["grounding_chunks"] = [{"web": c} for c in chunks]
    if supports is not None:
        found["grounding_supports"] = [{"segment": {"start_index": s["start"], "end_index": s["end"], "part_index": s.get("part", 0)},
                                        "grounding_chunk_indices": s["sources"]} for s in supports]
    if chips:
        found["search_entry_point"] = {"rendered_content": chips}
    candidate: dict[str, Any] = {"content": {"role": "model", "parts": parts}, "finish_reason": "STOP"}
    if found:
        candidate["grounding_metadata"] = found
    return types.GenerateContentResponse.model_validate({"candidates": [candidate], "usage_metadata": {"prompt_token_count": 12, "candidates_token_count": 34}})


def gemini(reply: Any) -> tuple[VertexGemini, Models]:
    models = Models(reply)
    return VertexGemini(client=SimpleNamespace(models=models), max_retries=1), models


def search(llm: Any, **more: Any) -> WebFound:
    return llm.search_web(model="gemini-test", system="Look into the issue.", prompt="<issue>Gmail outage</issue>", purpose="temp_check.web", **more)


def at_bytes(text: str, upto: str) -> int:
    """How many bytes into `text` the end of `upto` is: the way Gemini counts where a citation ends."""
    return len(text[: text.index(upto) + len(upto)].encode("utf-8"))


# -- what Gemini is given ---------------------------------------------------------------------------------------------
def test_google_search_is_the_tool_gemini_is_given():
    llm, models = gemini(answer([{"text": "People report Gmail is down."}]))
    search(llm, temperature=1.0)
    asked = models.asked[0]
    tools = asked["config"].tools
    assert asked["model"] == "gemini-test" and asked["contents"] == "<issue>Gmail outage</issue>"
    assert len(tools) == 1 and tools[0].google_search is not None and tools[0].enterprise_web_search is None
    assert asked["config"].system_instruction == "Look into the issue." and asked["config"].temperature == 1.0
    assert asked["config"].response_schema is None and asked["config"].response_mime_type is None, "a searched answer is read as words and sources, not as a form"


def test_the_enterprise_setting_gives_the_enterprise_search_instead():
    llm, models = gemini(answer([{"text": "People report Gmail is down."}]))
    search(llm, search="enterprise")
    tools = models.asked[0]["config"].tools
    assert len(tools) == 1 and tools[0].enterprise_web_search is not None and tools[0].google_search is None


def test_a_search_that_is_neither_is_refused_before_anything_is_asked():
    llm, models = gemini(answer([{"text": "x"}]))
    with pytest.raises(LLMError, match="google or enterprise"):
        search(llm, search="bing")
    assert models.asked == []


@pytest.mark.parametrize("which", ["google", "enterprise"])
def test_sites_to_leave_out_are_passed_to_the_search(which):
    llm, models = gemini(answer([{"text": "x"}]))
    search(llm, search=which, exclude_sites=["spam.test", "ads.test"])
    tool = models.asked[0]["config"].tools[0]
    assert (tool.google_search or tool.enterprise_web_search).exclude_domains == ["spam.test", "ads.test"]
    search(llm, search=which)
    tool = models.asked[1]["config"].tools[0]
    assert (tool.google_search or tool.enterprise_web_search).exclude_domains is None, "an empty list is not sent"


# -- how the answer is read -------------------------------------------------------------------------------------------
def test_the_answer_comes_back_with_its_searches_sources_and_googles_suggestions_unchanged():
    text = "People report Gmail is down. A Google account says a fix is rolling out."
    llm, _ = gemini(answer(
        [{"text": text}], queries=["gmail outage site:x.com", "gmail outage reddit"],
        chunks=[{"uri": "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AAA", "title": "x.com", "domain": "x.com"},
                {"uri": "https://vertexaisearch.cloud.google.com/grounding-api-redirect/BBB", "title": "Gmail down? : r/GMail", "domain": "reddit.com"}],
        supports=[{"start": 0, "end": at_bytes(text, "is down."), "sources": [0, 1]}, {"start": at_bytes(text, "is down.") + 1, "end": len(text), "sources": [0]}],
        chips=CHIPS))
    found = search(llm)
    assert found.text == text and found.queries == ["gmail outage site:x.com", "gmail outage reddit"]
    assert [s.model_dump() for s in found.sources] == [
        {"title": "x.com", "domain": "x.com", "uri": "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AAA"},
        {"title": "Gmail down? : r/GMail", "domain": "reddit.com", "uri": "https://vertexaisearch.cloud.google.com/grounding-api-redirect/BBB"}]
    first = text.index("is down.") + len("is down.")
    assert [c.model_dump() for c in found.cites] == [{"start": 0, "end": first, "sources": [0, 1]}, {"start": first + 1, "end": len(text), "sources": [0]}]
    assert found.suggestions == CHIPS, "Google's suggestions are passed on exactly as given"


def test_a_citation_ends_at_the_right_letter_after_letters_that_take_more_than_one_byte():
    text = "Café owners in São Paulo say Gmail is down. Others say it works."
    llm, _ = gemini(answer([{"text": text}], chunks=[{"uri": "https://g.test/1", "title": "a", "domain": "a.test"}],
                           supports=[{"start": at_bytes(text, "São Paulo "), "end": at_bytes(text, "is down."), "sources": [0]}]))
    cite = search(llm).cites[0]
    assert at_bytes(text, "is down.") > text.index("is down.") + len("is down."), "the API counts bytes, and these letters take two"
    assert text[cite.start: cite.end] == "say Gmail is down." and text[cite.end:] == " Others say it works."


def test_a_citation_in_a_later_part_is_placed_after_the_parts_before_it():
    first, second = "Gmail is down for many. ", "Reddit threads blame an update."
    llm, _ = gemini(answer([{"text": first}, {"text": second}], chunks=[{"uri": "https://g.test/1", "title": "a", "domain": "a.test"}],
                           supports=[{"start": 0, "end": len(second), "part": 1, "sources": [0]}]))
    found = search(llm)
    assert found.text == first + second and (found.cites[0].start, found.cites[0].end) == (len(first), len(first + second))


def test_geminis_thinking_aloud_is_not_part_of_the_answer():
    said = "Posts on X report an outage."
    llm, _ = gemini(answer([{"text": "I should search for it first.", "thought": True}, {"text": said}],
                           chunks=[{"uri": "https://g.test/1", "title": "a", "domain": "a.test"}],
                           supports=[{"start": 0, "end": len(said), "part": 1, "sources": [0]}]))
    found = search(llm)
    assert found.text == said and (found.cites[0].start, found.cites[0].end) == (0, len(said))


def test_an_answer_with_no_search_behind_it_has_no_sources():
    llm, _ = gemini(answer([{"text": "I found nothing about it."}]))
    found = search(llm)
    assert found.text == "I found nothing about it." and found.queries == [] and found.sources == [] and found.cites == [] and found.suggestions == ""


def test_a_citation_of_a_source_that_did_not_come_is_dropped():
    text = "Gmail is down."
    llm, _ = gemini(answer([{"text": text}], chunks=[{"uri": "https://g.test/1", "title": "a", "domain": "a.test"}],
                           supports=[{"start": 0, "end": len(text), "sources": [0, 7]}, {"start": 0, "end": len(text), "sources": [9]}]))
    assert [c.model_dump() for c in search(llm).cites] == [{"start": 0, "end": len(text), "sources": [0]}]


def test_a_page_given_as_retrieved_context_counts_as_a_source_the_way_the_sheet_based_bot_reads_it():
    reply = types.GenerateContentResponse.model_validate({"candidates": [{"content": {"role": "model", "parts": [{"text": "Gmail is down."}]}, "grounding_metadata": {
        "grounding_chunks": [{"retrieved_context": {"uri": "https://g.test/doc", "title": "Status page"}}, {"web": {"title": "no link"}}]}}]})
    llm, _ = gemini(reply)
    assert [s.model_dump() for s in search(llm).sources] == [{"title": "Status page", "domain": "", "uri": "https://g.test/doc"}]


def test_an_answer_with_no_words_is_an_error():
    llm, _ = gemini(types.GenerateContentResponse.model_validate({"candidates": []}))
    with pytest.raises(LLMError, match="Empty Gemini response"):
        search(llm)


def test_a_refusal_from_google_is_an_error_that_names_it():
    llm, _ = gemini(RuntimeError("400 INVALID_ARGUMENT: Search grounding is not enabled for this project"))
    with pytest.raises(LLMError, match="Search grounding is not enabled"):
        search(llm)


# -- the stand-in and the record -----------------------------------------------------------------------------------
def test_the_stand_in_answers_a_web_search_by_its_purpose_and_keeps_what_was_asked():
    fake = FakeLLM()
    fake.on("temp_check.web", {"text": "Found.", "queries": ["q"], "sources": [{"title": "t", "domain": "d.test", "uri": "https://d.test/1"}],
                               "cites": [{"start": 0, "end": 6, "sources": [0]}], "suggestions": CHIPS})
    found = search(fake, search="enterprise", exclude_sites=["spam.test"])
    assert isinstance(found, WebFound) and found.text == "Found." and found.sources[0].domain == "d.test" and found.suggestions == CHIPS
    assert fake.calls == [{"kind": "web", "model": "gemini-test", "system": "Look into the issue.", "prompt": "<issue>Gmail outage</issue>",
                           "purpose": "temp_check.web", "search": "enterprise", "exclude_sites": ["spam.test"], "temperature": 1.0}]
    with pytest.raises(LLMError, match="no web search answer"):
        FakeLLM().search_web(model="m", system="s", prompt="p", purpose="temp_check.web")


def test_a_web_search_follows_the_published_instructions_and_leaves_a_usage_record(ctx, fake_llm):
    managed = prompts.ManagedLLM(fake_llm, lambda: ctx)
    fake_llm.on("temp_check.web", {"text": "Found."})
    assert search(managed, search="google").text == "Found."
    usage = ctx.events.query(types=[P.LLM_USAGE])
    assert usage[0].payload["purpose"] == "temp_check.web" and usage[0].prompt_version == "built-in" and usage[0].payload["ok"] is True
    v = prompts.publish(ctx, purpose="temp_check.web", system="{{default}} Look at Bluesky too.", model="gemini-next", temperature=0.4,
                        note="bluesky", actor="admin@ops.test")
    managed.invalidate()
    search(managed, search="google")
    call = fake_llm.calls[-1]
    assert call["system"] == "Look into the issue. Look at Bluesky too." and call["model"] == "gemini-next" and call["temperature"] == 0.4
    assert ctx.events.query(types=[P.LLM_USAGE])[0].prompt_version == f"v{v.version}"
    fake_llm.on("temp_check.web", lambda call: (_ for _ in ()).throw(LLMError("Google refused the search")))
    with pytest.raises(LLMError):
        search(managed, search="google")
    failed = ctx.events.query(types=[P.LLM_USAGE])[0].payload
    assert failed["ok"] is False and "Google refused" in failed["error"]
