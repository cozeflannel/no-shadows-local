"""Gemini's read of a story: its topic, a neutral name, a short summary and a label for each post.

Alerts go through the real pipeline on the local store and are grouped by the real story rules. Gemini's answer is
scripted per purpose, as in the rest of the suite. Every count and share is worked out by the code under test from
the labels: none comes from the model.
"""

from __future__ import annotations

import re
from datetime import timedelta
from typing import Any

from conftest import GOOD_ALERT
from test_platform import IM, VIEWER, _llm, alert, client, flags, iap, triage  # noqa: F401 - fixtures
from triage_agent import stories, storyread


def named(n: int, issue: str, **more: str) -> str:
    return alert(n, Issue_Name=issue, **more)


def arrive(ctx, clock, text: str = GOOD_ALERT):
    return triage(ctx, text, create_time=clock.now)


def citations_story(ctx, clock) -> stories.Story:
    """Three alerts on one story; the second has the most engagement."""
    arrive(ctx, clock)
    clock.advance(minutes=10)
    arrive(ctx, clock, named(2, "Gemini fabricates academic citations again", Post_Content="It made up two more papers. Useless.", Likes="9000", Total_Engagement="9450"))
    clock.advance(minutes=10)
    arrive(ctx, clock, named(3, "Gemini fabricates academic citations once more", Post_Content="Honestly it works fine for me."))
    stories.refresh(ctx)
    found = stories.list_stories(ctx, since=clock.now - timedelta(days=1))
    assert len(found) == 1 and len(found[0].members) == 3
    return found[0]


def answer(labels: list[str], topic: str = "AI answers", name: str = "Gemini invents academic sources") -> dict[str, Any]:
    return {"topic": topic, "name": name, "summary": "People say Gemini cites papers that do not exist. One says it works for them.",
            "posts": [{"n": i + 1, "sentiment": s} for i, s in enumerate(labels)]}


def prompts(fake_llm) -> list[str]:
    return [c["prompt"] for c in fake_llm.calls if c.get("purpose") == storyread.PURPOSE]


# -- one read ------------------------------------------------------------------------------------------------------------------
def test_gemini_reads_a_story_most_engaged_post_first_and_each_label_is_kept_by_alert(ctx, clock, fake_llm):
    story = citations_story(ctx, clock)
    fake_llm.on(storyread.PURPOSE, answer(["negative", "negative", "positive"]))
    read = storyread.read(ctx, story)
    assert (read["topic"], read["name"]) == ("AI answers", "Gemini invents academic sources") and read["summary"].startswith("People say")
    assert read["labels"] == {"TRG-1002": "negative", "TRG-1001": "negative", "TRG-1003": "positive"}
    assert read["members"] == 3 and read["read"] == 3
    shown = prompts(fake_llm)[0]
    assert re.search(r"^1\. .*It made up two more papers\. Useless\.", shown, re.M), "the post with the most engagement is read first"
    assert "Topics already in use: none yet" in shown and "Burson's name for it: Gemini fabricates academic citations" in shown
    assert storyread.get(ctx, story.story_id)["labels"] == read["labels"], "the read is kept"


def test_the_labels_are_counted_here_and_the_shares_decide_the_tone(ctx, clock, fake_llm):
    story = citations_story(ctx, clock)
    fake_llm.on(storyread.PURPOSE, answer(["negative", "negative", "positive"]))
    read = storyread.read(ctx, story)
    counts = storyread.tally(read, story)
    cfg = ctx.config.platform.stories
    assert counts == {"negative": 2, "neutral": 0, "positive": 1, "unrated": 0} and storyread.tone(counts, cfg) == "negative"
    assert storyread.tone({"negative": 1, "neutral": 2, "positive": 1, "unrated": 0}, cfg) == "neutral", "neither share reaches the bar"
    assert storyread.tone({"negative": 0, "neutral": 1, "positive": 3, "unrated": 0}, cfg) == "positive"
    assert storyread.tone({"negative": 0, "neutral": 0, "positive": 0, "unrated": 4}, cfg) == "", "no rated post, no tone"
    cfg.negative_share = 0.25
    assert storyread.tone({"negative": 1, "neutral": 2, "positive": 1, "unrated": 0}, cfg) == "negative", "the bar is a setting"


def test_no_tone_is_claimed_from_a_few_rated_posts_among_many_unrated(ctx):
    cfg = ctx.config.platform.stories
    assert cfg.min_rated_share == 0.25
    assert storyread.tone({"negative": 1, "neutral": 0, "positive": 0, "unrated": 6}, cfg) == "", "1 of 7 rated says too little"
    assert storyread.tone({"negative": 2, "neutral": 0, "positive": 0, "unrated": 5}, cfg) == "negative", "2 of 7 rated reaches the share in Settings"
    cfg.min_rated_share = 0.1
    assert storyread.tone({"negative": 1, "neutral": 0, "positive": 0, "unrated": 6}, cfg) == "negative"


