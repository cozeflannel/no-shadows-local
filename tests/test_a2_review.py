"""A2 review: GoogleGmail against Gmail API v1 shapes, revise/reaction retry paths, Burson leakage, intent false positives,
Forms pre-fill encoding. GoogleGmail runs against an in-memory service object (no network)."""

from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from types import SimpleNamespace
from urllib.parse import parse_qs, urlparse

import httplib2
import pytest
from google.auth.exceptions import RefreshError, TransportError
from google.oauth2.credentials import Credentials
from googleapiclient.errors import HttpError

from a2_fixtures import IM, connect, events, make_case, reaction
from conftest import BURSON_SPACE, make_message
from triage_agent.config import TnsField
from triage_agent.converse import handler as handler_mod
from triage_agent.converse.intents import match_regex
from triage_agent.escalation import service, tns
from triage_agent.escalation.gmail import (
    IM_SCOPES, GmailDraftNotFound, GmailError, GmailNotConnected, GoogleGmail, decode_message, encode_message,
    message_fields,
)
from triage_agent.events import EventType
from triage_agent.models import EmailStatus, KnowledgeFact, ProposalStatus
from triage_agent.operations import UserFacingError, handle

BURSON_USER = "burson2@agency.test"  # in the seed Burson roster (org burson)
FLOW2 = {"flow": "actions", "targets": ["reply", "dm", "crisis"]}
TOKEN = {"token": "t", "refresh_token": "r", "client_id": "c", "client_secret": "s",
         "token_uri": "https://oauth2.googleapis.com/token", "expiry": "2999-01-01T00:00:00Z", "scopes": list(IM_SCOPES)}


# ---------------------------------------------------------------------------
# Gmail API v1 test double (users().drafts()/threads()/messages() ... .execute())
# ---------------------------------------------------------------------------


class _Call:
    def __init__(self, svc, name, kwargs):
        self.svc, self.name, self.kwargs = svc, name, kwargs

    def execute(self):
        self.svc.calls.append((self.name, self.kwargs))
        result = self.svc.responses.get(self.name)
        if isinstance(result, BaseException):
            raise result
        return result(self.kwargs) if callable(result) else result


class _Resource:
    def __init__(self, svc, prefix):
        self.svc, self.prefix = svc, prefix

    def __getattr__(self, method):
        return lambda **kwargs: _Call(self.svc, f"{self.prefix}.{method}", kwargs)


class FakeService:
    def __init__(self, **responses):
        self.responses = {k.replace("__", "."): v for k, v in responses.items()}  # drafts__create -> drafts.create
        self.calls: list[tuple[str, dict]] = []

    def users(self):
        return SimpleNamespace(**{r: (lambda r=r: _Resource(self, r)) for r in ("drafts", "threads", "messages")})

    def named(self, name):
        return [kw for n, kw in self.calls if n == name]


class DictVault:
    def __init__(self, data):
        self.data = {k.lower(): dict(v) for k, v in data.items()}
        self.puts: list[str] = []

    def get(self, email):
        return self.data.get((email or "").lower())

    def put(self, email, creds):
        self.data[email.lower()] = dict(creds)
        self.puts.append(email)

    def delete(self, email):
        self.data.pop(email.lower(), None)


def http_error(status: int) -> HttpError:
    return HttpError(httplib2.Response({"status": status}), b'{"error": {"message": "boom"}}')


def google(svc: FakeService, vault: DictVault | None = None) -> GoogleGmail:
    return GoogleGmail(vault or DictVault({IM: TOKEN}), service_factory=lambda creds: svc)


def ms(dt: datetime) -> str:
    return str(int(dt.timestamp() * 1000))


def edited_in_gmail() -> EmailMessage:
    """What Gmail stores after the IM edits a draft in the UI: text + HTML alternative, plus an attachment."""
    msg = EmailMessage()
    msg["From"] = "Brand Social <sender@alerts.test>"
    msg["To"] = "gemini-app@alerts.test, added-by-hand@alerts.test"
    msg["Bcc"] = "hidden@alerts.test"
    msg["Subject"] = "Gemini – unsafe dosage"
    msg.set_content("Edited by the IM in Gmail.")
    msg.add_alternative("<div>Edited by the IM in <b>Gmail</b>.</div>", subtype="html")
    msg.add_attachment(b"\x89PNG...", maintype="image", subtype="png", filename="screenshot.png")
    return msg


