"""Triage core: QA verdicts, corrections, Collection Requirements, protocols, reviews, reverts."""

import pytest

from conftest import GOOD_ALERT, make_message
from triage_agent.events import EventType
from triage_agent.models import CaseStatus
from triage_agent.operations import handle
from triage_agent.qa.record_key import normalize_url
from triage_agent.qa.requirements import issue_tokens, jaccard

BASE = {
    "Alert Name": "[HIGH ENGAGEMENT] [NEW] Gemini App – Users report fabricated citations in research answers",
    "Issue Name": "Gemini fabricates academic citations",
    "Issue Status": "NEW",
    "Total Engagement": "2450", "Likes": "2000", "Comments": "300", "Shares": "150",
    "Product": "Gemini App",
    "Social Network": "X",
    "Exposure Tag": "Product - Factual inaccuracies (not dangerous/offensive)",
    "KOF": "No",
    "Author": "@techwatcher",
    "Post Date": "2026-10-12T13:05:00Z",
    "Location": "US",
    "View Post": "https://x.com/techwatcher/status/1845123456789012345",
    "Summary": "User claims Gemini fabricated three academic sources in a research answer.",
    "Post Content": "Asked Gemini for sources on microplastics and it invented three papers.",
}


def alert(n: int = 0, drop: tuple = (), header: str = "🚨 Burson Automated Alert", **overrides) -> str:
    fields = dict(BASE)
    fields["View Post"] = f"https://x.com/techwatcher/status/18451234567890{n:05d}"
    for k, v in overrides.items():
        fields[k.replace("_", " ")] = v
    lines = [header] + [f"{k}: {v}" for k, v in fields.items() if k not in drop and v is not None]
    return "\n".join(lines)


def triage(ctx, text, **msg):
    return handle({"op": "triage_message", "payload": {"message": make_message(text, **msg)}}, ctx)


def ok_llm(fake_llm, **checks):
    """FakeLLM triage.assess: all checks ok unless overridden ({check_id: dict})."""
    def respond(call):
        out = []
        for c in ["exposure_tag_fit", "product_fit", "sensitive_topics_fit", "kof_fit", "issue_name_neutral", "summary_grammar"]:
            out.append({"id": c, "ok": True, "confidence": 0.95, **checks.get(c, {})})
        return {"checks": out, "enrichment": checks.get("enrichment", {})}
    fake_llm.on("triage.assess", respond)


@pytest.fixture(autouse=True)
def _llm(fake_llm):
    ok_llm(fake_llm)


def test_good_alert_passes_with_clean_post(ctx):
    r = triage(ctx, GOOD_ALERT)
    assert r.ok and r.outputs["verdict"] == "PASS" and r.outputs["has_clean"] == "yes"
    text = r.outputs["clean_text"]
    assert "TRG-1001" in text and "SLA 15 min" in text and "✍️ T&S recommended: Gemini hallucination" in text
    case = ctx.store.get_case("TRG-1001")
    assert case.status == CaseStatus.VERIFIED and case.track == "HIGH_ENGAGEMENT" and case.clean_posted_at
    assert triage(ctx, GOOD_ALERT).data["duplicate"] is True


def test_not_alert_and_own_message_are_ignored(ctx):
    assert triage(ctx, "hey team, anyone around?", sender_name="Pat", sender_type="HUMAN").outputs["summary"] == "not an alert"
    assert "own message" in triage(ctx, "🤖 Needs Burson · TRG-1", sender_name="Triage Agent").outputs["summary"]


