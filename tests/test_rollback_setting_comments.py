"""The comments of two rollback settings say everything the setting switches, and what "off" gives back.

cross_alert_notes also lets a bigger post on an issue already alerted through as its own card (which can send a
Social Alert) and routes the watch's "Same story" reply; requirement_line also makes the BSIP card's [KOF] line say
what the feed says (which can start a Social Alert). Someone rolling back extra emails reads these comments to pick
the setting, so both the YAML and the Python model must say so.
"""

from __future__ import annotations

import ast
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _yaml_comment(key: str) -> str:
    """The comment lines right above `key:` in the burson_qa block, plus any comment on the key's own line."""
    lines = (ROOT / "config" / "default_config.yaml").read_text(encoding="utf-8").splitlines()
    at = next(i for i, line in enumerate(lines) if line.strip().startswith(f"{key}:"))
    out = [lines[at].split("#", 1)[1] if "#" in lines[at] else ""]
    i = at - 1
    while i >= 0 and lines[i].strip().startswith("#"):
        out.insert(0, lines[i].strip()[1:])
        i -= 1
    return " ".join(part.strip() for part in out if part.strip())


def _python_comment(key: str) -> str:
    """The comment lines right above the field `key` in triage_agent/config.py."""
    text = (ROOT / "triage_agent" / "config.py").read_text(encoding="utf-8")
    ast.parse(text)  # still valid Python
    lines = text.splitlines()
    at = next(i for i, line in enumerate(lines) if line.strip().startswith(f"{key}:"))
    out = []
    i = at - 1
    while i >= 0 and lines[i].strip().startswith("#"):
        out.insert(0, lines[i].strip()[1:].strip())
        i -= 1
    return " ".join(out)


def _flat(text: str) -> str:
    return " ".join(text.split())


def test_cross_alert_notes_comment_names_the_bigger_post_card_and_the_same_story_reply():
    for comment in (_flat(_yaml_comment("cross_alert_notes")), _flat(_python_comment("cross_alert_notes"))):
        assert "note under another alert's card" in comment, comment
        assert "bigger post (2,000+ engagements)" in comment and "its own card" in comment, comment
        assert '"Same story" reply' in comment, comment
        # what off gives back: the old behaviour, not silence
        assert "as before" in comment and "goes in the thread as it used to" in comment, comment
        assert "no extra card for a bigger post" in comment, comment


def test_requirement_line_comment_names_the_kof_line_and_its_social_alert():
    for comment in (_flat(_yaml_comment("requirement_line")), _flat(_python_comment("requirement_line"))):
        assert '"Alert requirements" line' in comment, comment
        assert "[KOF] line" in comment and "can start a Social Alert" in comment, comment
        assert "the BSIP card's [KOF] line says No" in comment, comment