def test_a_label_for_a_post_that_was_not_shown_or_a_word_that_is_not_a_label_is_left_unrated(ctx, clock, fake_llm):
    story = citations_story(ctx, clock)
    fake_llm.on(storyread.PURPOSE, {"topic": "AI answers", "name": "x", "summary": "y",
                                    "posts": [{"n": 1, "sentiment": "Negative"}, {"n": 2, "sentiment": "furious"}, {"n": 9, "sentiment": "positive"}]})
    read = storyread.read(ctx, story)
    assert read["labels"] == {"TRG-1002": "negative"}, "a label is taken in any case; an unknown word or number is dropped"
    assert storyread.tally(read, story) == {"negative": 1, "neutral": 0, "positive": 0, "unrated": 2}


def test_an_alert_that_joins_after_the_read_counts_as_unrated(ctx, clock, fake_llm):
    story = citations_story(ctx, clock)
    fake_llm.on(storyread.PURPOSE, answer(["negative", "negative", "positive"]))
    read = storyread.read(ctx, story)
    arrive(ctx, clock, named(4, "Gemini fabricates academic citations yet again"))
    stories.refresh(ctx)
    grown = stories.get(ctx, story.story_id)
    assert len(grown.members) == 4 and storyread.tally(read, grown)["unrated"] == 1


def test_only_as_many_posts_as_the_setting_allows_are_read(ctx, clock, fake_llm):
    ctx.config.platform.stories.read_posts = 2
    story = citations_story(ctx, clock)
    fake_llm.on(storyread.PURPOSE, answer(["negative", "neutral"]))
    read = storyread.read(ctx, story)
    assert read["read"] == 2 and set(read["labels"]) == {"TRG-1002", "TRG-1001"} and "\n3. " not in prompts(fake_llm)[0]


# -- the tick --------------------------------------------------------------------------------------------------------------------
def test_nothing_is_read_while_the_switch_is_off(ctx, clock, fake_llm):
    citations_story(ctx, clock)
    assert storyread.run(ctx) == {"skipped": "Gemini reads each story is OFF", "read": 0}
    assert prompts(fake_llm) == []


def test_a_story_is_read_once_and_again_only_after_it_grows_and_the_wait_has_passed(ctx, clock, fake_llm):
    flags(ctx, story_reads=True)
    story = citations_story(ctx, clock)
    fake_llm.on(storyread.PURPOSE, answer(["negative", "negative", "positive"]))
    assert storyread.run(ctx)["read"] == 1 and storyread.run(ctx)["read"] == 0, "an unchanged story is not read twice"
    arrive(ctx, clock, named(4, "Gemini fabricates academic citations yet again"))
    stories.refresh(ctx)
    assert storyread.run(ctx)["read"] == 0, "it grew, but the wait between reads has not passed"
    clock.advance(minutes=ctx.config.platform.stories.reread_minutes + 1)
    fake_llm.on(storyread.PURPOSE, answer(["negative", "negative", "positive", "negative"]))
    assert storyread.run(ctx)["read"] == 1
    assert storyread.tally(storyread.get(ctx, story.story_id), stories.get(ctx, story.story_id))["negative"] == 3


def test_the_biggest_unread_stories_go_first_and_the_run_stops_at_its_limit(ctx, clock, fake_llm):
    flags(ctx, story_reads=True)
    ctx.config.platform.stories.reads_per_run = 1
    arrive(ctx, clock, named(1, "Chrome update breaks the password manager", Likes="100", Total_Engagement="550"))
    arrive(ctx, clock, named(2, "Pixel battery drains overnight", Likes="50000", Total_Engagement="50450"))
    stories.refresh(ctx)
    fake_llm.on(storyread.PURPOSE, answer(["negative"]))
    assert storyread.run(ctx)["read"] == 1
    assert "Pixel battery drains overnight" in prompts(fake_llm)[0], "the story with the most engagement is read first"
    assert storyread.run(ctx)["read"] == 1 and "Chrome update" in prompts(fake_llm)[1]


def test_topics_in_use_are_offered_so_the_same_subject_keeps_one_name(ctx, clock, fake_llm):
    flags(ctx, story_reads=True)
    arrive(ctx, clock, named(1, "Chrome update breaks the password manager"))
    stories.refresh(ctx)
    fake_llm.on(storyread.PURPOSE, answer(["negative"], topic="Account security"))
    storyread.run(ctx)
    arrive(ctx, clock, named(2, "Pixel battery drains overnight"))
    stories.refresh(ctx)
    storyread.run(ctx)
    assert "Topics already in use: Account security" in prompts(fake_llm)[1]