def test_p0_urgent_leadership_protocol_and_draft_note(ctx):
    r = triage(ctx, alert(1, Exposure_Tag="Product - Dangerous results (e.g. medical/legal)", Total_Engagement="40",
                          Likes="30", Comments="8", Shares="2", Alert_Name="[URGENT] [NEW] Gemini App – Gemini gives unsafe dosage advice",
                          Issue_Name="Gemini gives unsafe medication dosage advice"))
    case = ctx.store.get_case(r.outputs["case_id"])
    assert case.track == "URGENT" and case.priority == "P0"
    assert r.outputs["has_dm"] == "yes" and "lead1@alerts.test" in r.outputs["dm_recipients"]
    assert "🔔 leadership protocol" in r.outputs["clean_text"]
    assert "connect Gmail" in r.outputs["clean_text"]  # no Gmail gateway in tests
    assert case.leadership_pinged_at is not None


def test_below_threshold_is_suppressed(ctx):
    r = triage(ctx, alert(2, Exposure_Tag="Product - Meme about Google products", Total_Engagement="300",
                          Likes="250", Comments="30", Shares="20"))
    assert r.outputs["verdict"] == "SUPPRESSED" and r.outputs["has_clean"] == "no"
    ev = ctx.events.query(types=[EventType.TRIAGE_SUPPRESSED])[0]
    assert ev.payload["reason"] == "below_threshold"


def test_ongoing_urgent_needs_kof(ctx):
    p0 = dict(Exposure_Tag="Product - Offensive or explicit results", Total_Engagement="50", Likes="50", Comments="0", Shares="0",
              Issue_Name="Gemini image tool generates offensive caricatures",
              Alert_Name="[URGENT] [NEW] Gemini App – offensive caricatures")
    first = triage(ctx, alert(3, **p0))
    assert first.outputs["verdict"] in ("PASS", "CORRECTED")
    second = triage(ctx, alert(4, **{**p0, "Issue_Name": "Gemini image tool generating offensive caricatures"}))
    assert second.outputs["verdict"] == "SUPPRESSED"
    assert ctx.events.query(types=[EventType.TRIAGE_SUPPRESSED])[0].payload["reason"] == "ongoing_no_kof"
    third = triage(ctx, alert(5, **{**p0, "KOF": "Yes", "KOF Lists": "P0 KOFs"}))
    assert third.outputs["verdict"] == "CORRECTED"
    case = ctx.store.get_case(third.outputs["case_id"])
    status_fix = [c for c in case.latest.result.corrections if c.field == "issue_status"][0]
    assert status_fix.new == "Ongoing Issue" and case.latest.result.assessment.related_case_id == first.outputs["case_id"]
    assert "[ONGOING]" in case.alert_name


def test_mechanical_corrections(ctx):
    r = triage(ctx, alert(6, Product="Gems", Social_Network="Reddit", Total_Engagement="2100", Engagement_Level="LOW"))
    assert r.outputs["verdict"] == "CORRECTED"
    fixes = {c["field"]: c["new"] for c in r.data["corrections"] if c["applied"]}
    assert fixes["product"] == "Gemini App" and fixes["social_network"] == "X" and fixes["total_engagement"] == 2450
    assert fixes["engagement_level"] == "HIGH"
    assert "✏️ Corrected:" in r.outputs["clean_text"] and '"Gems" → "Gemini App"' in r.outputs["clean_text"]


def test_missing_link_bounces_to_burson_then_rerun_passes(ctx, clock):
    bad = alert(7, drop=("View Post",))
    r = triage(ctx, bad)
    assert r.outputs["verdict"] == "FAIL" and r.outputs["has_burson"] == "yes"
    assert "burson1@agency.test" in r.outputs["burson_text"] and "Needs Burson" in r.outputs["burson_text"]
    clock.advance(minutes=20)
    # Burson reruns with the link: the record key differs (no link before), so the open FAILED case is
    # matched by name and the rerun is its second attempt (no more Burson re-pings, time-to-correction counted).
    rerun = triage(ctx, alert(7), message_id="rerun-1", create_time=clock.now)
    assert rerun.outputs["verdict"] == "PASS" and rerun.outputs["case_id"] == r.outputs["case_id"]
    case = ctx.store.get_case(r.outputs["case_id"])
    assert case.status == CaseStatus.VERIFIED and len(case.attempts) == 2 and case.record_key
    ev = [e for e in ctx.events.query(types=[EventType.TRIAGE_PASSED]) if e.case_id == case.case_id][0]
    assert ev.payload["after_bounce"] and ev.payload["time_to_correction_s"] == 1200