# ---------------------------------------------------------------------------
# GoogleGmail
# ---------------------------------------------------------------------------


def test_google_gmail_request_shapes_and_sent_detection():
    svc = FakeService(drafts__create={"id": "r-1", "message": {"id": "m-1", "threadId": "t-9", "labelIds": ["DRAFT"]}})
    gm = google(svc)
    out = gm.create_draft(IM, from_header="Brand Social <sender@alerts.test>", to=["a@alerts.test", "b@alerts.test"],
                          cc=["c@alerts.test"], bcc=["d@alerts.test"], subject="Re: Gemini – dosage ü", body="Héllo – body",
                          in_reply_to="<orig@mail.test>", references=["<root@mail.test>"], thread_id="t-9")
    assert out == {"draft_id": "r-1", "message_id": "m-1", "thread_id": "t-9"}
    (create,) = svc.named("drafts.create")
    assert create["userId"] == "me" and set(create["body"]) == {"message"}
    message = create["body"]["message"]
    assert message["threadId"] == "t-9" and set(message) == {"raw", "threadId"}
    assert not set(message["raw"]) & set("+/"), "base64url alphabet"
    fields = message_fields(decode_message(message["raw"]))
    assert fields["from_header"] == "Brand Social <sender@alerts.test>"
    assert (fields["to"], fields["cc"], fields["bcc"]) == (["a@alerts.test", "b@alerts.test"], ["c@alerts.test"], ["d@alerts.test"])
    assert fields["subject"] == "Re: Gemini – dosage ü" and fields["body"].strip() == "Héllo – body"
    assert fields["in_reply_to"] == "<orig@mail.test>" and fields["references"] == "<root@mail.test> <orig@mail.test>"

    since = datetime(2026, 10, 12, 18, 0, tzinfo=timezone.utc)
    svc.responses["drafts.get"] = http_error(404)  # the draft is gone
    svc.responses["threads.get"] = {"messages": [
        {"id": "m0", "labelIds": ["SENT"], "internalDate": ms(since - timedelta(hours=3)),
         "payload": {"headers": [{"name": "Message-ID", "value": "<orig@mail.test>"}]}},
        {"id": "m2", "labelIds": ["SENT"], "internalDate": ms(since + timedelta(minutes=4)),
         "payload": {"headers": [{"name": "Message-Id", "value": "<new@mail.test>"}]}},  # header case varies
    ]}
    status = gm.draft_status(IM, "r-1", "t-9", since=since, exclude=["<orig@mail.test>"])
    assert status == {"status": "SENT", "rfc822_message_id": "<new@mail.test>", "sent_at": since + timedelta(minutes=4)}
    assert svc.named("drafts.get")[-1]["format"] == "minimal"
    thread_call = svc.named("threads.get")[-1]
    assert thread_call["format"] == "metadata" and "Message-ID" in thread_call["metadataHeaders"]

    svc.responses["threads.get"]["messages"].pop()  # only the original (older, excluded) is SENT
    assert gm.draft_status(IM, "r-1", "t-9", since=since, exclude=["<orig@mail.test>"])["status"] == "DISCARDED"
    svc.responses["threads.get"] = http_error(404)
    assert gm.draft_status(IM, "r-1", "t-9", since=since)["status"] == "DISCARDED"
    assert gm.draft_status(IM, "r-1", None)["status"] == "UNKNOWN"
    svc.responses["drafts.get"] = {"id": "r-1", "message": {"id": "m-1"}}
    assert gm.draft_status(IM, "r-1", "t-9")["status"] == "DRAFT"


