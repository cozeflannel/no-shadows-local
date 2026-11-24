"""Evaluations and the lessons in them: one person evaluates an alert, and a lesson is put to use only when nothing goes
against it.

What these tests hold to:
  * the first person to submit owns an alert's evaluation: they may revise it, nobody else may submit one;
  * with the switch off a lesson waits for a lead and no model is asked; with it on, a lesson is in use at once only when
    the contradiction check finds nothing against it, and anything else (a conflict, no answer, a label the check was not
    shown) holds it for a lead;
  * the lessons in use are read where they are said to be read: by the alert reviewer on every alert, and by the agent's
    own alert review;
  * a lead can take a lesson out of use.

The Console routes, the store and the fake Gemini are the ones every other Console test uses.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

import pytest

from test_console_api import ADMIN, IM, LEAD, api, console_ctx, seeded  # noqa: F401 - fixtures
from test_own_review import item, queued, world  # noqa: F401 - fixtures
from test_platform import assess_ok, triage
from test_workspace import a_case
from triage_agent import audit, knowledge, lessons, qa_evals
from triage_agent.events import EventType
from triage_agent.models import KnowledgeFact, ProposalStatus
from triage_agent.ownalerts import review as own_review

OTHER = "ben.okafor@roster.test"  # another analyst on the demo roster
LESSON = "Hold an alert for review when its post link is missing."


def switch(api, on: bool = True) -> None:
    flags = {**api.ctx.config.platform.flags.model_dump(mode="json"), lessons.SWITCH: on}
    assert api.put("/api/platform/flags", {"value": flags}, user=ADMIN).status_code == 200


def reads(api, *taught: str, understood: str = "The analyst says the call was wrong.") -> None:
    api.ctx.llm.on("qa.comprehend", {"understood": understood, "lessons": list(taught)})


def grade(api, case_id: str, who: str = IM, call: int = 2, comment: str = "It should have been held: no post link.", **more: Any):
    return api.post("/api/qa-evals", {"subject_type": "case", "subject_id": case_id, "ratings": {"call": call, "fields": 4}, "comment": comment, **more}, user=who)


def lesson_steps(ev: dict[str, Any]) -> list[dict[str, Any]]:
    return [s for s in ev["steps"] if s["kind"] == "lesson"]


def fact(ctx, n: int, text: str, scope: str, status: ProposalStatus = ProposalStatus.APPROVED, source: str = "qa_eval:QAE-0") -> KnowledgeFact:
    f = KnowledgeFact(fact_id=f"FACT-9{n}", text=text, source=source, created_by=IM, created_at=ctx.now(), status=status, scope=scope,
                      decided_by=LEAD if status != ProposalStatus.PENDING else None, decided_at=ctx.now() if status != ProposalStatus.PENDING else None)
    ctx.store.save_fact(f)
    return f


# -- one person evaluates an alert ---------------------------------------------------------------------------------------
def test_the_first_to_submit_owns_the_evaluation_and_nobody_else_may_submit_one(api):
    case_id = a_case(api)
    reads(api)
    before = api.get(f"/api/workspace/{case_id}", user=OTHER).json()["qa"]["standing"]
    assert before == {"evaluator": None, "eval_id": None, "mine": False, "can_submit": True}
    first = grade(api, case_id).json()["eval"]
    assert first["revision"] == 0 and first["evaluator"] == IM

    theirs = api.get(f"/api/workspace/{case_id}", user=OTHER).json()["qa"]
    assert theirs["standing"] == {"evaluator": IM, "eval_id": first["id"], "mine": False, "can_submit": False}
    assert [e["id"] for e in theirs["evals"]] == [first["id"]], "everyone can read it"
    for who in (OTHER, LEAD, ADMIN):  # a lead or an admin is one more person: the evaluation is not theirs either
        refused = grade(api, case_id, who=who, call=5)
        assert refused.status_code == 409 and "One person evaluates an alert" in refused.json()["error"] and IM in refused.json()["error"]
    assert len(api.ctx.store.list_docs(qa_evals.COLLECTION, where={"subject_id": case_id}, limit=10)) == 1, "nothing was kept for the others"
    mine = api.get("/api/qa-evals/subject", user=IM, subject_type="case", subject_id=case_id).json()["standing"]
    assert mine == {"evaluator": IM, "eval_id": first["id"], "mine": True, "can_submit": True}


def test_the_owner_revises_the_same_evaluation_and_its_earlier_version_is_kept(api):
    case_id = a_case(api)
    reads(api)
    first = grade(api, case_id).json()["eval"]
    assert first["score"] == 45.0  # (3 * 0.25 + 2 * 0.75) / 5
    again = grade(api, case_id, call=4, comment="On a second look the call was nearly right.")
    assert again.status_code == 200, again.text
    revised = again.json()["eval"]
    assert revised["id"] == first["id"] and revised["revision"] == 1 and revised["first_at"] == first["at"]
    assert revised["score"] == 75.0, "counted again from the new ratings: (3 * 0.75 + 2 * 0.75) / 5"
    assert [(h["score"], h["grade"], h["comment"]) for h in revised["history"]] == [(45.0, "fail", "It should have been held: no post link.")]
    report = api.get("/api/qa-evals", user=IM, days=7).json()
    assert report["summary"]["count"] == 1 and report["summary"]["revised"] == 1 and report["summary"]["mean_score"] == 75.0, "one alert, one evaluation"
    assert sorted(e.action for e in audit.search(api.ctx) if e.action.startswith("qa_eval.")) == ["qa_eval.revise", "qa_eval.submit"]


def test_an_alert_the_agent_raised_is_evaluated_by_one_person_too(api):
    api.ctx.store.put_doc(own_review.DECISIONS, "D-7", {"id": "D-7", "at": api.ctx.now().isoformat(), "status": "raised", "severity": "P1", "path": "PR_COMMS",
                                                        "rationale": "A story about an outage is growing fast.", "links": [], "verdict": ""})
    body = {"subject_type": "agent_alert", "subject_id": "D-7", "ratings": {"raise": 3, "severity": 4}}
    made = api.post("/api/qa-evals", body, user=IM)
    assert made.status_code == 200, made.text
    assert api.post("/api/qa-evals", body, user=OTHER).status_code == 409
    seen = api.get("/api/qa-evals/subject", user=OTHER, subject_type="agent_alert", subject_id="D-7").json()
    assert seen["standing"]["evaluator"] == IM and seen["standing"]["can_submit"] is False and len(seen["evals"]) == 1


def test_evaluations_kept_before_the_rule_stay_readable_and_the_first_persons_stands(api):
    case_id = a_case(api)
    now = api.ctx.now()
    for n, who, minutes in ((1, OTHER, 30), (2, IM, 20)):  # two people graded it, before one person evaluated an alert
        api.ctx.store.put_doc(qa_evals.COLLECTION, f"QAE-9{n}", {
            "id": f"QAE-9{n}", "subject_type": "case", "subject_id": case_id, "case_id": case_id, "title": "x", "work": {}, "evaluator": who,
            "at": (now - timedelta(minutes=minutes)).isoformat(), "ratings": {"call": 3}, "comment": "", "corrections": {},
            "score": 50.0, "grade": "needs_work", "rated": 1, "of": 5, "comprehension": {"by": "rules", "understood": "", "lessons": []}, "steps": []})
    seen = api.get(f"/api/workspace/{case_id}", user=IM).json()["qa"]
    assert [e["id"] for e in seen["evals"]] == ["QAE-91", "QAE-92"], "the one that stands first, the other kept after it"
    assert seen["standing"] == {"evaluator": OTHER, "eval_id": "QAE-91", "mine": False, "can_submit": False}
    assert grade(api, case_id, who=IM).status_code == 409


# -- the switch off: as it always was ------------------------------------------------------------------------------------
def test_with_the_switch_off_a_lesson_waits_for_a_lead_and_no_check_is_run(api):
    case_id = a_case(api)
    assert api.ctx.config.platform.flags.lessons_auto_apply is False, "off in the code: an admin turns it on"
    reads(api, LESSON)
    api.ctx.llm.on(lessons.PURPOSE, lambda call: pytest.fail("no check is run while the switch is off"))
    [step] = lesson_steps(grade(api, case_id).json()["eval"])
    kept = api.ctx.store.get_fact(step["ref"])
    assert step["status"] == "waiting" and "Waiting for a lead" in step["note"]
    assert (kept.status, kept.scope, kept.check, kept.decided_by) == (ProposalStatus.PENDING, lessons.ALERT_REVIEW, None, None)


# -- the switch on: the contradiction check ------------------------------------------------------------------------------
def test_a_lesson_nothing_goes_against_is_in_use_at_once(api):
    case_id = a_case(api)
    doc = knowledge.save_doc(api.ctx, actor=LEAD, title="Missing links", text="An alert with no post link cannot be verified by the reader.")
    standing = fact(api.ctx, 1, "Name the product exactly as the distribution list does.", lessons.ALERT_REVIEW)
    switch(api)
    reads(api, LESSON)
    api.ctx.llm.on(lessons.PURPOSE, {"finding": "nothing_against", "against": [], "same_as": ""})
    [step] = lesson_steps(grade(api, case_id).json()["eval"])
    kept = api.ctx.store.get_fact(step["ref"])
    assert (kept.status, kept.decided_by, kept.scope) == (ProposalStatus.APPROVED, lessons.CHECKER, lessons.ALERT_REVIEW)
    assert kept.check["result"] == "clear" and kept.check["by"] == "gemini" and kept.check["read"]["lessons"] == 1 and kept.check["read"]["passages"] >= 1
    read = kept.check["read"]
    assert read["documents_kept"] >= 1 and 1 <= read["documents"] <= read["documents_kept"], "what it was compared with is counted and kept"
    assert step["status"] == "applied" and step["note"].startswith("In use: compared with ") and "1 lesson in use, and Gemini found nothing it goes against." in step["note"]
    assert f"{read['passages']} passage" in step["note"] and "The alert reviewer reads it on every alert" in step["note"]
    asked = next(c for c in api.ctx.llm.calls if c["purpose"] == lessons.PURPOSE)
    assert LESSON in asked["prompt"] and f"[{doc.doc_id}]" in asked["prompt"] and f"[{standing.fact_id}]" in asked["prompt"], "it is shown what it is compared with"
    assert any(e.payload.get("id") == kept.fact_id and e.payload.get("via") == "contradiction_check" for e in api.events(EventType.FACT_APPROVED))
    report = api.get("/api/qa-evals", user=IM, days=7).json()["summary"]["lessons"]
    assert (report["filed"], report["applied"], report["held"], report["waiting"]) == (1, 1, 0, 0)


def test_a_lesson_that_goes_against_a_document_is_held_for_a_lead_with_what_it_goes_against(api):
    case_id = a_case(api)
    doc = knowledge.save_doc(api.ctx, actor=LEAD, title="Missing links", text="An alert with no post link is passed when the screenshot shows the post.")
    switch(api)
    reads(api, LESSON)
    api.ctx.llm.on(lessons.PURPOSE, {"finding": "goes_against",
                                     "against": [{"ref": f"[{doc.doc_id}]", "why": "The document passes an alert with no link when a screenshot shows the post."}]})
    [step] = lesson_steps(grade(api, case_id).json()["eval"])
    kept = api.ctx.store.get_fact(step["ref"])
    assert kept.status == ProposalStatus.PENDING and kept.check["result"] == "conflict", "not in use"
    assert kept.check["against"] == [{"ref": doc.doc_id, "title": "Missing links", "kind": "document",
                                      "why": "The document passes an alert with no link when a screenshot shows the post."}]
    assert step["status"] == "held" and doc.doc_id in step["note"] and "Missing links" in step["note"] and "Held for a lead" in step["note"]
    listed = next(f for f in api.get("/api/facts", user=LEAD).json()["facts"] if f["fact_id"] == kept.fact_id)
    assert listed["standing"]["status"] == "held" and listed["check"]["against"][0]["ref"] == doc.doc_id, "the lead sees why it was held"

    assert api.post(f"/api/facts/{kept.fact_id}", {"decision": "approve"}, user=LEAD).status_code == 200  # the lead's call stands over the check's
    [after] = lesson_steps(api.get(f"/api/workspace/{case_id}", user=IM).json()["qa"]["evals"][0])
    assert after["status"] == "applied" and f"approved by {LEAD}" in after["note"]


@pytest.mark.parametrize("answer, why", [
    (lambda call: (_ for _ in ()).throw(RuntimeError("the model is down")), "Gemini could not be asked"),
    ({}, "Gemini could not be asked"),  # an empty answer says neither "nothing" nor "these": it is no answer
    ({"against": [], "same_as": ""}, "Gemini could not be asked"),  # nor does one that leaves out which it is
    ({"finding": "goes_against", "against": [{"ref": "KD-not-shown", "why": "It says otherwise."}]}, "named something it was not shown"),
    ({"finding": "nothing_against", "against": [{"ref": "KD-not-shown", "why": "It says otherwise."}]}, "named something it was not shown"),
    ({"finding": "goes_against", "against": []}, "named nothing"),
])
def test_a_lesson_that_could_not_be_checked_is_held_not_applied(api, answer, why):
    case_id = a_case(api)
    knowledge.save_doc(api.ctx, actor=LEAD, title="Missing links", text="An alert with no post link cannot be verified.")
    switch(api)
    reads(api, LESSON)
    api.ctx.llm.on(lessons.PURPOSE, answer)
    [step] = lesson_steps(grade(api, case_id).json()["eval"])
    kept = api.ctx.store.get_fact(step["ref"])
    assert kept.status == ProposalStatus.PENDING and kept.check["result"] == "unchecked" and why in kept.check["why"]
    assert step["status"] == "held" and "could not be checked" in step["note"]


def test_a_reason_with_a_made_up_number_is_dropped_and_the_conflict_stands(api):
    case_id = a_case(api)
    doc = knowledge.save_doc(api.ctx, actor=LEAD, title="Missing links", text="An alert with no post link is passed.")
    switch(api)
    reads(api, LESSON)
    api.ctx.llm.on(lessons.PURPOSE, {"finding": "nothing_against", "against": [{"ref": doc.doc_id, "why": "It contradicts 4821 earlier alerts."}]})
    [step] = lesson_steps(grade(api, case_id).json()["eval"])
    kept = api.ctx.store.get_fact(step["ref"])
    assert kept.status == ProposalStatus.PENDING and kept.check["result"] == "conflict", "what it named stands, whatever it called its finding"
    assert kept.check["against"][0]["why"] == "" and "4821" not in step["note"]


def test_the_same_lesson_is_not_filed_twice(api):
    switch(api)
    standing = fact(api.ctx, 2, LESSON, lessons.ALERT_REVIEW)
    reads(api, "hold an alert for review, when its post link is MISSING")  # the same words, written differently
    api.ctx.llm.on(lessons.PURPOSE, lambda call: pytest.fail("the same words are found here: no model is asked"))
    before = len(api.ctx.store.list_facts(limit=500))
    [step] = lesson_steps(grade(api, a_case(api)).json()["eval"])
    assert step["ref"] == standing.fact_id and step["status"] == "applied" and f"Already in use as {standing.fact_id}" in step["note"]
    assert len(api.ctx.store.list_facts(limit=500)) == before, "nothing new was filed"


def test_gemini_may_say_a_lesson_in_use_already_says_the_same(ctx, fake_llm):
    ctx.config.platform.flags.lessons_auto_apply = True
    standing = fact(ctx, 3, "Review by hand any alert that comes with no link to the post.", lessons.ALERT_REVIEW)
    fake_llm.on(lessons.PURPOSE, {"finding": "nothing_against", "against": [], "same_as": standing.fact_id})
    step = lessons.file(ctx, LESSON, IM, source="qa_eval:QAE-1", scope=lessons.ALERT_REVIEW)
    assert step == {"kind": "lesson", "status": "applied", "ref": standing.fact_id, "text": LESSON, "same": True}
    fake_llm.on(lessons.PURPOSE, {"finding": "nothing_against", "against": [], "same_as": "KD-a-document"})  # only a lesson can be the same lesson
    assert lessons.check(ctx, "Something else entirely.", lessons.ALERT_REVIEW)["result"] == "clear"


def test_with_no_document_and_no_lesson_in_use_no_model_is_asked_and_the_lesson_says_so(ctx, fake_llm):
    ctx.config.platform.flags.lessons_auto_apply = True
    fake_llm.on(lessons.PURPOSE, lambda call: pytest.fail("there is nothing to compare it with"))
    found = lessons.check(ctx, LESSON, lessons.ALERT_REVIEW)
    assert found["result"] == "clear" and found["by"] == "rules" and found["read"] == {"lessons": 0, "passages": 0, "documents": 0, "documents_kept": 0}
    step = lessons.file(ctx, LESSON, IM, source="qa_eval:QAE-1", scope=lessons.ALERT_REVIEW)
    word, note = lessons.standing(ctx.store.get_fact(step["ref"]))
    assert word == "applied" and note.startswith("In use: there was no knowledge document and no lesson in use to compare it with."), "it does not claim a comparison that was not made"


def test_when_documents_are_kept_the_lesson_is_always_compared_with_some_of_them(ctx, fake_llm, monkeypatch):
    for n in range(3):  # nothing in them shares a word with the lesson
        knowledge.save_doc(ctx, actor=LEAD, title=f"Roster note {n}", text=f"Weekend cover rota number {n}: swaps are agreed by Thursday noon.")
    monkeypatch.setattr(lessons, "KNOWLEDGE_CHARS", 150)  # the documents do not all fit: the nearest passages are picked
    assert knowledge.retrieve(ctx, LESSON, top_k=24, budget_chars=150) == [], "by relevance alone nothing would be read"
    fake_llm.on(lessons.PURPOSE, {"finding": "nothing_against", "against": [], "same_as": ""})
    found = lessons.check(ctx, LESSON, lessons.ALERT_REVIEW)
    assert found["result"] == "clear" and found["by"] == "gemini" and found["read"]["documents_kept"] == 3
    prompt = next(c for c in fake_llm.calls if c["purpose"] == lessons.PURPOSE)["prompt"]
    in_front = prompt.count("Weekend cover rota")
    assert 1 <= in_front < 3, "some fit, not all"
    assert found["read"]["passages"] == in_front == found["read"]["documents"], "it says it was compared with exactly what was put in front of the check"

    monkeypatch.setattr(lessons, "KNOWLEDGE_CHARS", 20)  # documents are kept and not one of them fits
    fake_llm.on(lessons.PURPOSE, lambda call: pytest.fail("with no document in front of it the check is not run"))
    held = lessons.check(ctx, "Another lesson entirely.", lessons.ALERT_REVIEW)
    assert held["result"] == "unchecked" and "none could be read" in held["why"] and held["read"]["passages"] == 0


def test_a_lesson_is_checked_against_the_lessons_of_its_own_reader_only(ctx, fake_llm):
    fact(ctx, 4, "Raise a story once three verified accounts report it.", lessons.AGENT_ALERTS)
    fake_llm.on(lessons.PURPOSE, lambda call: pytest.fail("a lesson for the other reviewer is not compared"))
    assert lessons.check(ctx, LESSON, lessons.ALERT_REVIEW)["result"] == "clear"


# -- a revision ----------------------------------------------------------------------------------------------------------
def test_a_revision_keeps_a_lesson_it_still_teaches_and_withdraws_one_it_no_longer_does(api):
    case_id = a_case(api)
    switch(api)
    api.ctx.llm.on(lessons.PURPOSE, {"finding": "nothing_against", "against": [], "same_as": ""})
    reads(api, LESSON)
    [first] = lesson_steps(grade(api, case_id).json()["eval"])
    other = "Name the product exactly as the distribution list does."
    reads(api, LESSON, other)
    kept, added = lesson_steps(grade(api, case_id, comment="And the product was named loosely.").json()["eval"])
    assert kept["ref"] == first["ref"] and added["ref"] != first["ref"] and added["status"] == "applied", "the first lesson stands; it is not filed again"
    reads(api, other)
    steps = lesson_steps(grade(api, case_id, comment="Only the product name was wrong.").json()["eval"])
    assert [(s["ref"], s["status"]) for s in steps] == [(added["ref"], "applied"), (first["ref"], "rejected")]
    gone = api.ctx.store.get_fact(first["ref"])
    assert gone.status == ProposalStatus.REJECTED and gone.decided_by == lessons.REVISED and "Withdrawn" in steps[1]["note"]
    assert [f.fact_id for f in lessons.in_use(api.ctx, lessons.ALERT_REVIEW)] == [added["ref"]]


# -- where the lessons in use are read -----------------------------------------------------------------------------------
def test_the_alert_reviewer_reads_the_lessons_in_use_on_every_alert(ctx, fake_llm):
    used = fact(ctx, 1, LESSON, lessons.ALERT_REVIEW)
    theirs = fact(ctx, 2, "Raise a story once three verified accounts report it.", lessons.AGENT_ALERTS)
    waiting = fact(ctx, 3, "Pass every alert about a competitor.", lessons.ALERT_REVIEW, status=ProposalStatus.PENDING)
    taught = fact(ctx, 4, "The weekend lead is on call from Friday.", "", source="chat")
    assert not ctx.config.platform.flags.knowledge_rag, "the documents are not read: the lessons are, all the same"
    assess_ok(fake_llm, citations=[used.fact_id])
    assert triage(ctx).ok
    prompt = next(c for c in fake_llm.calls if c["purpose"] == "triage.assess")["prompt"]
    assert f"[{used.fact_id}] {lessons.TITLE} (guidance: overrides documents)\n{LESSON}" in prompt
    for other in (theirs, waiting, taught):
        assert other.text not in prompt, "not the other reviewer's lessons, not one waiting for a lead, not a fact taught in Chat"
    result = ctx.store.get_case("TRG-1001").latest.result
    assert "lessons" in result.checks_run and [c["ref"] for c in result.extra["citations"]] == [used.fact_id], "the alert says which lesson was relied on"


def test_with_no_lesson_in_use_the_reviewer_is_asked_exactly_as_before(ctx, fake_llm):
    fact(ctx, 3, "Pass every alert about a competitor.", lessons.ALERT_REVIEW, status=ProposalStatus.PENDING)
    assess_ok(fake_llm)
    assert triage(ctx).ok
    call = next(c for c in fake_llm.calls if c["purpose"] == "triage.assess")
    assert call["prompt"].startswith("<alert>") and "lessons" not in ctx.store.get_case("TRG-1001").latest.result.checks_run


def test_the_agents_own_alert_review_is_handed_the_lessons_from_evaluations_of_its_alerts(ctx, fake_llm, world):  # noqa: F811
    mine = fact(ctx, 1, "Raise a story once three verified accounts report it.", lessons.AGENT_ALERTS)
    fact(ctx, 2, LESSON, lessons.ALERT_REVIEW)
    queued(world, item(1))
    own_review.run(ctx)
    [call] = [c for c in fake_llm.calls if c["purpose"] == "own.review"]
    assert f"Standing lesson from an analyst's evaluation ({mine.fact_id}), follow it: {mine.text}" in call["prompt"]
    assert LESSON not in call["prompt"] and "standing lesson" in call["system"].lower()


def test_a_lesson_filed_before_lessons_had_a_reader_gets_it_from_its_evaluation(api):
    api.ctx.store.put_doc(qa_evals.COLLECTION, "QAE-77", {"id": "QAE-77", "subject_type": "case", "subject_id": "TRG-1", "evaluator": IM, "at": api.ctx.now().isoformat()})
    old = fact(api.ctx, 5, LESSON, "", source="qa_eval:QAE-77")
    assert [f.fact_id for f in lessons.in_use(api.ctx, lessons.ALERT_REVIEW)] == [old.fact_id]
    assert api.ctx.store.get_fact(old.fact_id).scope == lessons.ALERT_REVIEW, "worked out once, then kept"


# -- a lead's say ----------------------------------------------------------------------------------------------------------
def test_a_lead_can_take_a_lesson_out_of_use(api):
    used = fact(api.ctx, 6, LESSON, lessons.ALERT_REVIEW)
    used.decided_by = lessons.CHECKER  # put to use by the check, with no lead
    api.ctx.store.save_fact(used)
    assert api.post(f"/api/facts/{used.fact_id}", {"decision": "withdraw"}, user=IM).status_code == 403
    assert api.post(f"/api/facts/{used.fact_id}", {"decision": "reject"}, user=LEAD).status_code == 409, "a decided fact is not decided again: taking it out of use is its own decision"
    assert api.ctx.store.get_fact(used.fact_id).status == ProposalStatus.APPROVED
    out = api.post(f"/api/facts/{used.fact_id}", {"decision": "withdraw"}, user=LEAD)
    assert out.status_code == 200, out.text
    now = api.ctx.store.get_fact(used.fact_id)
    assert now.status == ProposalStatus.REJECTED and now.decided_by == LEAD and lessons.in_use(api.ctx, lessons.ALERT_REVIEW) == []
    assert lessons.standing(now) == ("rejected", f"Not in use: turned down by {LEAD}.")
    assert any(e.payload.get("id") == used.fact_id and e.payload.get("withdrawn") for e in api.events(EventType.FACT_REJECTED))
    for decision in ("approve", "withdraw"):
        assert api.post(f"/api/facts/{used.fact_id}", {"decision": decision}, user=LEAD).status_code == 409, "what was taken out stays out"
    waiting = fact(api.ctx, 7, "Pass every alert about a competitor.", lessons.ALERT_REVIEW, status=ProposalStatus.PENDING)
    assert api.post(f"/api/facts/{waiting.fact_id}", {"decision": "withdraw"}, user=LEAD).status_code == 409, "only what is in use can be taken out of use"
    listing = api.get("/api/facts", user=LEAD).json()
    assert listing["auto_apply"] is False and next(f for f in listing["facts"] if f["fact_id"] == used.fact_id)["standing"]["status"] == "rejected"
