"""T&S: assessment, pre-filled go/WD-Triage links (encoding, truncation, reference stamp), urgent + bug-ID drafts."""

from urllib.parse import parse_qs, urlparse

from a2_fixtures import IM, IM2, connect, events, make_case
from triage_agent.escalation import service, tns
from triage_agent.events import EventType
from triage_agent.models import EmailStatus, TnsStatus

FORM = "https://docs.google.com/forms/d/e/1FAIpQLScd0beRIurDyc5beuY9_tYDEvp-UFAIKY2FWTdLvsUV4whSkw/viewform"
DESC, TEAM, CATEGORY, LINK, EVIDENCE = "entry.1000000005", "entry.290320498", "entry.1000000003", "entry.1000000001", "entry.1000000006"


def assess_llm(fake_llm, **overrides):
    value = {"eligible": True, "category": "harmful HALLUCINATION", "criteria_ids": ["gemini_hallucination", "made_up"],
             "rationale": "Gemini output is dangerous and the post shows the prompt.", "evidence": "input_shown",
             "description": "Gemini told a user to take 4000mg of ibuprofen at once; the post shows the prompt."}
    value.update(overrides)
    fake_llm.on("tns.assess", value)


def query(url: str) -> dict[str, str]:
    return {k: v[0] for k, v in parse_qs(urlparse(url).query).items()}


def test_assess_and_prepare_builds_prefilled_link(ctx, clock, fake_llm):
    assess_llm(fake_llm)
    case = make_case(ctx, ts_recommended=True, ts_reasons=["Gemini hallucination"], engagement_total=150)
    esc = service.start_escalation(ctx, case, IM, trigger="reaction", requested_by=IM)
    state = tns.assess_and_prepare(ctx, esc, case, IM)

    assert state.status == TnsStatus.PREPARED and state.eligible and not state.urgent
    assert state.category == "Harmful hallucination", "snapped to tns.categories"
    assert state.criteria_ids == ["gemini_hallucination"], "unknown criteria dropped"
    assert state.prefill_url.startswith(FORM + "?usp=pp_url&")
    q = query(state.prefill_url)
    assert q[LINK] == case.latest.result.normalized["post_url"] and q[TEAM] == "Marketing" and q[CATEGORY] == "Harmful hallucination"
    assert q[DESC].startswith(f"[SLRR {esc.escalation_id} / {case.case_id}] Gemini told a user")
    assert q[EVIDENCE].startswith("Input shown")
    assert "%20" in state.prefill_url and " " not in state.prefill_url
    call = fake_llm.calls[-1]
    assert call["purpose"] == "tns.assess" and call["model"] == ctx.config.models.triage and "viral_kof" in call["system"]

    payload = {"eligible": True, "urgent": False, "category": "Harmful hallucination",
               "criteria_ids": ["gemini_hallucination"], "evidence": "input_shown"}
    assessed = events(ctx, EventType.TNS_ASSESSED)[0]
    assert {k: assessed.payload[k] for k in payload} == payload and assessed.actor == IM
    assert events(ctx, EventType.TNS_PREPARED)[0].escalation_id == esc.escalation_id
    assert ctx.store.get_escalation(esc.escalation_id).tns.prefill_url == state.prefill_url
    # ✍️ again: the prepared report is reused (no second assessment)
    assert tns.assess_and_prepare(ctx, esc, case, IM) is esc.tns and len(fake_llm.calls) == 1

    text = tns.prepared_message(ctx, esc, case, state)
    assert text.startswith("🤖 ✍️") and state.prefill_url in text and len(text) <= 3500


