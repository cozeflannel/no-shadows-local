"""What the Console shows an analyst is said in plain words: why an alert was held, why it was not posted, and the time
slider's counts on the story map.

Run: TRIAGE_LLM=fake .venv/bin/python -m pytest -q tests/test_plain_words.py
"""

from __future__ import annotations

import re

from console.backend.serializers import field_label, plain_reason, suppression_label, words
from test_console_api import api, console_ctx, seeded  # noqa: F401 - fixtures: the seeded demo store
from test_platform import IM, _llm, alert, assess_ok, client, iap, triage  # noqa: F401 - fixtures: the real pipeline

RAW_KEY = re.compile(r"\b[a-z]+_[a-z_]+\b")  # a snake_case key such as alert_name or below_threshold


# -- the words themselves ----------------------------------------------------------------------------------------------------
def test_review_reasons_read_as_sentences():
    assert plain_reason("alert_name: Add the Alert Name.") == "Alert Name: Add the Alert Name."
    assert plain_reason("exposure_tag: Use one exposure tag from the March 2026 Collection Requirements.") == \
        "Exposure Tag: Use one exposure tag from the March 2026 Collection Requirements."
    held = plain_reason("would be suppressed (below_threshold) but the deciding fields need review")
    assert held == ("Normally it would not be posted (under 2K engagements, with no urgent reason), "
                    "but the fields that decide that need a person to check them.")
    assert plain_reason('exposure_tag: proposed "Product - Outage" (62% likely right) — the post is about an outage') == \
        "Exposure Tag: the agent suggests \u201cProduct - Outage\u201d (62% likely right). The post is about an outage."
    assert plain_reason('product: proposed "Pixel" — named in the post') == "Product: the agent suggests \u201cPixel\u201d. Named in the post."
    assert plain_reason("alert: Gemini checks were unavailable: verify tag, product and risk tags manually.") == \
        "Gemini checks were unavailable: verify tag, product and risk tags manually.", "'alert' is the whole alert, not a field"
    assert plain_reason("exposure_tag: unknown_exposure_tag") == "Exposure Tag: Unknown exposure tag.", "a bare rule code is said in words"


def test_reasons_already_in_words_are_kept():
    for text in ("Burson marked 'meets P0 criteria' but the exposure tag is P1", "Gemini Decisions puts the chance this needs a person at 62%",
                 "Proposed Exposure Tag change below the auto-apply confidence"):
        assert plain_reason(text) == f"{text}."
    assert plain_reason("") == "" and plain_reason(None) == ""


def test_suppression_reasons_and_codes_in_words():
    assert suppression_label("below_threshold") == "Under 2K engagements, with no urgent reason"
    assert suppression_label("EXCLUDED_GOOGLE_AS_VERB") == "\"Google\" used as a verb"
    assert suppression_label("EXCLUDED_SOMETHING_NEW") == "Something new", "a reason with no label yet is still words"
    assert suppression_label(None) == suppression_label("") == suppression_label("None") == "No reason recorded"
    assert words("triage.needs_review") == "Triage needs review" and field_label("exposure_tag") == "Exposure Tag"
    assert field_label("not_a_template_field") == "Not a template field"


# -- through the API -----------------------------------------------------------------------------------------------------------
def test_a_held_alert_says_why_in_words(ctx, client, fake_llm):
    assess_ok(fake_llm, exposure_tag_fit={"ok": False, "confidence": 0.75, "finding": "medical claim",
                                          "proposed_value": "Product - Dangerous results (e.g. medical/legal)"})
    triage(ctx, alert(2))
    card = client.get("/api/feed/TRG-1001", headers=iap(IM)).json()
    assert card["status"] == "NEEDS_REVIEW" and card["review_reasons"], "held for an IM, with its reasons"
    plain = card["review_reasons_plain"]
    assert len(plain) == len(card["review_reasons"]) and plain[0].startswith("Exposure Tag: the agent suggests \u201c")
    assert not any(RAW_KEY.search(r.split("\u201c")[0]) for r in plain), "no field key or code before the suggested value"
    listed = client.get("/api/feed", params={"view": "all"}, headers=iap(IM)).json()["cards"]
    assert all("review_reasons_plain" in c and "suppression_label" in c for c in listed), "every case summary carries the words"


def test_suppressed_reasons_come_with_their_label(api):
    body = api.get("/api/suppressed", days=14).json()
    assert body["reasons"] and all(r["label"] == suppression_label(r["reason"]) for r in body["reasons"])
    assert all(c["reason_label"] == suppression_label(c["reason"]) and not RAW_KEY.search(c["reason_label"]) for c in body["cases"])
    assert any(c["suppression_label"] for c in body["cases"] if c["suppression_reason"]), "the case summary has the label too"


def test_story_points_carry_the_account_for_the_time_slider(ctx, client, clock):
    triage(ctx, alert(1))
    clock.advance(minutes=30)
    triage(ctx, alert(2, Issue_Name="Gemini fabricates academic citations again"))
    got = client.get("/api/stories", params={"hours": 24}, headers=iap(IM)).json()
    points = [p for s in got["stories"] for p in s["points"]]
    assert points and all(set(p) >= {"t", "e", "s", "id", "a", "m"} for p in points)
    assert {p["a"] for p in points} == {"@techwatcher"}, "the post's author: two alerts, one account"