def test_google_gmail_partial_update_of_a_draft_edited_in_gmail():
    """Gmail saves UI edits as multipart; set_content() raised TypeError on it, crashing `revise`."""
    raw = encode_message(edited_in_gmail())
    svc = FakeService(drafts__get={"id": "r-1", "message": {"id": "m-1", "threadId": "t-1", "raw": raw}},
                      drafts__update={"id": "r-1", "message": {"id": "m-2", "threadId": "t-1"}})
    gm = google(svc)
    assert gm.get_draft(IM, "r-1")["body"].strip() == "Edited by the IM in Gmail."

    out = gm.update_draft(IM, "r-1", subject="Gemini – unsafe dosage (update)", body="Shorter version.")
    assert out == {"draft_id": "r-1", "message_id": "m-2", "thread_id": "t-1"}
    assert svc.named("drafts.get")[-1]["format"] == "raw"
    (update,) = svc.named("drafts.update")
    assert update["id"] == "r-1" and update["body"]["message"]["threadId"] == "t-1"
    sent = decode_message(update["body"]["message"]["raw"])
    fields = message_fields(sent)
    assert fields["body"].strip() == "Shorter version." and fields["subject"] == "Gemini – unsafe dosage (update)"
    assert fields["to"] == ["gemini-app@alerts.test", "added-by-hand@alerts.test"] and fields["bcc"] == ["hidden@alerts.test"]
    assert [p.get_filename() for p in sent.iter_attachments()] == ["screenshot.png"], "the IM's attachment is kept"

    gm.update_draft(IM, "r-1", cc=["civics@alerts.test"])  # recipients only: the HTML body is untouched
    kept = decode_message(svc.named("drafts.update")[-1]["body"]["message"]["raw"])
    assert kept.get_body(("html",)) is not None and message_fields(kept)["cc"] == ["civics@alerts.test"]


def test_google_gmail_error_mapping():
    svc = FakeService()
    gm = google(svc)
    for exc, expected in ((http_error(404), GmailDraftNotFound), (http_error(401), GmailNotConnected),
                          (http_error(403), GmailError), (RefreshError("invalid_grant: Token has been expired or revoked."),
                                                          GmailNotConnected),
                          (TimeoutError("timed out"), GmailError), (httplib2.ServerNotFoundError("dns"), GmailError),
                          (TransportError("connection reset"), GmailError)):
        svc.responses["drafts.create"] = exc
        with pytest.raises(GmailError) as info:
            gm.create_draft(IM, from_header="f", to=["a@alerts.test"], cc=[], bcc=[], subject="s", body="b")
        assert type(info.value) is expected, (exc, info.value)
    with pytest.raises(GmailNotConnected):
        google(svc, DictVault({})).create_draft(IM, from_header="f", to=[], cc=[], bcc=[], subject="s", body="b")


def test_google_gmail_refreshes_and_persists_tokens(monkeypatch):
    vault = DictVault({IM: {**TOKEN, "expiry": "2000-01-01T00:00:00Z"}})
    svc = FakeService(drafts__get={"id": "r-1", "message": {"id": "m-1"}})

    def refresh(self, request):
        self.token, self.expiry = "fresh-token", datetime.now(timezone.utc).replace(tzinfo=None) + timedelta(hours=1)

    monkeypatch.setattr(Credentials, "refresh", refresh)
    assert google(svc, vault).draft_status(IM, "r-1", "t-1")["status"] == "DRAFT"
    assert vault.puts == [IM] and vault.data[IM]["token"] == "fresh-token" and vault.data[IM]["refresh_token"] == "r"

    def raising(exc):
        def refresh_fails(self, request):
            raise exc
        return refresh_fails

    stale = DictVault({IM: {**TOKEN, "expiry": "2000-01-01T00:00:00Z"}})
    monkeypatch.setattr(Credentials, "refresh", raising(RefreshError("invalid_grant")))
    with pytest.raises(GmailNotConnected, match="reconnect Gmail in the Agent Console"):
        google(svc, stale).draft_status(IM, "r-1", "t-1")
    monkeypatch.setattr(Credentials, "refresh", raising(TransportError("offline")))
    with pytest.raises(GmailError, match="refresh the Gmail token") as info:
        google(svc, stale).draft_status(IM, "r-1", "t-1")
    assert type(info.value) is GmailError and stale.puts == []


def react(ctx, emoji, case=None, **kw):
    return handle({"op": "record_reaction", "payload": reaction(emoji, case, **kw), "context": FLOW2}, ctx)


