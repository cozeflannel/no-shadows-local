"""Record keys: one case per social post, regardless of how the link was written.

normalize_url("https://mobile.twitter.com/a/status/123?s=20") == "x.com/status/123"
"""

import re
from urllib.parse import parse_qs, urlparse

_TRACKING = re.compile(r"^(utm_|fbclid|gclid|igshid|si$|s$|t$|ref|ref_src|feature|share|mibextid)", re.I)
_URL_IN_TEXT = re.compile(r"https?://[^\s<>|\"')\]]+", re.I)


def extract_url(text: str | None) -> str | None:
    """First http(s) URL in text (handles Chat's <url|label> link markup)."""
    if not text:
        return None
    m = _URL_IN_TEXT.search(text)
    return m.group(0).rstrip(".,;") if m else None


def normalize_url(url: str | None) -> str | None:
    if not url:
        return None
    url = url.strip().strip("<>")
    if "|" in url:  # Chat markup <url|label>
        url = url.split("|", 1)[0]
    if not re.match(r"^https?://", url, re.I):
        url = "https://" + url
    try:
        p = urlparse(url)
    except ValueError:
        return None
    host = (p.hostname or "").lower()
    for pre in ("www.", "m.", "mobile.", "old.", "new."):
        if host.startswith(pre):
            host = host[len(pre):]
    if not host or "." not in host:
        return None
    path = re.sub(r"/{2,}", "/", p.path or "").rstrip("/")
    query = parse_qs(p.query, keep_blank_values=False)

    if host in ("twitter.com", "x.com"):
        m = re.search(r"/status(?:es)?/(\d+)", path)
        return f"x.com/status/{m.group(1)}" if m else f"x.com{path.lower()}"
    if host == "youtu.be":
        vid = path.strip("/").split("/")[0]
        return f"youtube.com/watch?v={vid}" if vid else "youtube.com"
    if host.endswith("youtube.com"):
        m = re.match(r"^/(?:shorts|live|embed)/([\w-]+)", path)
        if m:
            return f"youtube.com/watch?v={m.group(1)}"
        if "v" in query:
            return f"youtube.com/watch?v={query['v'][0]}"
        return f"youtube.com{path}"
    if host == "redd.it":
        return f"reddit.com/comments/{path.strip('/')}"
    if host.endswith("reddit.com"):
        m = re.search(r"/comments/(\w+)", path)
        if m:
            return f"reddit.com/comments/{m.group(1)}"
    if host in ("threads.net", "threads.com"):
        host = "threads.net"
    kept = sorted((k, v[0]) for k, v in query.items() if not _TRACKING.match(k))
    qs = ("?" + "&".join(f"{k}={v}" for k, v in kept)) if kept else ""
    return f"{host}{path}{qs}"


def record_key(fields: dict, key_fields: list[str]) -> str | None:
    """Join the normalized key fields (URLs normalized; others lower-cased)."""
    parts = []
    for name in key_fields or ["post_url"]:
        value = fields.get(name)
        if value in (None, ""):
            continue
        if isinstance(value, str) and ("http" in value.lower() or "." in value and "/" in value):
            value = normalize_url(value) or value.strip().lower()
        else:
            value = str(value).strip().lower()
        parts.append(value)
    return "|".join(parts) or None


def domain_of(url: str | None) -> str | None:
    norm = normalize_url(url)
    return norm.split("/", 1)[0].split("?", 1)[0] if norm else None