def test_bounced_rerun_matching_is_narrow(ctx, clock):
    bad = triage(ctx, alert(9, drop=("View Post",)))
    assert bad.outputs["verdict"] == "FAIL"
    # A different issue with a link is a new case, not a rerun of the bounced one.
    other = triage(ctx, alert(10, Issue_Name="Gemini refuses to summarize court rulings",
                              Alert_Name="[HIGH ENGAGEMENT] [NEW] Gemini App – Refuses to summarize court rulings"))
    assert other.outputs["case_id"] != bad.outputs["case_id"]
    # After the match window the bounced case is no longer matched.
    clock.advance(hours=49)
    late = triage(ctx, alert(9), message_id="late-rerun", create_time=clock.now)
    assert late.outputs["case_id"] not in (bad.outputs["case_id"], other.outputs["case_id"])


def test_rerun_of_failed_case_reports_time_to_correction(ctx, clock):
    r = triage(ctx, alert(8, Author=""), message_id="m1")  # author missing -> unfixable -> FAIL
    assert r.outputs["verdict"] == "FAIL"
    clock.advance(minutes=30)
    rerun = triage(ctx, alert(8), message_id="m2", create_time=clock.now)
    assert rerun.outputs["verdict"] == "PASS" and rerun.outputs["case_id"] == r.outputs["case_id"]
    ev = [e for e in ctx.events.query(types=[EventType.TRIAGE_PASSED]) if e.case_id == r.outputs["case_id"]][0]
    assert ev.attempt == 2 and ev.payload["after_bounce"] and ev.payload["time_to_correction_s"] == 1800


def test_llm_correction_applied_or_held_for_review(ctx, fake_llm):
    ok_llm(fake_llm, exposure_tag_fit={"ok": False, "confidence": 0.92, "finding": "medical claim",
                                       "proposed_value": "Product - Dangerous results (e.g. medical/legal)"})
    r = triage(ctx, alert(9))
    assert r.outputs["verdict"] == "CORRECTED"
    assert ctx.store.get_case(r.outputs["case_id"]).priority == "P0"
    ok_llm(fake_llm, exposure_tag_fit={"ok": False, "confidence": 0.62, "finding": "maybe offensive",
                                       "proposed_value": "Product - Offensive or explicit results"})
    held = triage(ctx, alert(10))
    assert held.outputs["verdict"] == "NEEDS_REVIEW"
    assert held.outputs["dm_recipients"] == "im1@ops.test" and "forward TRG-" in held.outputs["dm_text"]


def test_exclusions(ctx):
    drive = triage(ctx, alert(11, Post_Content="my notes https://docs.google.com/document/d/abc", Exposure_Tag="Product - Other/general criticism"))
    assert drive.outputs["verdict"] == "SUPPRESSED"
    comp = triage(ctx, alert(12, Exposure_Tag="Brand - Other/general criticism",
                             Post_Content="ChatGPT is better than Gemini, switched to Claude", Total_Engagement="5000",
                             Likes="5000", Comments="0", Shares="0"))
    assert comp.outputs["verdict"] == "SUPPRESSED"
    reasons = [e.payload["reason"] for e in ctx.events.query(types=[EventType.TRIAGE_SUPPRESSED])]
    assert "EXCLUDED_DRIVE_LINK" in reasons and "EXCLUDED_AI_COMPARISON" in reasons


