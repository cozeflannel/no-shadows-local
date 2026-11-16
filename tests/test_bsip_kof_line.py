"""The BSIP card's [KOF] line (apps-script-chat-bot/BigQuery.gs formatBsipSonarAlertText_ with opts.kof, bsipKofValue_).

In the Auto-correct flow the Direct BigQuery card of a BSIP post says what the feed's KOF column says:
"[KOF]: Yes (<the list's name, without its own brackets>)", or "No". The Python parser (triage_agent/qa/parser.py) is
the twin of the bot's (Alert.gs): it must read the card with the new line as the bot does, with the same fields as the
card of before except KOF, and the rules must then treat it as a KOF's alert.
"""

from __future__ import annotations

import json
import subprocess
from datetime import datetime, timezone

from tests.conftest import TEST_BSG_ROWS
from tests.test_apps_script_bot import BOT, NODE, PARITY_FIELDS, needs_node
from triage_agent.brand_safety_groups import apply_brand_safety_groups
from triage_agent.config import load_config
from triage_agent.qa import parser
from triage_agent.qa.pipeline import run_qa
from triage_agent.qa.record_key import normalize_url

# A BSIP post under the Social Alert bar by itself: a P2 exposure tag and 620 engagements
ROW = {
    "source_kind": "BSIP",
    "id": "2160000000000000001",
    "url": "https://x.com/gadgetdesk/status/2160000000000000001",
    "handle": "gadgetdesk",
    "network": "Twitter",
    "alert_names_json": '["Pixel - Reliability"]',
    "tags": "Pixel camera | Product - Other/general criticism",
    "criticality": "HIGH",
    "followers": 88000,
    "total": 620,
    "summary": "An X user says the Google Pixel 10 camera app crashes every time they record video.",
    "issue_name": "Pixel 10 camera app crashes on video",
    "post_time": "2026-10-12 10:40:00+00",
}

# What the feed's KOF column can say -> the card's line, and what both parsers must read from it
KOF_VALUES: dict[str, tuple[str, bool, list[str]]] = {
    "Viral KOFs (KOFs)": ("[KOF]: Yes (Viral KOFs KOFs)", True, ["Viral KOFs KOFs"]),
    "Tech Reviewers": ("[KOF]: Yes (Tech Reviewers)", True, ["Tech Reviewers"]),
    "Exec following #4 (INFs), CAM Tech/AI (INFs)": (
        "[KOF]: Yes (Exec following #4 INFs, CAM Tech/AI INFs)",
        True,
        ["Exec following #4 INFs", "CAM Tech/AI INFs"],
    ),
    "Google Owned Channels": ("[KOF]: No", False, []),
    "": ("[KOF]: No", False, []),
}


def _cards(values: list[str]) -> list[dict[str, str]]:
    """Each value's card from the bot's own builder: with the flag the Auto-correct flow passes, and without it."""
    script = (
        f"const {{ loadBot }} = require({json.dumps(str(BOT / 'test' / 'fakes.js'))});"
        "const B = loadBot();"
        "const { row, values } = JSON.parse(require('fs').readFileSync(0, 'utf8'));"
        "process.stdout.write(JSON.stringify(values.map(kof => ({"
        "flagged: B.formatBsipSonarAlertText_(Object.assign({}, row, { kof }), { kof: true }),"
        "plain: B.formatBsipSonarAlertText_(Object.assign({}, row, { kof })) }))));"
    )
    result = subprocess.run(
        [NODE, "-e", script],
        input=json.dumps({"row": ROW, "values": values}),
        capture_output=True,
        text=True,
        timeout=60,
        check=True,
    )
    return json.loads(result.stdout)


def _bot_reads(texts: list[str]) -> list[dict]:
    """The bot's own parse of each text, with its Social Alert rule's call (apps-script-chat-bot/test/parse_cli.js)."""
    payload = {"texts": texts, "bsg_rows": [list(r) for r in TEST_BSG_ROWS]}
    result = subprocess.run(
        [NODE, str(BOT / "test" / "parse_cli.js")],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        timeout=60,
        check=True,
    )
    return json.loads(result.stdout)


@needs_node
def test_the_bsip_card_with_the_kof_line_is_read_the_same_by_both_parsers(ctx):
    values = list(KOF_VALUES)
    cards = _cards(values)
    texts = [c[k] for c in cards for k in ("flagged", "plain")]
    bot = dict(zip(texts, _bot_reads(texts)))
    config = load_config()
    apply_brand_safety_groups(config, TEST_BSG_ROWS)
    now = datetime(2026, 10, 12, 12, 0, tzinfo=timezone.utc)

    def rest(fields: dict) -> dict:
        return {k: v for k, v in fields.items() if k not in ("kof", "kof_lists")}

    plain_cards = {c["plain"] for c in cards}
    assert len(plain_cards) == 1, "without the flag the card is the same card whatever the feed's KOF column says"
    for value, card in zip(values, cards):
        line, is_kof, lists = KOF_VALUES[value]
        assert "\n[KOF]: No\n" in card["plain"], value
        assert f"\n{line}\n" in card["flagged"], value
        # only that one line differs
        differing = [(a, b) for a, b in zip(card["flagged"].split("\n"), card["plain"].split("\n")) if a != b]
        assert differing == ([(line, "[KOF]: No")] if is_kof else []), value

        py_flagged = parser.parse(config, card["flagged"])
        py_plain = parser.parse(config, card["plain"])
        # the card of before: not a KOF's
        assert py_plain.fields.get("kof") is False, value
        assert not py_plain.fields.get("kof_lists"), value
        # the card with the line: KOF as the feed says, on the list it named; every other field as before
        assert py_flagged.fields.get("kof") is is_kof, value
        assert (py_flagged.fields.get("kof_lists") or []) == lists, value
        assert rest(py_flagged.fields) == rest(py_plain.fields), value

        # the bot's own parser reads each card as the Python one does
        for text, py in ((card["flagged"], py_flagged), (card["plain"], py_plain)):
            js = bot[text]
            assert js["detected"], value
            for field in PARITY_FIELDS:
                assert js["fields"].get(field) == py.fields.get(field), (
                    f"{value!r}.{field}: js={js['fields'].get(field)!r} py={py.fields.get(field)!r}"
                )
            assert js["record_key"] == normalize_url(py.fields.get("post_url")), value

        # the Social Alert rule, on both sides: a KOF's post is alerted at any size; the card of before is not
        py_call = run_qa(ctx, py_flagged, source="burson_chat", received_at=now).assessment
        assert bot[card["flagged"]]["escalated"] is is_kof, value
        assert py_call.alertable is is_kof, value
        if is_kof:
            assert bot[card["flagged"]]["track"] == str(py_call.track) == "URGENT", value
        else:
            assert bot[card["flagged"]]["track"] is None and py_call.track is None, value
        assert bot[card["plain"]]["escalated"] is False, value
        assert run_qa(ctx, py_plain, source="burson_chat", received_at=now).assessment.alertable is False, value
