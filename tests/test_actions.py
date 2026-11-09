"""IM emoji-legend actions: record_reaction kinds, idempotency, case lookup, record_post, start_escalation alias."""

from a2_fixtures import IM, connect, events, make_case, reaction
from triage_agent.escalation import service
from triage_agent.events import EventType
from triage_agent.models import CaseStatus, EmailStatus
from triage_agent.operations import handle

FLOW2 = {"flow": "actions", "targets": ["reply", "dm", "crisis"]}


def react(ctx, emoji, case=None, **kw):
    return handle({"op": "record_reaction", "payload": reaction(emoji, case, **kw), "context": FLOW2}, ctx)


def test_ack_acknowledges_once_and_duplicates_are_idempotent(ctx, clock):
    case = make_case(ctx)
    clock.advance(minutes=3)
    first = react(ctx, "👍", case)
    assert first.ok and first.outputs["has_reply"] == "no" and first.outputs["case_id"] == case.case_id
    stored = ctx.store.get_case(case.case_id)
    assert stored.acknowledged_at == clock.now and [a.code for a in stored.actions] == ["ack"]
    ack = events(ctx, EventType.ALERT_ACKNOWLEDGED)
    assert len(ack) == 1 and ack[0].payload["ack_latency_s"] == 180.0 and ack[0].actor == IM
    recorded = events(ctx, EventType.ACTION_RECORDED)[0]
    assert recorded.payload["code"] == "ack" and recorded.payload["emoji"] == "👍" and recorded.case_id == case.case_id

    dup = react(ctx, "👍", case)  # Studio retry / same reaction again
    assert dup.data["duplicate"] is True
    assert len(ctx.store.get_case(case.case_id).actions) == 1 and len(events(ctx, EventType.ACTION_RECORDED)) == 1

    clock.advance(minutes=1)
    react(ctx, "➕", case)  # a second, different action doesn't re-acknowledge
    assert len(events(ctx, EventType.ALERT_ACKNOWLEDGED)) == 1
    assert [a.code for a in ctx.store.get_case(case.case_id).actions] == ["ack", "other_team"]


def test_pa_reaction_drafts_and_reply_lists_groups_missing_and_notes(ctx, clock):
    gmail = connect(ctx, clock, IM)
    case = make_case(ctx, product="Search", exposure_tag="Product - Product failures - general software/service issues",
                     priority="P1")
    r = react(ctx, "📦", case)
    reply = r.outputs["reply_text"]
    esc_id = r.outputs["escalation_id"]
    assert r.outputs["has_reply"] == "yes" and esc_id.startswith("ESC-")
    assert reply.startswith(f"🤖 📨 Draft ready in your Gmail ({IM})") and case.case_id in reply and esc_id in reply
    assert "*Groups:* Search" in reply
    assert "No recipients configured yet for: gUP (social customer support)" in reply
    assert "revise:" in reply and len(reply) <= 3500
    esc = ctx.store.get_escalation(esc_id)
    assert esc.trigger == "reaction" and esc.requested_by == IM and esc.chat_message_ref == f"clean-{case.case_id}"
    assert esc.email_for("alert").status == EmailStatus.DRAFTED and len(gmail.drafts) == 1
    assert events(ctx, EventType.ACTION_RECORDED)[0].payload["escalation_id"] == esc_id
    assert ctx.store.get_case(case.case_id).actions[0].escalation_id == esc_id

    gemini = make_case(ctx)  # Gemini App: execs are suggested, not added -> a note
    notes = react(ctx, "📦", gemini).outputs["reply_text"]
    assert "📝 Gemini App Execs list not added (rule: suggest)" in notes and "add if needed" not in notes

    # reacting 📦 again on the first alert reuses the draft
    again = react(ctx, "📦", case, user=IM, message_id=f"clean-{case.case_id}-update")
    assert "already in your Gmail" in again.outputs["reply_text"] and len(gmail.drafts) == 2