def test_redundant_risk_tag_and_politics_rules(ctx):
    privacy = triage(ctx, alert(13, Exposure_Tag="Product - Privacy & security concerns", Risk_Tags="Privacy",
                                Total_Engagement="100", Likes="100", Comments="0", Shares="0"))
    assert privacy.outputs["verdict"] == "SUPPRESSED"  # Privacy restates the tag -> not sensitive -> P1 below 2K
    india = triage(ctx, alert(14, Exposure_Tag="Product - Meme about Google products", Risk_Tags="World Politics",
                              Location="India", Total_Engagement="100", Likes="100", Comments="0", Shares="0"))
    assert india.outputs["verdict"] == "SUPPRESSED"
    election = triage(ctx, alert(15, Exposure_Tag="Product - Meme about Google products", Risk_Tags="World Politics",
                                 Location="India", Post_Content="Gemini refuses to talk about the election",
                                 Total_Engagement="100", Likes="100", Comments="0", Shares="0"))
    assert election.outputs["verdict"] in ("PASS", "CORRECTED")
    assert ctx.store.get_case(election.outputs["case_id"]).track == "URGENT"


def test_youtube_and_doodle_protocols(ctx):
    yt = triage(ctx, alert(16, Product="YouTube", Exposure_Tag="Product - Other/general criticism",
                           Issue_Name="YouTube ads are too long", Alert_Name="[HIGH ENGAGEMENT] [NEW] YouTube – ads too long",
                           Summary="Users complain about long YouTube ads", Post_Content="youtube ads are unbearable"))
    assert yt.outputs["has_youtube"] == "yes" and "no email" in yt.outputs["clean_text"]
    assert "[YOUTUBE CHAT]" in ctx.store.get_case(yt.outputs["case_id"]).alert_name
    low = triage(ctx, alert(17, Product="YouTube", Exposure_Tag="Product - Other/general criticism", Issue_Name="YouTube premium price",
                            Total_Engagement="100", Likes="100", Comments="0", Shares="0", Post_Content="youtube premium costs too much"))
    assert low.outputs["verdict"] == "SUPPRESSED"
    doodle = triage(ctx, alert(18, Product="Doodles", Exposure_Tag="Content - Negative reaction to Google site content",
                               Issue_Name="Backlash over today's Doodle", Total_Engagement="10", Likes="10", Comments="0", Shares="0"))
    assert doodle.outputs["has_doodle"] == "yes" and "Doodle team" in doodle.outputs["doodle_text"]


def test_meets_p0_flag_conflict_goes_to_review(ctx):
    r = triage(ctx, alert(19, header="🚨 Burson Automated Alert\nThis alert meets P0 criteria",
                          Exposure_Tag="Product - Feature request"))
    assert r.outputs["verdict"] == "NEEDS_REVIEW"


def test_review_forward_bounce_and_permissions(ctx, fake_llm):
    ok_llm(fake_llm, exposure_tag_fit={"ok": False, "confidence": 0.6, "proposed_value": "Product - Unexpected Responses"})
    held = triage(ctx, alert(20))
    cid = held.outputs["case_id"]
    denied = handle({"op": "review_decision", "payload": {"case_id": cid, "decision": "forward", "actor": "random@outsider.invalid"}}, ctx)
    assert "Only Incident Managers" in denied.outputs["reply_text"]
    fwd = handle({"op": "review_decision", "payload": {"case_id": cid, "decision": "forward", "actor": "im1@ops.test",
                                                       "fields": {"exposure_tag": "Product - Factual inaccuracies (not dangerous/offensive)"}}}, ctx)
    assert fwd.outputs["has_clean"] == "yes" and ctx.store.get_case(cid).status == CaseStatus.VERIFIED
    held2 = triage(ctx, alert(21))
    bounced = handle({"op": "review_decision", "payload": {"case_id": held2.outputs["case_id"], "decision": "bounce",
                                                           "actor": "admin@ops.test", "reason": "wrong post"}}, ctx)
    assert bounced.outputs["has_burson"] == "yes" and "IM note: wrong post" in bounced.outputs["burson_text"]


