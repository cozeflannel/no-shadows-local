"""The words of X posts, from X's public embed data (a port of tempcheck-app/lib/xposts.js).

Brandwatch's API gives X posts without their text, author or link. The same public endpoint X's own "embed this post"
code uses fills them in: no login, no key, read-only. A post X won't serve (deleted, protected, age-restricted) is
simply left out.
"""

from __future__ import annotations

import math
import re
from concurrent.futures import ThreadPoolExecutor
from typing import Any

EMBED = "https://cdn.syndication.twimg.com/tweet-result"
UA = "Mozilla/5.0 (compatible; SLRR-tempcheck/1.0)"
TIMEOUT_S = 8
AT_ONCE = 8
TEXT_CHARS = 1200
_DIGITS = "0123456789abcdefghijklmnopqrstuvwxyz"
_POST_ID = re.compile(r"^\d{5,25}$")


def _base36(value: float) -> str:
    """A positive number as JavaScript's Number.toString(36) writes it: digits until the number is told apart from
    its neighbours, the last one rounded (V8's rule)."""
    integer = math.floor(value)
    fraction = value - integer
    delta = max(math.nextafter(0.0, math.inf), 0.5 * (math.nextafter(value, math.inf) - value))
    after: list[int] = []
    if fraction >= delta:
        while True:
            fraction *= 36
            delta *= 36
            digit = int(fraction)
            after.append(digit)
            fraction -= digit
            if (fraction > 0.5 or (fraction == 0.5 and digit & 1)) and fraction + delta > 1:
                while True:  # round up, carrying back through the digits already written
                    if not after:
                        integer += 1
                        break
                    last = after.pop()
                    if last + 1 < 36:
                        after.append(last + 1)
                        break
                break
            if fraction < delta:
                break
    before = ""
    n = int(integer)
    while True:
        before = _DIGITS[n % 36] + before
        n //= 36
        if n == 0:
            break
    return before + ("." + "".join(_DIGITS[d] for d in after) if after else "")


def embed_token(post_id: Any) -> str:
    """The token X's embed endpoint expects for a post id (as X's own embed code computes it)."""
    return re.sub(r"(0+|\.)", "", _base36(float(str(post_id)) / 1e15 * math.pi))


def _unescape(text: Any) -> str:
    return str(text or "").replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").strip()


def from_embed(d: Any) -> dict[str, Any] | None:
    """X's embed data as {author, text, url, likes, replies, from}, or None when it isn't a post."""
    if not isinstance(d, dict) or not d.get("id_str"):
        return None
    who = str((d.get("user") or {}).get("screen_name") or "")

    def count(value: Any) -> int:
        try:
            return int(value or 0)
        except (TypeError, ValueError):
            return 0
    return {"author": who, "text": _unescape(d.get("text"))[:TEXT_CHARS], "url": f"https://x.com/{who or 'i'}/status/{d['id_str']}",
            "likes": count(d.get("favorite_count")), "replies": count(d.get("conversation_count")), "from": "X embed data"}


def _one(post_id: str, base: str) -> dict[str, Any] | None:
    import requests

    try:
        resp = requests.get(f"{base}?id={post_id}&lang=en&token={embed_token(post_id)}", headers={"User-Agent": UA}, timeout=TIMEOUT_S)
        if resp.status_code != 200:
            return None
        post = from_embed(resp.json())
        return post if post and post["text"] else None
    except Exception:  # noqa: BLE001 - that post is left out
        return None


def lookup(ids: list[Any], base: str = EMBED) -> dict[str, dict[str, Any]]:
    """X posts by id: {id: {author, text, url, likes, replies, from}} for those X serves. Eight at a time. Never raises."""
    want = list(dict.fromkeys(i for i in (str(x) for x in ids or []) if _POST_ID.match(i)))
    if not want:
        return {}
    with ThreadPoolExecutor(max_workers=min(AT_ONCE, len(want))) as pool:
        found = list(pool.map(lambda i: _one(i, base), want))
    return {i: post for i, post in zip(want, found) if post}