def test_revise_of_a_draft_edited_in_gmail_through_the_service(ctx, fake_llm):
    raw = encode_message(edited_in_gmail())
    svc = FakeService(
        drafts__create={"id": "r-1", "message": {"id": "m-1", "threadId": "t-1"}},
        drafts__get=lambda kw: {"id": "r-1", "message": {"id": "m-1", "threadId": "t-1", **({"raw": raw} if kw["format"] == "raw" else {})}},
        drafts__update={"id": "r-1", "message": {"id": "m-2", "threadId": "t-1"}},
    )
    ctx.gmail = google(svc)
    case = make_case(ctx)
    esc = service.start_escalation(ctx, case, IM, trigger="reaction", requested_by=IM)
    assert service.draft_alert_email(ctx, esc, case).status == EmailStatus.DRAFTED
    fake_llm.on("escalation.revise_email", {"subject": "x", "body": "Shorter version.", "notes": []})
    revised = service.revise_email(ctx, esc, "shorter", IM)
    assert revised.status == EmailStatus.REDRAFTED and revised.error is None
    assert "Edited by the IM in Gmail." in fake_llm.calls[-1]["prompt"], "the revision starts from the live draft"
    updated = decode_message(svc.named("drafts.update")[-1]["body"]["message"]["raw"])
    assert message_fields(updated)["body"].startswith("Shorter version.")
    assert [p.get_filename() for p in updated.iter_attachments()] == ["screenshot.png"]


def test_gmail_network_failure_and_revoked_token_answer_in_chat(ctx):
    svc = FakeService(drafts__create={"id": "r-1", "message": {"id": "m-1", "threadId": "t-1"}})
    ctx.gmail = google(svc)
    case = make_case(ctx)
    assert "Draft ready in your Gmail" in react(ctx, "📦", case).outputs["reply_text"]

    svc.responses["drafts.get"] = svc.responses["drafts.update"] = TimeoutError("timed out")
    r = react(ctx, "⚖️", case)  # used to crash the op (TimeoutError isn't a GmailError)
    assert r.ok and "couldn't update the draft: Gmail is unreachable" in r.outputs["reply_text"]

    other = make_case(ctx)
    svc.responses["drafts.create"] = RefreshError("invalid_grant: Token has been expired or revoked.")
    revoked = react(ctx, "📦", other)
    assert "Connect Gmail in the Agent Console" in revoked.outputs["reply_text"]


# ---------------------------------------------------------------------------
# Escalation service + reactions: retry paths
# ---------------------------------------------------------------------------


def test_revise_recreates_a_draft_the_im_deleted(ctx, clock, fake_llm):
    gmail = connect(ctx, clock, IM)
    fake_llm.on("escalation.revise_email", {"subject": "s", "body": "Short version.", "notes": []})
    for check_first in (False, True):
        case = make_case(ctx)
        esc = service.start_escalation(ctx, case, IM, trigger="reaction", requested_by=IM)
        old = service.draft_alert_email(ctx, esc, case).draft_id
        gmail.mark_discarded(old)  # its (new) thread goes with it
        if check_first:
            assert [e.status for e in service.check_sent(ctx, esc)] == [EmailStatus.DISCARDED]
        before = len(events(ctx, EventType.EMAIL_DISCARDED))
        revised = service.revise_email(ctx, esc, "shorter", IM)
        assert revised.status == EmailStatus.REDRAFTED and revised.error is None and revised.draft_id != old
        assert gmail.drafts[revised.draft_id]["body"].startswith("Short version.")
        assert len(events(ctx, EventType.EMAIL_DISCARDED)) == (before if check_first else before + 1), "one discard per deletion"


def test_failed_reaction_can_be_retried_after_connecting_gmail(ctx, clock):
    gmail = connect(ctx, clock)  # gateway present, the IM hasn't connected Gmail yet
    case = make_case(ctx)
    first = react(ctx, "📦", case)
    assert "Connect Gmail in the Agent Console" in first.outputs["reply_text"]
    gmail.connect(IM)
    retry = react(ctx, "📦", case)  # remove + re-add: same message, emoji and user
    assert not retry.data.get("duplicate") and "Draft ready in your Gmail" in retry.outputs["reply_text"]
    again = react(ctx, "📦", case)
    assert again.data["duplicate"] is True and len(gmail.drafts) == 1, "a successful reaction still never double-drafts"


def test_unmatched_reaction_is_retried_once_the_post_is_recorded(ctx):
    case = make_case(ctx)
    ref = "spaces/AAA/messages/CCC.CCC"
    early = react(ctx, "👍", None, text="", message_id=ref)  # record_post hasn't run yet
    assert "couldn't match this message" in early.outputs["reply_text"]
    handle({"op": "record_post", "payload": {"case_id": case.case_id, "message_id": ref}}, ctx)
    later = react(ctx, "👍", None, text="", message_id=ref)
    assert later.outputs["case_id"] == case.case_id and ctx.store.get_case(case.case_id).acknowledged_at is not None


