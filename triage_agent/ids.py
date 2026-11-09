"""Human-friendly ids in chat text (TRG-1042, ESC-1207) and helpers to find them."""

import re

from .config import AgentConfig


def _ids(text: str | None, prefix: str) -> list[str]:
    if not text:
        return []
    found = re.findall(rf"\b{re.escape(prefix)}-\d{{3,}}\b", text, flags=re.IGNORECASE)
    return list(dict.fromkeys(f.upper() for f in found))


def case_ids_in(text: str | None, config: AgentConfig) -> list[str]:
    """Case ids mentioned in a message, in order of appearance (deduplicated)."""
    return _ids(text, config.case_id_prefix)


def escalation_ids_in(text: str | None, config: AgentConfig) -> list[str]:
    return _ids(text, config.escalation_id_prefix)


def message_key(ref: str | None) -> str | None:
    """Stable key for a Chat message reference: the last path segment of a resource name
    (spaces/S/messages/M -> M) or message link (.../room/S/T/M?cls=10 -> M)."""
    if not ref:
        return None
    ref = ref.strip()
    if "#" in ref:  # e.g. https://mail.google.com/chat/u/0/#chat/space/S/M
        ref = ref.split("#", 1)[1]
    key = ref.split("?", 1)[0].rstrip("/").rsplit("/", 1)[-1]
    return key or None
