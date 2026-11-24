"""The alert workspace: the brief, the Social Alert email, the Trust & Safety form, temp checks and QA evaluations.

The Console routes, the settings, the store, the Gmail stand-in (in memory) and the fake Gemini are the ones every other
Console test uses. What these tests hold to: no model ever supplies a number, an edited email is cleaned before Gmail
gets it, the draft follows Testing, and an evaluation's score is the one counted here.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

import pytest

from test_console_api import ADMIN, IM, VIEWER, api, console_ctx, seeded  # noqa: F401 - fixtures
from triage_agent import qa_evals, safety, tempcheck, workspace
from triage_agent.escalation import alert_html
from triage_agent.models import CaseStatus, ProposalStatus
from triage_agent.ownalerts import review as own_review


def a_case(api, status: CaseStatus = CaseStatus.VERIFIED) -> str:
    """An alert nobody has started an email or a T&S form for yet."""
    return next(c.case_id for c in api.ctx.store.list_cases(statuses=[status], limit=200)
                if c.attempts and not c.escalation_ids and not api.ctx.store.list_escalations(case_id=c.case_id, limit=5))


def drafts(api, who: str = IM) -> list[dict[str, Any]]:
    return api.ctx.gmail.drafts_for(who)


# -- opening an alert ------------------------------------------------------------------------------------------------------
def test_the_workspace_opens_with_everything_an_analyst_works_an_alert_with(api):
    case_id = a_case(api)
    got = api.get(f"/api/workspace/{case_id}", user=IM)
    assert got.status_code == 200
    data = got.json()
    assert set(data) >= {"card", "brief", "email", "tns", "temp", "qa", "events", "legend", "can_act"} and data["can_act"] is True
    assert data["card"]["case_id"] == case_id and data["card"]["alert_text"]
    assert data["brief"]["stale"] is True and data["brief"]["by"] == "rules" and data["brief"]["facts"], "no model is asked just to open it"
    email = data["email"]
    assert email["status"] == "new" and "SOCIAL ALERT" in email["subject"] and "Alert Details" in email["html"] and "Emoji Key" in email["html"]
    assert [c["id"] for c in data["qa"]["rubric"]["criteria"]] == ["call", "fields", "classification", "writing", "routing"]
    assert api.get(f"/api/workspace/{case_id}", user=VIEWER).json()["can_act"] is False
    assert api.get("/api/workspace/TRG-0", user=IM).status_code == 404


def test_the_email_template_follows_the_engagement_level_and_keeps_the_teams_layout(api):
    case = api.ctx.store.get_case(a_case(api))
    v = alert_html.values(api.ctx, case)
    for level, color in alert_html.HEADER_COLORS.items():
        page = alert_html.social_alert_html({**v, "level": level})
        assert f"background-color: {color}" in page and f"border-bottom: 2px solid {color}" in page
    page = alert_html.social_alert_html({**v, "summary": "<b>not markup</b> & more", "owned": True, "stamp": "[02:15]"})
    assert "&lt;b&gt;not markup&lt;/b&gt; &amp; more" in page, "the alert's words are text, never markup"
    assert "owned social alerts once sentiment reaches 40% negativity" in page and "Timestamp in the video: [02:15]" in page
    for part in ("View Post", "View All Alerts", "Create Custom Alerts Digest", "Was this alert useful?", "Code: "):
        assert part in page
    assert alert_html.subject(v) == f"{v['square']}SOCIAL ALERT{v['square']}: {v['product']} | {v['issue']} | {v['network']} | {v['count']} Engagements"


# -- the brief ---------------------------------------------------------------------------------------------------------------
def test_gemini_words_the_brief_once_and_a_number_it_made_up_is_thrown_away(api):
    case_id = a_case(api)
    api.ctx.llm.on("workspace.brief", {"headline": "A post says Gemini got a fact wrong", "saying": "The post shows a wrong answer.",
                                      "happening": "It is verified and waits to be acknowledged.", "watch": ["Check the screenshot."]})
    first = api.post(f"/api/workspace/{case_id}/brief", {}, user=IM).json()
    assert (first["by"], first["headline"], first["stale"]) == ("gemini", "A post says Gemini got a fact wrong", False)
    assert first["next_steps"] and first["facts"], "the facts and the next steps are the system's, beside the wording"
    asked = len(api.ctx.llm.calls)
    assert api.get(f"/api/workspace/{case_id}", user=IM).json()["brief"]["by"] == "gemini" and len(api.ctx.llm.calls) == asked, "kept, not asked again"

    api.ctx.llm.on("workspace.brief", {"headline": "Wrong answer", "saying": "It reached 987654321 people.", "happening": "Verified.", "watch": []})
    again = api.post(f"/api/workspace/{case_id}/brief", {"refresh": True}, user=IM).json()
    assert again["by"] == "rules" and "987654321" in again["why_plain"] and "987654321" not in again["saying"]


def test_the_next_steps_are_decided_from_the_case_not_by_a_model(api):
    held = api.ctx.store.get_case(a_case(api, CaseStatus.NEEDS_REVIEW))
    assert workspace.next_steps(api.ctx, held, [])[0] == "Decide: send it on, send it back to Burson, or suppress it."
    assert workspace.new_numbers("up 40% to 3,686 in 2 hours", "3686 engagements, 2 hours") == ["40"]


# -- the email -----------------------------------------------------------------------------------------------------------------
def test_an_edited_email_is_cleaned_and_written_to_the_analysts_own_gmail_draft(api):
    api.ctx.gmail = safety.SafeGmail(api.ctx.gmail, lambda: api.ctx)  # as every deployed context has it (context.build_context)
    case_id = a_case(api)
    start = api.get(f"/api/workspace/{case_id}", user=IM).json()["email"]
    edited = start["html"].replace("</body>", '<p onclick="steal()">My note</p><script>alert(1)</script><img src="http://x.test/a.png">'
                                              '<a href="javascript:alert(1)">bad</a></body>')
    body = {"subject": "  Edited   subject ", "to": ["lead@alerts.test"], "cc": [], "bcc": [], "html": edited}
    assert api.put(f"/api/workspace/{case_id}/email", body, user=VIEWER).status_code == 403
    saved = api.put(f"/api/workspace/{case_id}/email", body, user=IM)
    assert saved.status_code == 200, saved.text
    email = saved.json()["email"]
    assert email["status"] == "drafted" and email["edited"] is True and email["subject"] == "Edited subject"
    for gone in ("<script", "onclick", "javascript:", "http://x.test"):
        assert gone not in email["html"]
    assert "My note" in email["html"] and "Alert Details" in email["html"]
    [draft] = drafts(api)
    assert draft["subject"] == "Edited subject" and "My note" in draft["html_body"] and "<script" not in draft["html_body"]
    assert "My note" in draft["body"] and "<p" not in draft["body"] and "</" not in draft["body"], "the plain-text copy holds the words, not the markup"
    assert api.ctx.config.platform.safety.testing is True and draft["to"] == [], "Testing with no stand-in: the draft is addressed to nobody"

    body["subject"] = "Edited again"
    again = api.put(f"/api/workspace/{case_id}/email", body, user=IM).json()["email"]
    assert again["status"] == "redrafted" and len(drafts(api)) == 1 and drafts(api)[0]["subject"] == "Edited again", "the same draft, updated"
    esc = next(e for e in api.ctx.store.list_escalations(case_id=case_id, limit=20) if e.analyst_email == IM)
    assert [v.instruction for v in esc.email_for("alert").versions] == [workspace.CONSOLE_EDIT], "an edit over an edit is one version"

    reset = api.post(f"/api/workspace/{case_id}/email/reset", {}, user=IM).json()["email"]
    assert reset["edited"] is False and "My note" not in reset["html"] and "SOCIAL ALERT" in reset["subject"]


def test_an_email_that_is_not_one_is_refused_and_a_sent_one_cannot_be_changed(api):
    case_id = a_case(api)
    html = api.get(f"/api/workspace/{case_id}", user=IM).json()["email"]["html"]
    bad = api.put(f"/api/workspace/{case_id}/email", {"subject": "S", "to": ["not an address"], "cc": [], "bcc": [], "html": html}, user=IM)
    assert bad.status_code == 409 and "not an email address" in bad.json()["error"]
    assert api.put(f"/api/workspace/{case_id}/email", {"subject": "S", "to": [], "cc": [], "bcc": [], "html": html}, user=IM).status_code == 200
    api.ctx.gmail.mark_sent(drafts(api)[0]["draft_id"])
    late = api.put(f"/api/workspace/{case_id}/email", {"subject": "S2", "to": [], "cc": [], "bcc": [], "html": html}, user=IM)
    assert late.status_code == 409 and "already sent" in late.json()["error"]
    assert api.get(f"/api/workspace/{case_id}", user=IM).json()["email"]["status"] == "sent"


# -- Trust & Safety -------------------------------------------------------------------------------------------------------------
def test_the_trust_and_safety_form_is_filled_in_once_then_submitted_or_discarded_by_a_person(api):
    case_id = a_case(api)
    assert api.get(f"/api/workspace/{case_id}", user=IM).json()["tns"]["state"] is None
    assert api.post(f"/api/workspace/{case_id}/tns", {"action": "submitted"}, user=IM).status_code == 409, "nothing to submit yet"
    made = api.post(f"/api/workspace/{case_id}/tns", {"action": "prepare"}, user=IM).json()["tns"]
    assert made["state"]["prefill_url"].startswith("https://docs.google.com/forms/") and made["mine"] is True
    again = api.post(f"/api/workspace/{case_id}/tns", {"action": "prepare"}, user=IM).json()["tns"]
    assert again["state"]["prepared_at"] == made["state"]["prepared_at"], "made once"
    gone = api.post(f"/api/workspace/{case_id}/tns", {"action": "discard"}, user=IM).json()["tns"]
    assert gone["state"]["status"] == "WITHDRAWN"
    api.post(f"/api/workspace/{case_id}/tns", {"action": "prepare"}, user=IM)
    done = api.post(f"/api/workspace/{case_id}/tns", {"action": "submitted"}, user=IM).json()["tns"]
    assert done["state"]["status"] == "SUBMITTED" and done["state"]["submitted_by"] == IM
    assert api.post(f"/api/workspace/{case_id}/tns", {"action": "discard"}, user=IM).status_code == 409
    assert api.post(f"/api/workspace/{case_id}/tns", {"action": "prepare"}, user=VIEWER).status_code == 403


# -- temp checks ------------------------------------------------------------------------------------------------------------------
@pytest.fixture
def check(api, monkeypatch):
    monkeypatch.setattr(tempcheck, "write_up", lambda ctx, c, update=None: setattr(c, "writeup_text", f"TL;DR: {c.gem['summary']}"))
    made = tempcheck.TempCheck(check_id="TC-900", issue="Gemini wrong answer", status="complete", created_at=api.ctx.now(), total=3686,
                               case_id=a_case(api), title="Gemini wrong answer", writeup_text="TL;DR: 3,686 mentions so far.",
                               gem={"summary": "People share a wrong answer; 3,686 mentions so far.", "drivers": "Mockery of the answer.",
                                    "themes": "[Screenshots](#1) of the answer."})
    tempcheck._save(api.ctx, made)
    return made


def test_a_temp_checks_written_lines_are_reworded_but_never_given_new_figures(api, check):
    api.ctx.llm.on("temp_check.revise", {"summary": "A wrong answer is being shared widely; 3,686 mentions so far.", "drivers": "Mockery of the answer.",
                                        "themes": "[Screenshots](#1) of the answer."})
    ok = api.post("/api/temp-checks/TC-900/revise", {"instruction": "Make the summary plainer"}, user=IM)
    assert ok.status_code == 200 and ok.json()["changed"] is True
    kept = tempcheck.get(api.ctx, "TC-900")
    assert kept.gem["summary"].startswith("A wrong answer is being shared widely") and kept.actions[-1]["action"] == "revised"
    assert kept.gem["edits"][-1]["asked"] == "Make the summary plainer" and kept.gem["edits"][-1]["by"] == IM

    api.ctx.llm.on("temp_check.revise", {"summary": "Now 9,999 mentions and rising 45%.", "drivers": "Mockery.", "themes": "Screenshots."})
    no = api.post("/api/temp-checks/TC-900/revise", {"instruction": "Say it has grown"}, user=IM)
    assert no.status_code == 409 and "never counted" in no.json()["error"] and "9999" in no.json()["error"]
    assert tempcheck.get(api.ctx, "TC-900").gem["summary"].startswith("A wrong answer"), "left as it was"
    assert api.post("/api/temp-checks/TC-900/revise", {"instruction": "x"}, user=VIEWER).status_code == 403
    assert api.post("/api/temp-checks/TC-000/revise", {"instruction": "x"}, user=IM).status_code == 404


def test_a_temp_check_is_sent_to_the_analysts_space_through_the_queue(api, check):
    before = {i.outbox_id for i in api.ctx.store.list_outbox(undelivered_only=False, limit=1000)}
    sent = api.post("/api/temp-checks/TC-900/share", {}, user=IM)
    assert sent.status_code == 200, sent.text
    [item] = [i for i in api.ctx.store.list_outbox(undelivered_only=False, limit=1000) if i.outbox_id not in before]
    assert item.target == "clean" and item.source == "temp_check_share" and "Temp check" in item.text, "queued for the analysts' space only"
    assert tempcheck.get(api.ctx, "TC-900").actions[-1]["action"] == "sent"


# -- QA evaluations -----------------------------------------------------------------------------------------------------------------
def test_the_score_is_counted_here_from_the_ratings_and_their_weights():
    assert qa_evals.score("case", {"call": 5, "fields": 5, "classification": 5, "writing": 5, "routing": 5}) == {"score": 100.0, "grade": "pass", "rated": 5, "of": 5}
    assert qa_evals.score("case", {"call": 1, "fields": 1})["score"] == 0.0
    # call (weight 3) rated 2 = 0.25; fields (weight 2) rated 4 = 0.75: (3 * 0.25 + 2 * 0.75) / 5 = 0.45
    assert qa_evals.score("case", {"call": 2, "fields": 4, "writing": None}) == {"score": 45.0, "grade": "fail", "rated": 2, "of": 5}
    assert qa_evals.score("agent_alert", {"raise": 4, "severity": 3})["grade"] == "needs_work"  # (3 * 0.75 + 2 * 0.5) / 5 = 65
    assert qa_evals.score("case", {})["score"] is None


def test_an_evaluation_is_kept_read_back_by_gemini_and_put_to_use_step_by_step(api):
    case_id = a_case(api)
    api.ctx.llm.on("qa.comprehend", {"understood": "The analyst says the alert should have been held, and the exposure tag was right.",
                                    "lessons": ["Hold an alert for review when its post link is missing."]})
    body = {"subject_type": "case", "subject_id": case_id, "ratings": {"call": 2, "fields": 4}, "comment": "It should have been held: no post link.",
            "verdict": "NEEDS_REVIEW"}
    assert api.post("/api/qa-evals", body, user=VIEWER).status_code == 403
    made = api.post("/api/qa-evals", body, user=IM)
    assert made.status_code == 200, made.text
    ev = made.json()["eval"]
    assert (ev["score"], ev["grade"], ev["evaluator"], ev["id"][:4]) == (45.0, "fail", IM, "QAE-")
    assert ev["comprehension"]["by"] == "gemini" and ev["comprehension"]["lessons"] == ["Hold an alert for review when its post link is missing."]
    kinds = [(s["kind"], s["status"]) for s in ev["steps"]]
    assert kinds == [("golden", "done"), ("lesson", "waiting")]
    golden = api.get("/api/golden", user=IM).json()["records"]
    assert next(r for r in golden if r["case_id"] == case_id)["label"] == "corrected", "the alert is now a checked example"
    fact = api.ctx.store.get_fact(ev["steps"][1]["ref"])
    assert fact.status == ProposalStatus.PENDING and fact.source == f"qa_eval:{ev['id']}", "a lesson is used only once a lead approves it"

    report = api.get("/api/qa-evals", user=VIEWER, days=7).json()
    assert report["summary"]["count"] == 1 and report["summary"]["mean_score"] == 45.0 and report["summary"]["grades"]["fail"] == 1
    assert report["summary"]["lessons"]["filed"] == 1 and report["summary"]["lessons"]["waiting"] == 1 and report["summary"]["examples_kept"] == 1
    call = next(c for c in report["criteria"] if c["subject_type"] == "case" and c["id"] == "call")
    assert (call["rated"], call["mean"], call["low"]) == (1, 2.0, 1)

    fact.status = ProposalStatus.APPROVED
    api.ctx.store.save_fact(fact)
    later = api.get("/api/qa-evals", user=VIEWER, days=7).json()
    assert later["evals"][0]["steps"][1]["status"] == "applied" and later["summary"]["lessons"]["applied"] == 1
    assert api.get(f"/api/workspace/{case_id}", user=IM).json()["qa"]["evals"][0]["id"] == ev["id"]


def test_an_evaluation_with_nothing_to_learn_asks_no_model_and_a_made_up_number_is_not_kept(api):
    case_id = a_case(api)
    api.ctx.llm.on("qa.comprehend", lambda call: pytest.fail("no model is asked when the work was right and nothing was written"))
    right = api.post("/api/qa-evals", {"subject_type": "case", "subject_id": case_id, "ratings": {"call": 5, "fields": 5}}, user=IM).json()["eval"]
    assert right["score"] == 100.0 and right["comprehension"]["by"] == "rules" and right["comprehension"]["lessons"] == []
    assert [(s["kind"], s["status"]) for s in right["steps"]] == [("golden", "done")]

    api.ctx.llm.on("qa.comprehend", {"understood": "It was wrong 73 times.", "lessons": ["Be right."]})
    wrong = api.post("/api/qa-evals", {"subject_type": "case", "subject_id": case_id, "ratings": {"call": 1}, "comment": "Wrong call."}, user=IM).json()["eval"]
    assert wrong["comprehension"]["by"] == "rules" and "73" in wrong["comprehension"]["why_plain"] and "73" not in wrong["comprehension"]["understood"]
    assert wrong["comprehension"]["lessons"] == ["Analyst feedback on the call it made: Wrong call."], "the analyst's own words stand"

    assert api.post("/api/qa-evals", {"subject_type": "case", "subject_id": case_id, "ratings": {}}, user=IM).status_code == 422
    assert api.post("/api/qa-evals", {"subject_type": "case", "subject_id": case_id, "ratings": {"call": 9}}, user=IM).status_code == 422
    assert api.post("/api/qa-evals", {"subject_type": "case", "subject_id": "TRG-0", "ratings": {"call": 3}}, user=IM).status_code == 404


# -- the feed ------------------------------------------------------------------------------------------------------------------------
def test_the_feed_lists_the_agents_own_alerts_beside_bursons_and_can_carry_each_message(api):
    now = api.ctx.now().isoformat()
    api.ctx.store.put_doc(own_review.DECISIONS, "D-1", {"id": "D-1", "at": now, "status": "raised", "severity": "P1", "path": "PR_COMMS",
                                                        "rationale": "A story about an outage is growing fast.", "links": ["https://x.example/1"],
                                                        "verdict": "", "rule": "Outage"})
    api.ctx.store.put_doc(own_review.DECISIONS, "D-2", {"id": "D-2", "at": now, "status": "raised", "severity": "P2", "path": "BRAND_SOCIAL",
                                                        "rationale": "Already judged.", "links": [], "verdict": "TRUE_POSITIVE"})
    feed = api.get("/api/feed", user=IM, view="all", hours=72).json()
    assert {a["id"] for a in feed["agent_alerts"]} == {"D-1", "D-2"} and feed["cards"] and "alert_text" not in feed["cards"][0]
    first = next(a for a in feed["agent_alerts"] if a["id"] == "D-1")
    assert (first["kind"], first["needs"], first["title"]) == ("agent", "verdict", "A story about an outage is growing fast.")
    waiting = api.get("/api/feed", user=IM, view="action", hours=72).json()
    assert [a["id"] for a in waiting["agent_alerts"]] == ["D-1"], "needs action: raised and not yet judged"
    assert api.get("/api/feed", user=IM, view="all", kind="burson").json()["agent_alerts"] == []
    only = api.get("/api/feed", user=IM, view="all", kind="agent").json()
    assert only["cards"] == [] and len(only["agent_alerts"]) == 2
    assert api.get("/api/feed", user=IM, view="review").json()["agent_alerts"] == []
    assert api.get("/api/feed", user=IM, view="all", full=True).json()["cards"][0]["alert_text"]
    assert [c["id"] for c in api.get("/api/qa-evals/rubric", user=IM, subject_type="agent_alert").json()["criteria"]][0] == "raise"


def test_what_the_agent_did_not_raise_is_its_own_view_and_one_alert_opens_by_its_id(api):
    now = api.ctx.now().isoformat()
    long_ago = (api.ctx.now() - timedelta(days=12)).isoformat()
    api.ctx.store.put_doc(own_review.DECISIONS, "D-1", {"id": "D-1", "at": now, "status": "raised", "severity": "P1", "path": "PR_COMMS",
                                                        "rationale": "A story about an outage is growing fast.", "links": [], "verdict": ""})
    api.ctx.store.put_doc(own_review.DECISIONS, "D-3", {"id": "D-3", "at": now, "status": "passed", "severity": "P3", "path": "BRAND_SOCIAL",
                                                        "rationale": "One post with little reach: not raised.", "links": [], "verdict": ""})
    api.ctx.store.put_doc(own_review.DECISIONS, "D-4", {"id": "D-4", "at": long_ago, "status": "raised", "severity": "P0", "path": "PR_COMMS",
                                                        "rationale": "Raised twelve days ago.", "links": [], "verdict": "", "rule": "Outage",
                                                        "section": "4.2", "trigger": "MET_IN_CODE", "item_type": "POST", "kof": "A KOF"})
    passed = api.get("/api/feed", user=IM, view="passed", kind="agent", hours=720).json()
    assert [(a["id"], a["status"], a["needs"]) for a in passed["agent_alerts"]] == [("D-3", "passed", "")] and passed["cards"] == []
    assert api.get("/api/feed", user=IM, view="passed").json()["cards"] == [], "no case is ever listed as not raised"
    assert api.get("/api/feed", user=IM, view="passed", kind="burson").json()["agent_alerts"] == []
    for view in ("action", "all"):  # what was not raised is never mixed in with the alerts
        listed = api.get("/api/feed", user=IM, view=view, hours=72).json()["agent_alerts"]
        assert [(a["id"], a["status"]) for a in listed] == [("D-1", "raised")]
    one = api.get("/api/feed/agent-alerts/D-4", user=IM).json()  # older than the list goes back: a link in Chat still opens it
    assert (one["id"], one["status"], one["needs"], one["title"]) == ("D-4", "raised", "verdict", "Raised twelve days ago.")
    assert (one["rule"], one["section"], one["trigger"], one["item_type"], one["kof"]) == ("Outage", "4.2", "MET_IN_CODE", "POST", "A KOF"), \
        "what the alert's window says about why it was looked at"
    assert api.get("/api/feed/agent-alerts/D-3", user=IM).json()["status"] == "passed"
    assert api.get("/api/feed/agent-alerts/D-404", user=IM).status_code == 404
