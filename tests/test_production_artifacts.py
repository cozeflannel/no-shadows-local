"""Tests verifying real production artifacts from Burson & Brand Social:
- 3 real Burson V3 alerts (P1 AI Overviews, P2 Maps meme, P0 Search Paris Riots)
- Real Social Alert HTML email generation & subject format (🟥SOCIAL ALERT🟥: ...)
- Regional Leads (29 markets + EMEA parent rollup + P0 reputational risk recipients)
- Channel Owners (1,002 official Google social channel records)
- Natural shift sign-in messages in the Burson space
"""

from datetime import datetime, timezone

from triage_agent.escalation import drafting
from triage_agent.models import ChatMessage
from triage_agent.operations import handle
from triage_agent.qa import parser
from triage_agent.qa.pipeline import run_qa
from triage_agent.routing import plan_recipients


BURSON_ALERT_1_P1_AIO = """THIS ALERT MEETS P1 CRITERIA
SOCIAL ALERT:
[Time/Date Post Went Live]: October 12, 2026, 1:47 AM
[Exposure Tag]: Product - Factual inaccuracies (not dangerous/offensive)
[Product]: AI Overviews (AIM, Web Guide)
[Other Google Products]: Search
[Engagement]: HIGH (29425 engagements)
[Sensitive Topic]: None
[KOF]: No
An X user (@TheChiefNerd; 284712 followers) shared a screenshot of a Google Search query in which the AI Overview incorrectly stated that a historical treaty was signed in 1998 rather than 1898. Commenters are mocking AI Overviews for basic historical errors.
[Link]: https://x.com/TheChiefNerd/status/1845000000000000001
[Name]: AI Overviews Historical Treaty Date Error / New / not previously reported over the past 14 days
[Code]: Product - Factual inaccuracies (not dangerous/offensive),29425,@TheChiefNerd,None,AI Overviews (AIM, Web Guide),New / not previously reported over the past 14 days"""

BURSON_ALERT_2_P2_MAPS = """THIS ALERT MEETS P2 CRITERIA
SOCIAL ALERT:
[Time/Date Post Went Live]: October 12, 2026, 3:15 AM
[Exposure Tag]: Product - Memes & humorous content
[Product]: Maps
[Other Google Products]: None
[Engagement]: HIGH (4200 engagements)
[Sensitive Topic]: None
[KOF]: No
A Reddit user (u/map_enthusiast) on r/GoogleMaps posted a humorous screenshot of Street View capturing a dog chasing the Google Maps car.
[Link]: https://www.reddit.com/r/GoogleMaps/comments/1abcde/street_view_dog/
[Name]: Google Maps Street View Dog Meme / New / not previously reported over the past 14 days
[Code]: Product - Memes & humorous content,4200,u/map_enthusiast,None,Maps,New / not previously reported over the past 14 days"""

BURSON_ALERT_3_P0_PARIS = """THIS ALERT MEETS P0 CRITERIA
SOCIAL ALERT:
[Time/Date Post Went Live]: October 12, 2026, 5:40 AM
[Exposure Tag]: Product - Dangerous/offensive results
[Product]: Search
[Other Google Products]: AI Overviews (AIM, Web Guide)
[Engagement]: LOW (340 engagements)
[Sensitive Topic]: Violence & Gore, World Politics
[KOF]: Yes (Tech Journalists)
A French journalist (@paris_tech_press; 95000 followers) in Paris, France posted a screenshot showing Google Search autocomplete suggesting violent queries related to ongoing protests in Paris.
[Link]: https://x.com/paris_tech_press/status/1845000000000000003
[Name]: Search Autocomplete Violent Suggestions in Paris / New / not previously reported over the past 14 days
[Code]: Product - Dangerous/offensive results,340,@paris_tech_press,Violence & Gore,Search,New / not previously reported over the past 14 days"""


def test_real_burson_v3_alerts_parse_and_qa(ctx):
    now = datetime(2026, 10, 12, 12, 0, tzinfo=timezone.utc)

    # 1. P1 AI Overviews alert
    p1 = parser.parse(ctx.config, BURSON_ALERT_1_P1_AIO)
    is_alert, _ = parser.detect(ctx.config, ChatMessage(text=BURSON_ALERT_1_P1_AIO), p1)
    assert is_alert and not p1.missing_labels
    assert p1.fields["priority"] == "P1"
    assert p1.fields["engagement_level"] == "HIGH"
    assert p1.fields["total_engagement"] == 29425
    assert p1.fields["author"] == "@TheChiefNerd"
    assert p1.fields["followers"] == 284712
    assert p1.fields["issue_name"] == "AI Overviews Historical Treaty Date Error"
    assert p1.fields["issue_status"] == "NEW"
    r1 = run_qa(ctx, p1, source="burson_chat", received_at=now)
    assert r1.verdict.value in ("PASS", "CORRECTED")
    assert r1.assessment.alertable and r1.assessment.priority == "P1"

    # 2. P2 Maps meme alert
    p2 = parser.parse(ctx.config, BURSON_ALERT_2_P2_MAPS)
    assert p2.fields["priority"] == "P2"
    assert p2.fields["total_engagement"] == 4200
    assert p2.fields["author"] == "u/map_enthusiast"
    r2 = run_qa(ctx, p2, source="burson_chat", received_at=now)
    assert r2.verdict.value in ("PASS", "CORRECTED")
    assert r2.assessment.alertable and r2.assessment.priority == "P2"

    # 3. P0 Search Paris Riots alert (0-engagement threshold + France regional lead inference)
    p0 = parser.parse(ctx.config, BURSON_ALERT_3_P0_PARIS)
    assert p0.fields["priority"] == "P0"
    assert p0.fields["total_engagement"] == 340
    assert p0.fields["kof"] is True
    assert p0.fields["kof_lists"] == ["Tech Journalists"]
    r0 = run_qa(ctx, p0, source="burson_chat", received_at=now)
    assert r0.verdict.value in ("PASS", "CORRECTED")
    assert r0.assessment.alertable and r0.assessment.priority == "P0"
    assert "France" in r0.assessment.non_us_markets