# ---------------------------------------------------------------------------
# Burson space / agency audience
# ---------------------------------------------------------------------------


def converse(ctx, text, *, sender=BURSON_USER, message_id, **where):
    msg = make_message(text, sender_name=sender.split("@")[0], sender_email=sender, sender_type="HUMAN",
                       message_id=message_id, **where)
    return handle({"op": "converse", "payload": {"message": msg}, "context": {"flow": "converse"}}, ctx)


@pytest.mark.parametrize("space", ["spaces/AAQAaa_0I9g", "AAQAaa_0I9g", "https://chat.google.com/room/AAQAaa_0I9g"])
def test_burson_space_recognised_when_space_is_an_id(ctx, clock, space):
    connect(ctx, clock, IM)
    case = make_case(ctx)
    service.start_escalation(ctx, case, IM, trigger="reaction", requested_by=IM)
    flat = {"message_text": f"status {case.case_id}", "sender_email": BURSON_USER, "space": space, "message_id": f"f-{space}"}
    r = handle({"op": "converse", "payload": flat, "context": {"flow": "converse"}}, ctx)
    assert r.outputs["has_reply"] == "no" and r.outputs["burson_text"].startswith(f"🤖 {BURSON_USER} *{case.case_id}*")
    assert IM not in r.outputs["burson_text"] and "ESC-" not in r.outputs["burson_text"]
    blocked = handle({"op": "converse", "payload": {**flat, "message_text": f"forward {case.case_id}", "message_id": f"g-{space}"},
                      "context": {"flow": "converse"}}, ctx)
    assert "isn't available in this space" in blocked.outputs["burson_text"] and blocked.outputs["has_reply"] == "no"


def test_agency_member_dm_gets_the_external_treatment(ctx, clock):
    connect(ctx, clock, IM)
    case = make_case(ctx)
    service.start_escalation(ctx, case, IM, trigger="reaction", requested_by=IM)
    dm = {"space_id": None, "space_name": None, "conversation_type": "DM"}
    status = converse(ctx, f"status {case.case_id}", message_id="dm-1", **dm)
    assert status.outputs["has_reply"] == "yes" and IM not in status.outputs["reply_text"] and len(
        status.outputs["reply_text"].splitlines()) == 2
    closed = converse(ctx, f"❌ {case.case_id}", message_id="dm-2", **dm)
    assert "isn't available to you" in closed.outputs["reply_text"]
    assert ctx.store.get_case(case.case_id).status.value == "VERIFIED" and not events(ctx, EventType.CASE_CLOSED)


def test_external_answers_never_carry_emails_or_escalation_details(ctx, clock, fake_llm):
    connect(ctx, clock, IM)
    internal_addr = "doodle-team@corp.test"  # a made-up internal address: any address is removed from an answer
    ctx.store.save_fact(KnowledgeFact(fact_id="FACT-1", text=f"Doodle questions go to {internal_addr}.",
                                      source="chat", status=ProposalStatus.APPROVED, created_by=IM, created_at=clock.now))
    burson = dict(space_id=BURSON_SPACE["space_id"], space_name=BURSON_SPACE["space_name"])
    fallback = converse(ctx, "Where do Doodle questions go?", message_id="q-1", **burson)  # Gemini down: fact verbatim
    text = fallback.outputs["burson_text"]
    assert "Doodle" in text and internal_addr not in text and "[email removed]" in text
    assert text.startswith(f"🤖 {BURSON_USER} "), "the asker's own mention stays"

    case = make_case(ctx)
    esc = service.start_escalation(ctx, case, IM, trigger="reaction", requested_by=IM)
    fake_llm.on("converse.answer", {"answer": f"{case.case_id} is VERIFIED; ping {IM} for the draft.", "grounded": True,
                                    "sources": [f"live:{case.case_id}"]})
    r = converse(ctx, f"what's happening with {case.case_id}?", message_id="q-2", **burson)
    prompt = fake_llm.calls[-1]["prompt"]
    assert f"[Live {case.case_id}]" in prompt and esc.escalation_id not in prompt and IM not in prompt
    assert IM not in r.outputs["burson_text"] and "[email removed]" in r.outputs["burson_text"]