def test_pa_reaction_without_gmail_and_after_send(ctx, clock):
    case = make_case(ctx)
    no_gateway = react(ctx, "📦", case)
    assert "Gmail drafting isn't set up for the agent" in no_gateway.outputs["reply_text"]
    assert "📝" not in no_gateway.outputs["reply_text"], "no routing notes on failures"
    connect(ctx, clock)  # gateway, but the IM never connected
    not_connected = react(ctx, "📦", case, message_id="clean-retry")
    assert "Connect Gmail in the Agent Console" in not_connected.outputs["reply_text"]

    gmail = connect(ctx, clock, IM)
    sent_case = make_case(ctx)
    esc = service.start_escalation(ctx, sent_case, IM, trigger="auto_urgent", requested_by="agent")
    gmail.mark_sent(service.draft_alert_email(ctx, esc, sent_case).draft_id)
    service.check_sent(ctx, esc)
    after = react(ctx, "📦", sent_case)
    assert "already sent" in after.outputs["reply_text"] and after.outputs["escalation_id"] == esc.escalation_id
    assert len(gmail.drafts) == 0


def test_tns_reaction_prefills_form_and_drafts_urgent_email(ctx, clock, fake_llm):
    gmail = connect(ctx, clock, IM)
    fake_llm.on("tns.assess", {"eligible": True, "category": "Harmful hallucination", "criteria_ids": ["viral_kof"],
                               "rationale": "Viral KOF post with a dangerous answer.", "evidence": "replicable",
                               "description": "Gemini recommended a dangerous dose."})
    case = make_case(ctx, is_kof=True)
    r = react(ctx, "✍️", case)
    reply = r.outputs["reply_text"]
    esc = ctx.store.get_escalation(r.outputs["escalation_id"])
    assert esc.tns.status.value == "PREPARED" and esc.tns.urgent
    assert esc.tns.prefill_url in reply and "Evidence: Replicable" in reply
    assert "tns-urgent@alerts.test draft ready" in reply
    assert esc.email_for("tns_urgent").status == EmailStatus.DRAFTED
    assert list(gmail.drafts.values())[0]["to"] == ["tns-urgent@alerts.test"]
    assert events(ctx, EventType.ACTION_RECORDED)[0].payload["code"] == "tns"


def test_add_group_reactions(ctx, clock):
    gmail = connect(ctx, clock, IM)
    case = make_case(ctx)
    react(ctx, "📦", case)
    placeholder = react(ctx, "📰", case)
    assert "No recipients configured for GCPA yet" in placeholder.outputs["reply_text"]
    assert not events(ctx, EventType.EMAIL_GROUP_ADDED)

    civics = react(ctx, "⚖️", case)
    assert "Added Civics to your draft" in civics.outputs["reply_text"] and "Civics" in civics.outputs["reply_text"]
    draft = list(gmail.drafts.values())[0]
    assert "civics@alerts.test" in draft["cc"]
    added = events(ctx, EventType.EMAIL_GROUP_ADDED)
    assert len(added) == 1 and added[0].payload["group"] == "Civics" and added[0].payload["via"] == "reaction"

    # A team reaction before any 📦 creates the alert draft with that team
    other = make_case(ctx)
    first = react(ctx, "💧", other)
    assert "Draft ready in your Gmail" in first.outputs["reply_text"] and "Stop Leaks" in first.outputs["reply_text"]


def test_crisis_and_jon_reactions(ctx):
    case = make_case(ctx)
    crisis = react(ctx, "🔥", case)
    assert crisis.outputs["has_crisis"] == "yes" and case.case_id in crisis.outputs["crisis_text"]
    assert crisis.outputs["crisis_text"].startswith("🤖 🔥") and IM in crisis.outputs["crisis_text"]
    assert crisis.outputs["has_reply"] == "yes"
    jon = react(ctx, "🧑‍💻", case)
    assert jon.outputs["has_dm"] == "yes" and jon.outputs["dm_recipients"] == "lead1@alerts.test"
    assert case.case_id in jon.outputs["dm_text"] and jon.outputs["has_reply"] == "no"
    pings = events(ctx, EventType.PROTOCOL_PINGED)
    assert [e.payload["protocol"] for e in pings] == ["crisis", "jon"]