def test_revert_correction_posts_update(ctx):
    r = triage(ctx, alert(22, Product="Gems"))
    cid = r.outputs["case_id"]
    rev = handle({"op": "revert_correction", "payload": {"case_id": cid, "field": "product", "actor": "admin@ops.test"}}, ctx)
    assert rev.ok and rev.outputs["has_clean"] == "yes" and "reverted" in rev.outputs["clean_text"]
    assert ctx.events.query(types=[EventType.CORRECTION_REVERTED])
    assert ctx.store.get_case(cid).latest.result.normalized["product"] == "Gems"


def test_update_attempt_reposts_changes(ctx, clock):
    first = triage(ctx, alert(23), message_id="u1")
    clock.advance(hours=2)
    upd = triage(ctx, alert(23, Total_Engagement="5100", Likes="4500", Comments="400", Shares="200"), message_id="u2")
    assert upd.outputs["case_id"] == first.outputs["case_id"]
    assert "🔁 *Update*" in upd.outputs["clean_text"] and "2,450 → 5,100" in upd.outputs["clean_text"]


def test_record_key_and_tokens():
    assert normalize_url("https://mobile.twitter.com/a/status/123?s=20") == "x.com/status/123"
    assert normalize_url("https://youtu.be/abc123?t=4") == "youtube.com/watch?v=abc123"
    assert normalize_url("www.reddit.com/r/google/comments/xyz/title/") == "reddit.com/comments/xyz"
    a = issue_tokens("Gemini image tool generates offensive caricatures", ["google", "issue"])
    b = issue_tokens("Gemini image tool generating offensive caricatures", ["google", "issue"])
    assert jaccard(a, b) >= 0.6


def test_forward_after_store_round_trip_keeps_post_date_typed(ctx, fake_llm):
    ok_llm(fake_llm, exposure_tag_fit={"ok": False, "confidence": 0.74, "finding": "claims of political bias",
                                       "proposed_value": "Product - Perceived bias"})
    r = triage(ctx, alert(11))
    assert r.outputs["verdict"] == "NEEDS_REVIEW"
    # review_decision reloads the case from the store (JSON): post_date must not turn into a format warning
    fwd = handle({"op": "review_decision", "payload": {"case_id": r.outputs["case_id"], "decision": "forward",
                  "fields": {"exposure_tag": "Product - Perceived bias"}, "actor": "im1@ops.test",
                  "via": "chat"}}, ctx)
    assert fwd.ok and fwd.outputs["has_clean"] == "yes"
    assert "Post Date should be" not in fwd.outputs["clean_text"]


def test_revert_of_derived_priority_sticks(ctx):
    # Burson says P1, but the tag is P0: the priority is derived from the tag (a rule correction).
    r = triage(ctx, alert(24, Exposure_Tag="Product - Dangerous results (e.g. medical/legal)", Priority="P1",
                          Alert_Name="[URGENT] [NEW] Gemini App – Gemini gives unsafe dosage advice",
                          Issue_Name="Gemini gives unsafe medication dosage advice"))
    cid = r.outputs["case_id"]
    fix = [c for c in ctx.store.get_case(cid).latest.result.corrections if c.field == "priority" and c.applied]
    assert fix and fix[0].old == "P1" and fix[0].new == "P0"
    rev = handle({"op": "revert_correction", "payload": {"case_id": cid, "field": "priority", "actor": "admin@ops.test"}}, ctx)
    assert rev.ok and "reverted" in rev.outputs["clean_text"]
    result = ctx.store.get_case(cid).latest.result
    assert result.normalized["priority"] == "P1"
    assert not [c for c in result.corrections if c.field == "priority" and c.applied and not c.reverted_by]
    again = handle({"op": "revert_correction", "payload": {"case_id": cid, "field": "priority", "actor": "admin@ops.test"}}, ctx)
    assert "No applied correction on 'priority'" in again.outputs["reply_text"]  # nothing left to revert

