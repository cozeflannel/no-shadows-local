"""The numbers shown for an alert are counted or come from Gemini Decisions. These tests run the real functions on
real inputs: no service is involved in the counting."""

from __future__ import annotations

from triage_agent.events import PlatformEvent
from triage_agent.models import Correction, Issue, IssueSource, Severity
from triage_agent.qa import certainty
from triage_agent.qa.pipeline import _apply_policy


def fix(field: str, *, applied: bool = True, source: IssueSource = IssueSource.RULE, chance: float | None = None, reverted: str | None = None) -> Correction:
    return Correction(field=field, old="a", new="b", applied=applied, source=source, confidence=chance, reverted_by=reverted)


def test_burson_filled_five_fields_and_three_were_wrong_so_forty_percent_were_right(ctx):
    filled = ["product", "exposure_tag", "priority", "social_network", "summary"]
    score = certainty.burson_score(ctx.config, filled, [fix("product"), fix("exposure_tag"), fix("priority")], [])
    assert (score["filled"], score["right"], score["pct"]) == (5, 2, 0.4)
    assert score["wrong"] == ["product", "exposure_tag", "priority"] and score["in_question"] == []


def test_a_fix_waiting_for_a_person_is_in_question_and_a_reverted_fix_is_not_counted_against_burson(ctx):
    filled = ["product", "exposure_tag", "priority", "social_network"]
    corrections = [fix("product", applied=False, source=IssueSource.LLM), fix("priority", applied=False, reverted="im@ops.test"),
                   fix("issue_status")]  # a field Burson left blank is not Burson's mistake
    problems = [Issue(field="social_network", rule="not_allowed", severity=Severity.BLOCKING),
                Issue(field="exposure_tag", rule="llm:tag", severity=Severity.BLOCKING, source=IssueSource.LLM),
                Issue(field="product", rule="style", severity=Severity.WARNING)]
    score = certainty.burson_score(ctx.config, filled, corrections, problems)
    assert score["wrong"] == ["social_network"] and score["in_question"] == ["product", "exposure_tag"] and score["pct"] == 0.75
    assert certainty.burson_score(ctx.config, [], [], [])["pct"] is None, "nothing filled in: no percentage"


def test_a_rule_fix_is_applied_and_geminis_fix_needs_a_probability_at_the_bar(ctx):
    cfg = ctx.config
    bar = cfg.corrections.auto_apply_min_confidence
    assert _apply_policy(cfg, fix("priority", applied=False)).applied is True, "the rulebook decides its own fixes"
    assert _apply_policy(cfg, fix("exposure_tag", source=IssueSource.LLM, chance=None)).applied is False
    assert _apply_policy(cfg, fix("exposure_tag", source=IssueSource.LLM, chance=bar - 0.01)).applied is False
    assert _apply_policy(cfg, fix("exposure_tag", source=IssueSource.LLM, chance=bar)).applied is True
    assert _apply_policy(cfg, fix("post_url", source=IssueSource.LLM, chance=0.99)).applied is False, "never auto-corrected, whatever the chance"


def test_gemini_decisions_is_asked_one_question_a_fix_one_a_problem_and_whether_a_person_is_needed(ctx):
    q = certainty.questions(ctx.config, [{"key": "fix_tag", "field": "exposure_tag", "old": "Brand - Other/general criticism", "new": "Product - Perceived bias"}],
                            [{"key": "problem_summary", "finding": "The summary names a product the post does not mention."}])
    assert list(q) == ["fix_tag", "problem_summary", "review"] and {v["type"] for v in q.values()} == {"noul"}
    assert q["fix_tag"]["instructions"] == 'In the alert in the input, should the Exposure Tag be "Product - Perceived bias" rather than "Brand - Other/general criticism"?'
    assert "The summary names a product the post does not mention." in q["problem_summary"]["instructions"]
    text = certainty.alert_text({"summary": "See https://x.example/p/1 by @someone", "product": "Gemini App", "likes": None}, 4000)
    assert text == '{"summary": "See by", "product": "Gemini App"}', "the alert goes without links or handles"
    assert certainty.judge(ctx, {"product": "Gemini App"}, [], []) == {}, "switch OFF: Gemini Decisions is not asked"


def test_agreement_is_counted_from_the_assessments_people_recorded(ctx):
    assert certainty.field_agreement(ctx) == {"days": 30, "assessments": 0, "fields": {}}, "no assessments: no rate is shown"
    for corrected in (["exposure_tag"], [], ["exposure_tag", "product"], []):
        ctx.emit(PlatformEvent.ASSESSMENT_RECORDED, actor="im@ops.test", case_id="TRG-1", payload={"agree": not corrected, "fields": corrected})
    got = certainty.field_agreement(ctx)
    assert got["assessments"] == 4
    assert got["fields"]["exposure_tag"] == {"kept": 2, "of": 4, "rate": 0.5} and got["fields"]["product"] == {"kept": 3, "of": 4, "rate": 0.75}
    assert got["fields"]["social_network"] == {"kept": 4, "of": 4, "rate": 1.0}