def test_not_eligible_still_gets_a_link_and_fallback_without_gemini(ctx, clock, fake_llm):
    assess_llm(fake_llm, eligible=False, category="Other", criteria_ids=[], evidence="none", rationale="Just criticism.")
    case = make_case(ctx, exposure_tag="Product - Other/general criticism", priority="P2")
    esc = service.start_escalation(ctx, case, IM, trigger="reaction", requested_by=IM)
    state = tns.assess_and_prepare(ctx, esc, case, IM)
    assert state.status == TnsStatus.NOT_ELIGIBLE and state.prefill_url and not state.urgent
    assert len(events(ctx, EventType.TNS_NOT_ELIGIBLE)) == 1 and not events(ctx, EventType.TNS_PREPARED)
    assert "Probably not T&S-eligible" in tns.prepared_message(ctx, esc, case, state)

    # Gemini unavailable: the triage recommendation decides (hallucination tag on a Gemini product)
    fake_llm.handlers.pop("tns.assess")
    other = make_case(ctx, ts_recommended=True, ts_reasons=["Gemini hallucination"])
    esc2 = service.start_escalation(ctx, other, IM, trigger="reaction", requested_by=IM)
    fallback = tns.assess_and_prepare(ctx, esc2, other, IM)
    assert fallback.eligible and fallback.category == "Harmful hallucination" and fallback.evidence == "none"
    assert "gemini_hallucination" in fallback.criteria_ids and "Gemini was unavailable" in fallback.rationale
    assert "Evidence needed" in tns.prepared_message(ctx, esc2, other, fallback)


def test_urgent_rules_and_urgent_email(ctx, clock, fake_llm):
    gmail = connect(ctx, clock, IM)
    assess_llm(fake_llm)
    viral = make_case(ctx, is_kof=True, engagement_total=150)
    assert tns.urgent_reasons(ctx.config, viral) == ["viral KOF author"]
    child = make_case(ctx, engagement_total=10, sensitive_topics=["Child Safety"])
    assert tns.urgent_reasons(ctx.config, child) == ["Child Safety"]
    big = make_case(ctx, engagement_total=2000)
    assert tns.urgent_reasons(ctx.config, big) == ["2,000 engagements (≥ 2,000)"]
    calm = make_case(ctx, engagement_total=1999)
    assert tns.urgent_reasons(ctx.config, calm) == []

    esc = service.start_escalation(ctx, viral, IM, trigger="reaction", requested_by=IM)
    state = tns.assess_and_prepare(ctx, esc, viral, IM)
    assert state.urgent
    email = tns.draft_urgent_email(ctx, esc, viral)
    draft = gmail.drafts[email.draft_id]
    assert email.purpose == "tns_urgent" and draft["to"] == ["tns-urgent@alerts.test"]
    assert f"[SLRR {esc.escalation_id} / {viral.case_id}]" in draft["subject"]
    assert "Why urgent: viral KOF author" in draft["body"] and draft["from_header"].startswith("Brand Social")
    drafted = events(ctx, EventType.EMAIL_DRAFTED)[-1]
    assert drafted.payload["purpose"] == "tns_urgent"
    assert tns.draft_urgent_email(ctx, esc, viral).draft_id == email.draft_id, "reused, not duplicated"


def test_prefill_url_encoding_truncation_and_reference(ctx):
    cfg = ctx.config
    ref = "[SLRR ESC-1001 / TRG-1001]"
    fields = {LINK: "https://x.com/a/status/1?x=1&y=2", "entry.1000000002": "Gemini App", CATEGORY: "Other",
              TEAM: "Marketing", DESC: ref + " " + ("Ünïcödé & = ? / text " * 200), EVIDENCE: ""}
    full = tns.build_prefill_url(cfg, fields)
    q = query(full.url)
    assert q[LINK] == "https://x.com/a/status/1?x=1&y=2" and "%26" in full.url and "%3D" in full.url
    assert EVIDENCE not in q, "empty values are left out"
    assert len(q[DESC]) == 1500 and q[DESC].endswith("…") and full.truncated == ["Description"], "max_len per field"
    assert full.fields[DESC] == q[DESC]

    short = tns.build_prefill_url(cfg, fields, max_length=1200, protect={DESC: len(ref) + 1})
    assert len(short.url) <= 1200 and query(short.url)[DESC].startswith(ref)
    assert short.truncated == ["Description"]

    cfg.tns.max_url_length = 400  # even the config limit alone shrinks the description, keeping the stamp
    tiny = tns.build_prefill_url(cfg, fields, protect={DESC: len(ref) + 1})
    assert len(tiny.url) <= 400 and query(tiny.url)[DESC].startswith(ref)

    cfg.tns.form_url = FORM + "?usp=sf_link"
    assert tns.build_prefill_url(cfg, {TEAM: "Marketing"}).url == FORM + f"?usp=pp_url&{TEAM}=Marketing"