def test_close_superseded_feedback_and_none(ctx, clock):
    case = make_case(ctx)
    closed = react(ctx, "❌", case)
    assert "Closed" in closed.outputs["reply_text"]
    stored = ctx.store.get_case(case.case_id)
    assert stored.status == CaseStatus.CLOSED and stored.closed_reason == "no_action"
    assert events(ctx, EventType.CASE_CLOSED)[0].payload["reason"] == "no_action"

    old = make_case(ctx, record_key="x.com/status/777")
    clock.advance(minutes=30)
    newer = make_case(ctx, record_key="x.com/status/777")
    sup = react(ctx, "⬇️", old)
    assert newer.case_id in sup.outputs["reply_text"]
    stored = ctx.store.get_case(old.case_id)
    assert stored.superseded_by == newer.case_id and stored.closed_reason == "superseded" and stored.status == CaseStatus.CLOSED
    assert events(ctx, EventType.CASE_CLOSED)[-1].payload["superseded_by"] == newer.case_id

    fb = react(ctx, "👎", newer)
    assert "What should it have been?" in fb.outputs["reply_text"]
    assert ctx.store.get_case(newer.case_id).verdict_overridden_by == IM
    assert events(ctx, EventType.VERDICT_OVERRIDDEN)[0].payload["verdict"] == "PASS"

    plus = react(ctx, "➕", newer)
    assert plus.outputs["has_reply"] == "no" and ctx.store.get_case(newer.case_id).actions[-1].code == "other_team"


def test_case_lookup_unknown_and_by_clean_message_ref(ctx):
    unknown = react(ctx, "👍", None, text="hello there", message_id="m-unknown")
    assert "couldn't match this message to an alert" in unknown.outputs["reply_text"]

    case = make_case(ctx)
    posted = handle({"op": "record_post", "payload": {"case_id": case.case_id.lower(),
                                                       "message_id": "spaces/AAA/messages/BBB.BBB"}}, ctx)
    assert posted.ok and all(posted.outputs[k] == "no" for k in posted.outputs if k.startswith("has_"))
    assert ctx.store.get_case(case.case_id).clean_message_ref == "spaces/AAA/messages/BBB.BBB"
    assert events(ctx, EventType.CLEAN_POSTED)[0].message_ref == "spaces/AAA/messages/BBB.BBB"
    by_ref = react(ctx, "👍", None, text="", message_id="spaces/AAA/messages/BBB.BBB")
    assert by_ref.outputs["case_id"] == case.case_id

    missing = handle({"op": "record_post", "payload": {"case_id": "TRG-9999"}}, ctx)
    assert "can't find TRG-9999" in missing.outputs["reply_text"]


def test_unknown_emoji_and_legacy_start_escalation(ctx, clock):
    case = make_case(ctx)
    ignored = react(ctx, "🦄", case)
    assert ignored.outputs["has_reply"] == "no" and ignored.data["ignored"] == "unknown_emoji"
    assert events(ctx, EventType.MESSAGE_IGNORED)[0].payload["reason"] == "unknown_emoji"

    connect(ctx, clock, IM)
    payload = reaction("👍", case)  # legacy step: emoji is forced to 📦
    legacy = handle({"op": "start_escalation", "payload": payload}, ctx)
    assert "Draft ready in your Gmail" in legacy.outputs["reply_text"]
    assert ctx.store.get_case(case.case_id).actions[-1].code == "pa"

    anonymous = handle({"op": "record_reaction", "payload": {"emoji": "📦", "message": {"text": f"🤖 {case.case_id}",
                                                                                     "message_id": "anon-1"}}}, ctx)
    assert "couldn't tell who reacted" in anonymous.outputs["reply_text"]

    flat = handle({"op": "record_reaction", "payload": {"emoji": "❌", "reactor_email": IM, "message_text": f"🤖 {case.case_id}",
                                                        "message_id": "flat-1"}}, ctx)
    assert flat.ok and ctx.store.get_case(case.case_id).status == CaseStatus.CLOSED