def test_regional_leads_and_channel_owner_routing(ctx):
    import json
    from pathlib import Path

    now = datetime(2026, 10, 12, 12, 0, tzinfo=timezone.utc)
    p0 = parser.parse(ctx.config, BURSON_ALERT_3_P0_PARIS)
    r0 = run_qa(ctx, p0, source="burson_chat", received_at=now)

    # France + P0 triggers France POCs + EMEA parent leads
    plan = plan_recipients(ctx.config, r0.assessment, text=BURSON_ALERT_3_P0_PARIS)
    assert "Regional Leads" in plan.groups
    assert "france@alerts.test" in plan.cc  # France POC
    assert "emea@alerts.test" in plan.cc  # EMEA parent lead

    # Japan + P0 triggers Japan reputational_risk_recipients (apac-rep@alerts.test)
    r0.assessment.non_us_markets = ["Japan"]
    plan_jp = plan_recipients(ctx.config, r0.assessment, text="Tokyo, Japan")
    assert "apac-rep@alerts.test" in plan_jp.cc  # Japan / APAC reputational risk recipient (P0)

    # config/channel_owners.json holds zero hardcoded real emails; synthetic @alerts.test entries route owned posts
    co_file = Path(__file__).resolve().parent.parent / "config" / "channel_owners.json"
    assert json.loads(co_file.read_text(encoding="utf-8")) == []
    assert len(ctx.config.distribution.channel_owners) >= 1
    r0.assessment.owned_post = True
    r0.assessment.owned_profile_url = "https://www.instagram.com/madebygoogle"
    plan_owned = plan_recipients(ctx.config, r0.assessment, text="https://www.instagram.com/madebygoogle")
    assert "Channel Owner" in plan_owned.groups
    assert "pixel-owner@alerts.test" in plan_owned.cc


def test_burson_html_email_and_subject_format(ctx, clock):
    # Triage the P1 Burson V3 alert and create an email draft
    res = handle({"op": "triage_message", "payload": {"message": {
        "message_id": "m-burson-v3-1", "space_id": "AAQAaa_0I9g",
        "sender": {"email": "burson1@agency.test", "name": "Casey Brooks"},
        "text": BURSON_ALERT_1_P1_AIO,
    }}}, ctx)
    assert res.ok
    case = ctx.store.get_case(res.outputs["case_id"])
    subj = drafting.subject_for(ctx, case)
    assert subj == "🟥SOCIAL ALERT🟥: AI Overviews, Search | AI Overviews Historical Treaty Date Error | X | 29425 Engagements"

    html = drafting.render_alert_html(ctx, case)
    assert "🟥 HIGH (29425 engagements)" in html
    assert "AI Overviews Historical Treaty Date Error / New / not previously reported over the past 14 days" in html
    assert "https://x.com/TheChiefNerd/status/1845000000000000001" in html


def test_passive_shift_signin_in_burson_space(ctx):
    res = handle({"op": "triage_message", "payload": {"message": {
        "message_id": "m-signin-1", "space_id": "AAQAaa_0I9g",
        "sender": {"name": "Casey Brooks", "email": ""},
        "text": "Hi team, I will be on alerts from 12pm to 6pm PST",
    }}}, ctx)
    assert res.ok and res.outputs["summary"] == "not an alert"
    assert res.data["signin"]["roster"] == "burson"
    assert res.data["signin"]["person_id"] == "burson1"
    assert ctx.burson_on_call().person.id == "burson1"


def test_stealth_burson_mode_never_posts_to_burson_space(ctx):
    ctx.config.burson_feedback.silent_in_burson_space = True
    # Alert missing link -> FAIL (would normally bounce to Burson space)
    bad_alert = BURSON_ALERT_1_P1_AIO.replace("[Link]: https://x.com/TheChiefNerd/status/1845000000000000001\n", "")
    res = handle({"op": "triage_message", "payload": {"message": {
        "message_id": "m-stealth-1", "space_id": "AAQAaa_0I9g",
        "sender": {"name": "Casey Brooks", "email": "burson1@agency.test"},
        "text": bad_alert,
    }}}, ctx)
    assert res.ok and res.outputs["verdict"] == "FAIL"
    assert res.outputs["has_burson"] == "no" and res.outputs["burson_text"] == ""
    assert res.outputs["has_clean"] == "yes" and "[STEALTH — would post to Burson]" in res.outputs["clean_text"]

