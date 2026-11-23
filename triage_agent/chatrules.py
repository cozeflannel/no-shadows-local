"""Which Chat messages the QA chatbot answers without being mentioned, and which threads it hands to the campaigns
assistant: the sheet-based bot's rules, word for word (apps-script-chat-bot/Voice.gs isQuestion_, isShortAck_,
mentionsAlertField_, mentionsAnalystAction_; CampaignHandoff.gs CAMPAIGN_DIRECT_RX_, CAMPAIGN_CANDIDATE_RX_,
campaignDocId_). Pure: no Chat, no store.

Where a message stands decides which rule applies (Bot.gs handleHuman_ and pollAnalystMessages_):

    the source space (Burson's)     a question, or in an alert's thread a follow-up about the alert
    any other space (Google only)   a question that is not a short "ok", or in a thread a follow-up about the alert
                                    or about what to do next

A message that mentions someone, and not the bot, is theirs and never the bot's (chatanswers checks that first).
"""

from __future__ import annotations

import hashlib
import re
from typing import Any

# Chat puts the mentions a person typed at the front of the text: they are not part of what was asked.
_LEADING_MENTIONS = re.compile(r"^(?:(?:@\S+|<users/[^>]+>)\s*)+")
_ASKS = re.compile(r"^(?:why|how|what|which|when|where|who|should|shouldn't|can|could|is|are|isn't|aren't|does|do|did|didn't|"
                   r"would|will|may|explain|clarify|confirm)\b")
# Pushback or a follow-up about the alert or its escalation: worth an answer even without a question mark.
ALERT_TOPIC = re.compile(r"\b(?:product|tag|exposure|topics?|sensitive|engagement|kof|network|platform|priority|p[012]|summary|issue|"
                         r"status|link|url|author|wrong|right|correct|incorrect|disagree|mistake|escalat|handled|email|review|"
                         r"t&s|trust)\b", re.I)
# A follow-up in an analysts' alert thread ("what do I do", "next steps", "who is on the email").
NEXT_STEP = re.compile(r"\b(?:do|next|steps?|action|draft|email|send|sent|recipients?|to|cc|groups?|t&s|trust|safety|form|escalat|"
                       r"im|incident|who|why|status|help|handle|handled)\b", re.I)
ACK_WORDS = frozenset((
    "ok okay k kk thanks thank you thx ty will do doing fix fixed fixing done on it noted got sure yes yep yeah resent resend "
    "resending updated update updating understood roger perfect great sounds good copy that the this alert now asap shortly soon "
    "sorry my bad i we ill well just np cheers appreciate appreciated hi hello team all set take taking grab mine looking look "
    "checking check one moment sec").split())


def _plain(text: str | None) -> str:
    """The text with Chat's curly apostrophes made straight, as a person typed them."""
    return str(text or "").replace("\u2019", "'").replace("\u2018", "'")


def is_question(text: str | None) -> bool:
    """A question: it has a question mark, or it starts with a question word (why, how, what, can, is, ...)."""
    t = _LEADING_MENTIONS.sub("", _plain(text).strip().lower())
    if not t:
        return False
    return "?" in t or bool(_ASKS.match(t))


def is_short_ack(text: str | None) -> bool:
    """"ok", "thanks!", "will fix", "done, resent 👍": a reply that needs nothing back. An emoji alone counts too."""
    t = _LEADING_MENTIONS.sub("", _plain(text))
    t = re.sub(r"[^\w\s]|_", " ", t.replace("'", "")).strip().lower()
    if not t:
        return True
    words = t.split()
    return len(words) <= 10 and all(w in ACK_WORDS for w in words)


def mentions_alert_field(text: str | None) -> bool:
    return bool(ALERT_TOPIC.search(str(text or "")))


def mentions_next_step(text: str | None) -> bool:
    return bool(NEXT_STEP.search(str(text or "")))


def wants_answer(text: str | None, *, source: bool, reply: bool, alert_thread: Any = False) -> bool:
    """Whether a message that does not mention the bot gets an answer (the sheet-based bot's rules, above).

    `source`: it stands in the source space (Burson's); `reply`: it is a reply in a thread; `alert_thread`: that thread
    is an alert's (a value, or a function asked only when the rule needs to know)."""
    ack = is_short_ack(text)
    if source:
        return is_question(text) or (reply and not ack and mentions_alert_field(text)
                                     and bool(alert_thread() if callable(alert_thread) else alert_thread))
    return (not ack and is_question(text)) or (reply and not ack and (mentions_next_step(text) or mentions_alert_field(text)))


_TEMP_CHECK = re.compile(r"^(?:please\s+)?(?:run\s+(?:a\s+)?)?temp(?:erature)?[\s-]*check\b", re.I)


def is_temp_check(text: str | None) -> bool:
    """"temp check ..." at the start: a request for a temp check (converse runs it, when temp checks are ON)."""
    return bool(_TEMP_CHECK.match(_LEADING_MENTIONS.sub("", str(text or "").strip())))


# ---------------------------------------------------------------------------------------------------------------
# The campaigns assistant (slrr_campaigns): a thread someone asks it to take over is handed to it, and left to it
# ---------------------------------------------------------------------------------------------------------------

CAMPAIGN_DIRECT = re.compile(
    r"\b(?:deep[- ]?dive|alert\s+campaign|focused\s+deep\s+dive|"
    r"brandwatch\s+(?:deep|report|query|alert|campaign|volume|mentions|breakdown)|custom\s+alert|"
    r"(?:start|create|run|launch|spin\s+up|set\s+up|open|build|make)\s+(?:a\s+|an\s+|new\s+|dedicated\s+|topic\s+|focused\s+)*"
    r"(?:campaign|custom\s+alert|alert\s+space|monitoring\s+space)|"
    r"campaign\s+(?:for|on|about|around|tracking|space)|dig\s+deeper\s+(?:in\s+brandwatch|into\s+(?:this|the))|"
    r"pull\s+(?:a\s+|the\s+)?(?:brandwatch|mention|volume)\s+(?:report|breakdown))\b", re.I)
# Words that may be a request for the campaigns assistant: Gemini is asked whether they are (chatanswers).
CAMPAIGN_MAYBE = re.compile(r"\b(?:brandwatch|dedicated\s+space|own\s+space|monitor\s+this|keep\s+tracking|ongoing\s+alerts?|"
                            r"volume\s+(?:over|in\s+the\s+last|in\s+the\s+past))\b", re.I)
_INTERNAL_MARK = re.compile(r"^\s*(?:\[internal\]|internal\s*[:\-–—])", re.I)
OWNERSHIP = "thread_ownership"  # the campaigns service's record of the threads it owns (in its own database)
HANDOFF_REPLY = "Campaign assistant now owns this thread and will reply shortly."


def campaign_text(text: str | None) -> str:
    """The request as the campaigns assistant reads it: without an "[internal]" mark in front."""
    return _INTERNAL_MARK.sub("", str(text or "").strip()).strip()


def campaign_ask(text: str | None) -> str:
    """'yes' for a plain request for a deep dive or an alert campaign, 'maybe' for one Gemini should judge, '' for none."""
    t = campaign_text(text)
    if not t:
        return ""
    if CAMPAIGN_DIRECT.search(t):
        return "yes"
    return "maybe" if CAMPAIGN_MAYBE.search(t) else ""


def ownership_id(thread: str) -> str:
    """The campaigns service's document id for a thread (slrr_campaigns/store.py _doc_key)."""
    cleaned = thread.strip().replace("/", "__")
    if cleaned and len(cleaned) <= 120:
        return cleaned
    return hashlib.sha256(thread.encode("utf-8")).hexdigest()