def test_parse_helpers(ctx):
    cfg = ctx.config
    assert tns.parse_intake_issue(cfg, "Re: Issue [#12345678]: WD Intake Request") == "12345678"
    assert tns.parse_intake_issue(cfg, "Hello") is None
    assert tns.parse_outcome(cfg, "Status: Fixed") == "Fixed" and tns.parse_outcome(cfg, "marked Infeasible") == "Infeasible"
    assert tns.parse_outcome(cfg, "this will be fixed soon") is None
    assert tns.parse_bug_id(cfg, "Tracked in b/123456789.") == "123456789"
    assert tns.parse_bug_id(cfg, "go/bad/987654321") == "987654321" and tns.parse_bug_id(cfg, "no bug") is None
    assert tns.find_reference(cfg, "desc: [SLRR esc-1207 / TRG-1042] Gemini…") == ("ESC-1207", "TRG-1042")
    assert tns.find_reference(cfg, "[SLRR ESC-1207/TRG-1042]") == ("ESC-1207", "TRG-1042")


def test_bug_followup_replies_in_original_senders_gmail(ctx, clock):
    gmail = connect(ctx, clock, IM, IM2)
    case = make_case(ctx)
    alert_esc = service.start_escalation(ctx, case, IM2, trigger="reaction", requested_by=IM2)
    alert = service.draft_alert_email(ctx, alert_esc, case)
    rfc = gmail.mark_sent(alert.draft_id)
    service.check_sent(ctx, alert_esc)

    tns_esc = service.start_escalation(ctx, case, IM, trigger="reaction", requested_by=IM)
    tns.mark_submitted(ctx, tns_esc, via="intake_email", actor=IM, wd_issue_id="12345678")
    email = tns.record_outcome(ctx, tns_esc, case, outcome="Fixed", bug_id="123456789")
    assert email is not None and email.purpose == "bug_followup" and email.status == EmailStatus.DRAFTED
    draft = gmail.drafts[email.draft_id]
    assert draft["user"] == IM2, "drafted in the Gmail of the IM who sent the alert"
    assert draft["in_reply_to"] == rfc and draft["thread_id"] == alert.thread_id
    assert draft["subject"] == f"Re: {alert.versions[0].subject}" and "b/123456789" in draft["body"]
    outcome = events(ctx, EventType.TNS_OUTCOME)[0]
    assert outcome.payload["outcome"] == "Fixed" and outcome.payload["bug_id"] == "123456789"
    assert outcome.payload["wd_issue_id"] == "12345678"

    # When the follow-up is sent, the T&S escalation records it
    gmail.mark_sent(email.draft_id)
    service.check_sent(ctx, ctx.store.get_escalation(alert_esc.escalation_id))
    assert ctx.store.get_escalation(tns_esc.escalation_id).tns.bug_followup_sent_at == clock.now
    assert events(ctx, EventType.EMAIL_SENT)[-1].payload["purpose"] == "bug_followup"


def test_bug_followup_falls_back_to_im_on_shift(ctx, clock):
    gmail = connect(ctx, clock, IM)  # the original sender (IM2) isn't connected
    case = make_case(ctx)
    tns_esc = service.start_escalation(ctx, case, IM2, trigger="reaction", requested_by=IM2)
    email = tns.record_outcome(ctx, tns_esc, case, outcome="Fixed", bug_id="555555555")
    assert email.status == EmailStatus.DRAFTED and gmail.drafts[email.draft_id]["user"] == IM
    assert email in [m for e in ctx.store.list_escalations(case_id=case.case_id, analyst_email=IM) for m in e.emails]
    assert tns.record_outcome(ctx, tns_esc, case, outcome="Infeasible") is None