def test_user_facing_errors_in_the_burson_space_go_to_burson_text(ctx, monkeypatch):
    def paused(turn, intent):
        raise UserFacingError("Metrics are paused.")

    monkeypatch.setitem(handler_mod.HANDLERS, "metrics", paused)
    r = converse(ctx, "how many alerts were corrected today?", message_id="m-1", space_id=BURSON_SPACE["space_id"],
                 space_name=BURSON_SPACE["space_name"])
    assert r.outputs["has_reply"] == "no" and "Metrics are paused." in r.outputs["burson_text"]


# ---------------------------------------------------------------------------
# Intent regex false positives
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("text,not_intent", [
    ("never mind", "config_change"),
    ("Never got the draft for TRG-1042, can you check?", "config_change"),
    ("Stop, I already sent it", "config_change"),
    ("change the subject to Gemini dosage advice", "config_change"),
    ("update the draft to include the timestamp", "config_change"),
    ("how do I hand off to Priya?", "oncall_handoff"),
    ("who's on the Civics distro?", "oncall_who"),
    ("who is on the PA list for Search?", "oncall_who"),
    ("handover doc?", "handover"),
    ("handover link please", "handover"),
    ("bug TRG-1042 has 1234567 views", "bug"),
    ("pa TRG-1042 please", "action"),
    ("crisis TRG-1042?", "action"),
])
def test_regex_false_positives(ctx, text, not_intent):
    intent = match_regex(text, ctx.config)
    assert intent is None or intent.name != not_intent


@pytest.mark.parametrize("text,name,args", [
    ("always cc Civics on bias alerts", "config_change", {}),
    ("stop pinging Jon on P2 alerts", "config_change", {}),
    ("set the review reminder to 15 minutes", "config_change", {}),
    ("I'm handing off to Sam until 8pm ET", "oncall_handoff", {"who": "Sam", "until": "8pm ET"}),
    ("hand off to sam@agency.test", "oncall_handoff", {"who": "sam@agency.test"}),
    ("who's on?", "oncall_who", {}),
    ("who's on for Burson today?", "oncall_who", {}),
    ("post the handover for AMER late", "handover", {"rest": "for AMER late"}),
    ("bug ESC-1207: b/123456789", "bug", {"bug": "b/123456789"}),
    ("bug ESC-1207 bug id 123456789", "bug", {"bug": "123456789"}),
    ("Pa TRG-1042", "action", {"code": "pa", "emoji": "📦"}),
])
def test_regex_commands_still_match(ctx, text, name, args):
    intent = match_regex(text, ctx.config)
    assert intent is not None and intent.name == name and {k: intent.args.get(k) for k in args} == args


def test_false_positive_messages_have_no_side_effects(ctx, clock, fake_llm):
    connect(ctx, clock, IM)
    fake_llm.on("converse.teach", {"summary": "s", "patch_json": '{"thresholds": {"review_reminder_min": 15}}'})
    case = make_case(ctx)
    esc = service.start_escalation(ctx, case, IM, trigger="reaction", requested_by=IM)
    dm = {"space_id": None, "space_name": None, "conversation_type": "DM"}
    nevermind = converse(ctx, "never mind", sender=IM, message_id="n-1", **dm)
    assert nevermind.data["intent"] != "config_change" and ctx.store.list_proposals() == []
    views = converse(ctx, f"bug {esc.escalation_id} has 1234567 views now", sender=IM, message_id="n-2", **dm)
    assert views.data["intent"] != "bug" and not events(ctx, EventType.TNS_OUTCOME)


# ---------------------------------------------------------------------------
# Agent inbox
# ---------------------------------------------------------------------------