def test_a_read_that_fails_is_counted_and_the_story_stays_unread(ctx, clock, fake_llm):
    flags(ctx, story_reads=True)
    story = citations_story(ctx, clock)

    def broken(call: dict[str, Any]) -> dict[str, Any]:
        raise RuntimeError("model unavailable")
    fake_llm.on(storyread.PURPOSE, broken)
    out = storyread.run(ctx)
    assert out["read"] == 0 and out["failed"] == 1 and storyread.get(ctx, story.story_id) is None


# -- the page's calls ------------------------------------------------------------------------------------------------------------
def test_the_map_carries_each_storys_topic_name_counted_sentiment_and_the_choices_to_filter_by(ctx, client, clock, fake_llm):
    flags(ctx, story_reads=True)
    citations_story(ctx, clock)
    arrive(ctx, clock, named(5, "Chrome update breaks the password manager", Product="Chrome"))
    fake_llm.on(storyread.PURPOSE, answer(["negative", "negative", "positive"]))
    got = client.get("/api/stories", params={"hours": 24}, headers=iap(VIEWER)).json()
    assert got["reads_on"] is True and (got["negative_share"], got["positive_share"], got["min_rated_share"]) == (0.5, 0.5, 0.25), "the page colors groups by the same bars"
    big = next(s for s in got["stories"] if s["alerts"] == 3)
    assert big["topic"] == "" and big["tone"] == "" and big["sentiment"] == {"negative": 0, "neutral": 0, "positive": 0, "unrated": 3}, "not read yet"
    storyread.run(ctx)
    got = client.get("/api/stories", params={"hours": 24}, headers=iap(VIEWER)).json()
    big = next(s for s in got["stories"] if s["alerts"] == 3)
    assert (big["topic"], big["name"], big["tone"]) == ("AI answers", "Gemini invents academic sources", "negative")
    assert big["sentiment"] == {"negative": 2, "neutral": 0, "positive": 1, "unrated": 0}
    assert sorted(p["m"] for p in big["points"]) == ["negative", "negative", "positive"], "each alert carries its label, for grouping on the page"
    facets = got["facets"]
    assert {f["value"]: f["stories"] for f in facets["products"]} == {"Gemini App": 1, "Chrome": 1}
    assert [f["value"] for f in facets["topics"]] == ["AI answers"] and {f["value"] for f in facets["tones"]} >= {"negative"}


def test_opening_a_story_shows_geminis_read_and_each_post_with_its_words_and_label(ctx, client, clock, fake_llm):
    flags(ctx, story_reads=True)
    story = citations_story(ctx, clock)
    fake_llm.on(storyread.PURPOSE, answer(["negative", "negative", "positive"]))
    storyread.run(ctx)
    detail = client.get(f"/api/stories/{story.story_id}", headers=iap(VIEWER)).json()
    assert detail["read"]["summary"].startswith("People say") and detail["read"]["topic"] == "AI answers" and detail["read"]["stale"] is False
    by_id = {a["case_id"]: a for a in detail["alerts"]}
    assert by_id["TRG-1002"]["sentiment"] == "negative" and by_id["TRG-1002"]["post_text"] == "It made up two more papers. Useless."
    assert by_id["TRG-1003"]["sentiment"] == "positive" and detail["story"]["tone"] == "negative"
    arrive(ctx, clock, named(4, "Gemini fabricates academic citations yet again"))
    again = client.get(f"/api/stories/{story.story_id}", headers=iap(VIEWER)).json()
    assert again["read"]["stale"] is True and {a["case_id"]: a["sentiment"] for a in again["alerts"]}["TRG-1004"] == ""


def test_read_now_is_an_analysts_button_and_follows_the_switch(ctx, client, clock, fake_llm):
    story = citations_story(ctx, clock)
    fake_llm.on(storyread.PURPOSE, answer(["negative", "negative", "positive"]))
    off = client.post(f"/api/stories/{story.story_id}/read", headers=iap(IM))
    assert off.status_code == 400 and "switched off" in off.json()["error"]
    flags(ctx, story_reads=True)
    assert client.post(f"/api/stories/{story.story_id}/read", headers=iap(VIEWER)).status_code == 403
    done = client.post(f"/api/stories/{story.story_id}/read", headers=iap(IM))
    assert done.status_code == 200 and done.json()["read"]["topic"] == "AI answers" and done.json()["story"]["tone"] == "negative"
    assert client.post("/api/stories/STORY-nope/read", headers=iap(IM)).status_code == 404
