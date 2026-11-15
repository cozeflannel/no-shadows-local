"""Parser robustness: the real Burson layout is still a placeholder, so tolerate common Chat/Zapier variants."""

from datetime import datetime, timezone

from conftest import GOOD_ALERT
from triage_agent.config import load_config
from triage_agent.models import ChatMessage, ChatUser
from triage_agent.qa.parser import detect, parse, parse_bool, parse_datetime, parse_int, parse_list

CFG = load_config()


def test_good_alert_parses_typed_values():
    p = parse(CFG, GOOD_ALERT)
    f = p.fields
    assert not p.missing_labels
    assert f["total_engagement"] == 2450 and f["followers"] == 152300 and f["kof"] is False
    assert f["post_date"] == datetime(2026, 10, 12, 13, 5, tzinfo=timezone.utc)
    assert f["social_network"] == "X" and f["issue_status"] == "NEW"


def test_bold_bullets_and_chat_link_markup():
    text = """*🚨 New Alert*
• *Alert Name:* [URGENT] [NEW] Gemini App – Bad output
• *Exposure Tag:* Product - Offensive or explicit results
• *Product:* Gemini App
• *Social Network:* X
• *Author:* @someone
• *Engagement:* 1.2K
• <https://x.com/someone/status/1234567890123|View Post>"""
    f = parse(CFG, text).fields
    assert f["total_engagement"] == 1200, "numeric 'Engagement' goes to the total, not the level enum"
    assert "engagement_level" not in f
    assert f["post_url"] == "https://x.com/someone/status/1234567890123"
    assert f["exposure_tag"] == "Product - Offensive or explicit results"


def test_emoji_prefixed_labels():
    text = """🔔 Alert Name: [URGENT] [NEW] Pixel – Phone overheating
🏷️ Exposure Tag: Product - Product failures - physical safety issues
📱 Product: Pixel
🌐 Social Network: TikTok
👤 Author: @user
🔗 View Post: https://www.tiktok.com/@user/video/7412345678901234567"""
    p = parse(CFG, text)
    assert not p.missing_labels and p.fields["product"] == "Pixel" and p.fields["social_network"] == "TikTok"


def test_multiline_values_and_flags():
    text = """This alert meets P0 criteria
Alert Name: [HIGH ENGAGEMENT] [NEW] AI Overviews – glue on pizza
Exposure Tag: Product - Dangerous results (e.g. medical/legal)
Product: AI Overviews
Social Network: Reddit
Author: u/someone
Summary:
Users share screenshots of AI Overviews telling people
to add glue to pizza.
View Post: https://www.reddit.com/r/google/comments/abc123/title/"""
    p = parse(CFG, text)
    assert p.flags["meets_p0"] is True
    assert p.fields["summary"].endswith("to add glue to pizza.")


def test_value_helpers():
    assert parse_int("2.4K") == 2400 and parse_int("1,250,000") == 1250000 and parse_int("3M") == 3_000_000
    assert parse_int("lots") is None
    assert parse_bool("✅") is True and parse_bool("No") is False and parse_bool("maybe") is None
    dt = parse_datetime("Oct 12, 2026 1:05 PM ET")
    assert dt.utcoffset().total_seconds() == -4 * 3600 and dt.hour == 13
    assert parse_list("Politics; Privacy | Hate Speech") == ["Politics", "Privacy", "Hate Speech"]
    assert parse_list("None") == []


def test_detection_needs_labels_and_a_signal():
    alert_msg = ChatMessage(text=GOOD_ALERT, sender=ChatUser(name="Zapier"))
    assert detect(CFG, alert_msg, parse(CFG, GOOD_ALERT))[0]
    chatter = "Alert Name: test\nhello"
    human = ChatMessage(text=chatter, sender=ChatUser(name="Pat"))
    assert not detect(CFG, human, parse(CFG, chatter))[0]


def test_bots_own_cards_are_never_burson_alerts():
    """Watch alert and Early Detection cards carry Product / Exposure Tag / Sensitive Topic lines, yet stay the bot's own."""
    taxonomy = (
        "*Product:* Waymo\n*Exposure Tag:* Product - Product failures - physical safety issues (P1)\n"
        "*Sensitive Topic:* None\n*KOF:* No\n*Author:* FOX 29\n*Summary:* A federal investigation into a Waymo recall.\n"
    )
    heads = (
        # the bot's own card today: its first line names the kind of alert (Alert.gs OWN_CARD_TYPES_)
        "\U0001f6a8 *EARLY DETECTION* \u00b7 New story",
        "\u26a1 *EARLY SIGNAL* \u00b7 3 accounts so far (a story is usually flagged at 5)",
        "\u26a1\ufe0f *EARLY SIGNAL* \u00b7 3 accounts so far (a story is usually flagged at 5)",
        "\U0001f4c8 *UPDATE* \u00b7 More on a story already alerted",
        "\U0001f52d *WATCH* \u00b7 Google brand safety (all)",
        # ... with the mark Chat can put after an emoji, each of them; and the kind alone, with no detail
        "\U0001f6a8\ufe0f *EARLY DETECTION* \u00b7 New story",
        "\U0001f4c8\ufe0f *UPDATE* \u00b7 More on a story already alerted",
        "\U0001f52d\ufe0f *WATCH* \u00b7 Google brand safety (all)",
        "\U0001f52d *WATCH*",
        "\U0001f4c8 *UPDATE*",
        # the headers its cards had before: still the bot's own
        "\U0001f52d *Watch alert \u00b7 Google brand safety (all)*",
        "\U0001f6a8 *Early Detection Alert* \U0001f6a8",
        "\U0001f6a8 *Early Detection Alert: Pixel dialer freeze* \U0001f6a8",
        "\U0001f4c8 *Early Detection Update*",
    )
    for head in heads:
        text = f"{head}\n*Link:* https://x.com/someone/status/1234567890123\n{taxonomy}"
        verdict = detect(CFG, ChatMessage(text=text, sender=ChatUser(name="Zapier")), parse(CFG, text))
        assert verdict == (False, "bot own card"), head
    # the emoji and the capitals are both needed, and only " · detail" may follow the kind: a person's line
    # that only starts with the same word is not a card
    for not_a_card in (
        "Update \u00b7 More on a story",
        "WATCH \u00b7 this space",
        "\U0001f52d Watch \u00b7 this",
        "\U0001f52d WATCHING this",
        "\U0001f52d WATCH this space",
        "\U0001f4c8 UPDATE: numbers",
        "\U0001f4c8 UPDATED figures",
        "\U0001f6a8 EARLY DETECTIONS \u00b7 New story",
    ):
        text = f"{not_a_card}\n*Link:* https://x.com/someone/status/1234567890123\n{taxonomy}"
        verdict = detect(CFG, ChatMessage(text=text, sender=ChatUser(name="Zapier")), parse(CFG, text))
        assert verdict != (False, "bot own card"), not_a_card