def test_first_wd_email_carrying_the_outcome_is_not_dropped(ctx, clock, fake_llm):
    gmail = connect(ctx, clock, IM)
    fake_llm.on("tns.assess", {"eligible": True, "category": "Harmful hallucination", "criteria_ids": ["gemini_hallucination"],
                               "rationale": "Dangerous output.", "evidence": "input_shown", "description": "Gemini dosage advice."})
    case = make_case(ctx, engagement_total=150)
    esc = service.start_escalation(ctx, case, IM, trigger="reaction", requested_by=IM)
    tns.assess_and_prepare(ctx, esc, case, IM)
    alert = service.draft_alert_email(ctx, esc, case)
    gmail.mark_sent(alert.draft_id)
    service.check_sent(ctx, esc)
    body = (f"Status: Fixed\nBug: b/123456789\n\n> Description: [SLRR {esc.escalation_id} / {case.case_id}] "
            "Gemini dosage advice.")  # the intake email itself never reached the agent inbox
    r = handle({"op": "ingest_email", "payload": {"subject": "Re: Issue [#12345678]: WD Intake Request", "body": body,
                                                   "message_id": "wd-out-1"}, "context": {"flow": "email"}}, ctx)
    stored = ctx.store.get_escalation(esc.escalation_id)
    assert stored.tns.wd_issue_id == "12345678" and stored.tns.outcome == "Fixed" and stored.tns.bug_id == "123456789"
    assert "intake confirmed" in r.outputs["clean_text"] and "T&S outcome: Fixed" in r.outputs["clean_text"]
    assert stored.email_for("bug_followup").status == EmailStatus.DRAFTED and r.outputs["dm_recipients"] == IM


# ---------------------------------------------------------------------------
# Google Forms pre-fill
# ---------------------------------------------------------------------------


def test_prefill_encoding_and_truncation_keep_values_decodable(ctx):
    cfg = ctx.config
    ref = "[SLRR ESC-1001 / TRG-1001]"
    desc, link = "entry.1000000005", "entry.1000000001"
    tricky = "100% sure + 50% & more # tag ✓ 🤖\nline two / ?x=1 "
    fields = {link: "https://x.com/a/status/1?s=20&t=abc", desc: f"{ref} " + tricky * 40}
    pre = tns.build_prefill_url(cfg, fields, max_length=900, protect={desc: len(ref) + 1})
    assert pre.url.startswith(cfg.tns.form_url + "?usp=pp_url&entry.") and len(pre.url) <= 900
    query = pre.url.split("?", 1)[1]
    assert not set(query) & set(" \n#+?") and query.count("&") == 2
    q = parse_qs(urlparse(pre.url).query, strict_parsing=True, errors="strict")  # no broken %-escapes
    assert q[link] == [fields[link]] and q[desc] == [pre.fields[desc]]
    assert q[desc][0].startswith(f"{ref} 100% sure + 50% & more # tag ✓ 🤖\nline two") and q[desc][0].endswith("…")

    cfg.tns.fields.append(TnsField(entry_id="entry.1000000009", label="Region", type="multiple_choice",
                                   source="const:north america", options=["North America", "EMEA"]))
    case = make_case(ctx)
    esc = service.start_escalation(ctx, case, IM, trigger="reaction", requested_by=IM)
    values = tns.form_values(ctx, esc, case, tns.TnsAssessment(eligible=True, description="d"), "Other")
    assert values["entry.1000000009"] == "North America" and values["entry.290320498"] == "Marketing"


def test_revert_accepts_multi_word_field_names(ctx):
    from triage_agent.converse.intents import match_regex
    for text, field in (("revert TRG-1001 exposure tag", "exposure_tag"), ("revert TRG-1001 Exposure-Tag", "exposure_tag"),
                        ("please revert TRG-1001 the social network fix", "social_network"), ("revert TRG-1001 product", "product"),
                        ("revert TRG-1001 view post", "post_url")):
        intent = match_regex(text, ctx.config)
        assert intent and intent.name == "revert" and intent.args["field"] == field, (text, intent)


def test_agency_roster_commands_default_to_the_burson_roster():
    from triage_agent.converse.handler import roster_for
    assert roster_for("I'm on until 6pm", None, agency=True) == "burson"
    assert roster_for("I'm on until 6pm", None) == "slrr_im"
    assert roster_for("who's the IM on shift?", None, agency=True) == "slrr_im"  # words still win


def test_recipient_display_names_with_commas_stay_one_address():
    from email.utils import getaddresses

    from triage_agent.escalation.gmail import build_mime
    msg = build_mime(from_header="Brand Social <sender@alerts.test>",
                     to=["Doe, Jane <jane@alerts.test>", "gemini-pa@alerts.test", "José Ñúñez <jose@alerts.test>"],
                     cc=['"Civics, Team" <civics@alerts.test>'], subject="s", body="b")
    to = [addr for _name, addr in getaddresses([str(msg["To"])])]
    assert to == ["jane@alerts.test", "gemini-pa@alerts.test", "jose@alerts.test"]
    assert [addr for _n, addr in getaddresses([str(msg["Cc"])])] == ["civics@alerts.test"]

