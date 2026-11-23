"""Own alerts: personal details are taken out of a post before it is kept. Patterns first, then Google's Sensitive
Data Protection (Cloud DLP); when DLP cannot be reached nothing is handed back, so nothing is stored.

DLP's HTTP call is replaced by a stand-in that records what it was sent (no network). The patterns, the batching, the
request and the order are the real code.
"""

from __future__ import annotations

from typing import Any

import pytest

from triage_agent.ownalerts import scrub


class Session:
    """Answers DLP's content:deidentify the way the service does: every row back, names replaced by their kind."""

    def __init__(self, status: int = 200, drop: int = 0):
        self.status, self.drop = status, drop
        self.calls: list[dict[str, Any]] = []

    def post(self, url: str, json: dict[str, Any], timeout: float):
        self.calls.append({"url": url, "body": json, "timeout": timeout})
        rows = json["item"]["table"]["rows"]
        out = [{"values": [{"stringValue": r["values"][0]["stringValue"].replace("Dana Whitfield", "[PERSON_NAME]")}]} for r in rows]
        return Reply(self.status, {"item": {"table": {"headers": json["item"]["table"]["headers"], "rows": out[: len(out) - self.drop]}}})


class Reply:
    def __init__(self, status: int, data: dict[str, Any]):
        self.status_code, self._data, self.text = status, data, '{"error": {"message": "Permission denied on resource project"}}'

    def json(self) -> dict[str, Any]:
        return self._data


def dlp(session: Session) -> scrub.CloudDlp:
    return scrub.CloudDlp("proj", "us-central1", session=session)


def test_the_patterns_cut_emails_links_handles_and_phone_numbers():
    text = ("Email dana@example.test or call +1 (555) 010-2030. See https://x.example/p/1 and www.example.test/a. "
            "@dana_w said it (@other.acct too), and so did.@third")
    out = scrub.patterns(text, 500)
    assert out == "Email [EMAIL] or call [PHONE]. See [URL] and [URL] [HANDLE] said it ([HANDLE] too), and so did.[HANDLE]"


def test_the_patterns_leave_ordinary_words_and_cut_to_the_length_kept():
    assert scrub.patterns("  Chrome keeps logging me out after today's update  ", 500) == "Chrome keeps logging me out after today's update"
    assert scrub.patterns("abcdefghij" * 80, 500) == ("abcdefghij" * 80)[:500]
    assert scrub.patterns(None, 500) == "" and scrub.patterns("   ", 500) == ""


def test_dlp_gets_only_text_the_patterns_already_cut_and_answers_in_order(ctx, monkeypatch):
    session = Session()
    monkeypatch.setattr(scrub, "get_dlp", lambda c: dlp(session))
    out = scrub.clean_all(ctx, ["Dana Whitfield (@dana_w) says Pixel is down", "", "mail dana@example.test"])
    assert out == ["[PERSON_NAME] ([HANDLE]) says Pixel is down", "", "mail [EMAIL]"]
    sent = [r["values"][0]["stringValue"] for c in session.calls for r in c["body"]["item"]["table"]["rows"]]
    assert sent == ["Dana Whitfield ([HANDLE]) says Pixel is down", "mail [EMAIL]"], "blank posts are not sent, and no handle or address reaches DLP"


def test_the_request_names_the_kinds_of_detail_from_settings(ctx, monkeypatch):
    session = Session()
    monkeypatch.setattr(scrub, "get_dlp", lambda c: dlp(session))
    ctx.config.platform.own_alerts.dlp_info_types = ["PERSON_NAME", "EMAIL_ADDRESS"]
    scrub.clean_all(ctx, ["Dana Whitfield posted"])
    call = session.calls[0]
    assert call["url"] == "https://dlp.googleapis.com/v2/projects/proj/locations/us-central1/content:deidentify"
    body = call["body"]
    kinds = [{"name": "PERSON_NAME"}, {"name": "EMAIL_ADDRESS"}]
    assert body["inspectConfig"] == {"infoTypes": kinds}
    assert body["deidentifyConfig"] == {"infoTypeTransformations": {"transformations": [
        {"infoTypes": kinds, "primitiveTransformation": {"replaceWithInfoTypeConfig": {}}}]}}
    assert body["item"]["table"]["headers"] == [{"name": "text"}]


def test_many_posts_go_in_batches_and_come_back_in_order(ctx, monkeypatch):
    session = Session()
    monkeypatch.setattr(scrub, "get_dlp", lambda c: dlp(session))
    texts = [f"post {n} by Dana Whitfield" for n in range(scrub.ROWS * 2 + 5)]
    out = scrub.clean_all(ctx, texts)
    assert [len(c["body"]["item"]["table"]["rows"]) for c in session.calls] == [scrub.ROWS, scrub.ROWS, 5]
    assert out == [f"post {n} by [PERSON_NAME]" for n in range(len(texts))]


def test_what_dlp_hands_back_is_cut_to_the_length_kept(ctx, monkeypatch):
    session = Session()
    monkeypatch.setattr(scrub, "get_dlp", lambda c: dlp(session))
    ctx.config.platform.own_alerts.snippet_chars = 50
    out = scrub.clean_all(ctx, ["Dana Whitfield " * 10])
    assert len(out[0]) <= 50 and out[0].startswith("[PERSON_NAME]")


@pytest.mark.parametrize("session", [Session(status=403), Session(drop=1)])
def test_nothing_is_handed_back_when_dlp_fails_or_loses_a_row(ctx, monkeypatch, session):
    monkeypatch.setattr(scrub, "get_dlp", lambda c: dlp(session))
    with pytest.raises(scrub.Unavailable):
        scrub.clean_all(ctx, ["Dana Whitfield posted", "and again"])


def test_nothing_is_handed_back_when_dlp_cannot_be_reached(ctx, monkeypatch):
    class Down:
        def post(self, *a: Any, **k: Any):
            raise ConnectionError("no route")

    monkeypatch.setattr(scrub, "get_dlp", lambda c: scrub.CloudDlp("proj", "us-central1", session=Down()))
    with pytest.raises(scrub.Unavailable, match="could not be reached"):
        scrub.clean_all(ctx, ["Dana Whitfield posted"])


def test_no_kind_of_detail_set_stops_the_read(ctx, monkeypatch):
    ctx.config.platform.own_alerts.dlp_info_types = []
    with pytest.raises(scrub.Unavailable, match="kinds of personal detail"):
        scrub.clean_all(ctx, ["Dana Whitfield posted"])
