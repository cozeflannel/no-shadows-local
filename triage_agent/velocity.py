"""Post velocity and 7-day trajectory tracking (`T+0` to `T+168h`), built natively into the Console.

Gives incident managers and analysts live engagement curves, peak hourly spikes, side-by-side post comparisons and
spike alerts alongside Temp checks and alert cases:

- **URL & post parser** (SSRF-safe allowlist): X (`x.com`, `twitter.com` status URLs and bare Snowflake IDs, decoding
  exact UTC post timestamps from `(id >> 22) + 1288834974657`), Bluesky (`bsky.app/profile/<actor>/post/<rkey>`), plus
  clean normalized keys for other social platforms (Reddit, YouTube, TikTok, Instagram) so every alert case can keep
  engagement snapshots from triage, follow-ups and Sonar even when live public polling covers X and Bluesky.
- **Public engagement poller** (zero API keys): X via X's public embed endpoint (`triage_agent/xposts.py` token) and
  Bluesky via `public.api.bsky.app/xrpc/app.bsky.feed.getPostThread`, with per-platform circuit breakers and tiered
  cadence (<6h every 15m, 6-24h every 30m, 1-3d every 2h, 3-7d every 6h; stops after 168h / 7 days).
- **168-hour trajectory (`T+0` to `T+168h`)**: coalesces snapshots within 15 minutes, interpolates short gaps up to 8h,
  computes hourly velocity (`delta/hr`), cumulative engagements, reposts+replies, peak hourly spike (`peak_per_hour`
  at `T+Nh`), and traction tier (`steady` | `growing` | `surging`) in plain English.
- **Spike alerts**: when the switch `velocity_tracking` (default OFF) is ON, background polling emits a `velocity.spike`
  platform event (surfacing in the Console header bell) when a watched or case-linked post crosses into `growing` or
  `surging`, and queues an internal notification (`dm` to watchers or `team` space — never Burson's space, obeying
  Testing mode).
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING, Any
from urllib.parse import urlparse

from . import xposts
from .events import PlatformEvent

if TYPE_CHECKING:  # pragma: no cover
    from .context import AgentContext
    from .models import Case

log = logging.getLogger(__name__)

POSTS = "velocity_posts"
SNAPSHOTS = "velocity_snapshots"
HEALTH = "velocity:health"
LAST_RUN = "velocity:last"
SWITCH = "velocity_tracking"

TWITTER_EPOCH_MS = 1288834974657
TRACKING_HOURS = 168  # 7 days
HOUR_MS = 3600 * 1000
COALESCE_MS = 15 * 60 * 1000
MAX_SNAPSHOTS = 700
MAX_INTERP_HOURS = 8
TIMEOUT_S = 8
CIRCUIT_BLOCKS = 3
CIRCUIT_COOLDOWN_S = 600
LEGACY_BUCKET = "brand-social-central-data-cipher-config"
LEGACY_KEY = "post_velocity_tracker/tracked_posts.json"

X_HOSTS = frozenset({"x.com", "www.x.com", "mobile.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com"})
BSKY_HOSTS = frozenset({"bsky.app", "www.bsky.app"})
OTHER_HOSTS: dict[str, str] = {
    "reddit.com": "reddit", "www.reddit.com": "reddit", "old.reddit.com": "reddit",
    "youtube.com": "youtube", "www.youtube.com": "youtube", "youtu.be": "youtube", "m.youtube.com": "youtube",
    "tiktok.com": "tiktok", "www.tiktok.com": "tiktok",
    "instagram.com": "instagram", "www.instagram.com": "instagram",
    "threads.net": "threads", "www.threads.net": "threads",
    "facebook.com": "facebook", "www.facebook.com": "facebook",
}

_SNOWFLAKE_RE = re.compile(r"^\d{10,25}$")
_X_USER_RE = re.compile(r"^/([A-Za-z0-9_]{1,15})/status(?:es)?/(\d{10,25})(?:/.*)?$", re.I)
_X_WEB_RE = re.compile(r"^/i/(?:web/)?status(?:es)?/(\d{10,25})(?:/.*)?$", re.I)
_BSKY_RE = re.compile(r"^/profile/([A-Za-z0-9._:-]{1,256})/post/([A-Za-z0-9]{1,64})/?$")


def decode_snowflake_ms(post_id: str | int | None) -> int | None:
    """UTC epoch milliseconds embedded inside an X/Twitter numeric status ID."""
    if post_id is None:
        return None
    s = str(post_id).strip()
    if not _SNOWFLAKE_RE.match(s):
        return None
    try:
        ms = (int(s) >> 22) + TWITTER_EPOCH_MS
        return ms if ms >= TWITTER_EPOCH_MS else None
    except ValueError:
        return None


def parse_post_input(raw: str | None, *, allow_other_platforms: bool = True) -> dict[str, Any]:
    """Parse and validate a post URL or X status ID with strict hostname allowlisting (SSRF-safe)."""
    text = str(raw or "").strip()
    if not text:
        raise ValueError("Enter an X or Bluesky post link to track.")
    if _SNOWFLAKE_RE.match(text):
        ms = decode_snowflake_ms(text)
        if ms is None:
            raise ValueError("That status ID does not look like a valid X post ID.")
        return {
            "key": f"x_{text}",
            "platform": "x",
            "live_poll": True,
            "guid": text,
            "author": "",
            "rkey": "",
            "canonical_url": f"https://x.com/i/status/{text}",
            "published_ms": ms,
        }
    parsed = urlparse(text)
    if parsed.scheme not in ("http", "https"):
        raise ValueError("Post links must start with https://.")
    if parsed.username or parsed.password or parsed.port is not None:
        raise ValueError("Post links may not contain credentials or custom ports.")
    host = (parsed.hostname or "").lower()
    if host in X_HOSTS:
        m = _X_USER_RE.match(parsed.path)
        if m:
            author, pid = m.group(1), m.group(2)
        else:
            mw = _X_WEB_RE.match(parsed.path)
            if not mw:
                raise ValueError("Enter a direct X post link like https://x.com/user/status/1234567890.")
            author, pid = "", mw.group(1)
        ms = decode_snowflake_ms(pid)
        return {
            "key": f"x_{pid}",
            "platform": "x",
            "live_poll": True,
            "guid": pid,
            "author": author,
            "rkey": "",
            "canonical_url": f"https://x.com/{author or 'i'}/status/{pid}",
            "published_ms": ms,
        }
    if host in BSKY_HOSTS:
        mb = _BSKY_RE.match(parsed.path)
        if not mb:
            raise ValueError("Enter a direct Bluesky post link like https://bsky.app/profile/handle/post/abc123.")
        actor, rkey = mb.group(1), mb.group(2)
        safe = re.sub(r"[^A-Za-z0-9_-]", "_", f"{actor}_{rkey}")[:120]
        return {
            "key": f"bsky_{safe}",
            "platform": "bluesky",
            "live_poll": True,
            "guid": f"bsky:{actor}:{rkey}",
            "author": actor,
            "rkey": rkey,
            "canonical_url": f"https://bsky.app/profile/{actor}/post/{rkey}",
            "published_ms": None,
        }
    if allow_other_platforms and host in OTHER_HOSTS:
        plat = OTHER_HOSTS[host]
        clean = f"https://{host}{parsed.path}".rstrip("/")
        if parsed.query and plat == "youtube" and "v=" in parsed.query:
            clean = f"{clean}?{parsed.query}"
        digest = hashlib.sha1(clean.lower().encode()).hexdigest()[:16]
        return {
            "key": f"{plat}_{digest}",
            "platform": plat,
            "live_poll": False,
            "guid": f"{plat}:{digest}",
            "author": "",
            "rkey": "",
            "canonical_url": clean,
            "published_ms": None,
        }
    raise ValueError("Live velocity polling supports X (x.com) and Bluesky (bsky.app) post links.")


def _nonneg(val: Any) -> int:
    try:
        n = int(float(val))
        return n if n > 0 else 0
    except (TypeError, ValueError):
        return 0


def classify_traction(baseline: int, current: int) -> dict[str, Any]:
    """Classify post growth into plain tiers (`steady` | `growing` | `surging`) matching the SLRR traction thresholds."""
    base = _nonneg(baseline)
    cur = max(base, _nonneg(current))
    delta = max(0, cur - base)
    mult_raw = (cur / base) if base > 0 else (float(cur) if cur > 0 else 1.0)
    mult = round(mult_raw, 2)
    if delta >= 10_000:
        return {"tier": "surging", "label": "Surging", "delta": delta, "multiplier": mult,
                "reason": f"+{delta:,} engagements since first seen (10,000+ surge bar)"}
    if cur >= 25_000 and delta >= 2_500:
        return {"tier": "surging", "label": "Surging", "delta": delta, "multiplier": mult,
                "reason": f"{cur:,} total engagements with +{delta:,} new growth"}
    if mult_raw >= 5.0 and cur >= 2_500:
        return {"tier": "surging", "label": "Surging", "delta": delta, "multiplier": mult,
                "reason": f"{mult:g}x growth to {cur:,} engagements"}
    if delta >= 1_000:
        return {"tier": "growing", "label": "Growing", "delta": delta, "multiplier": mult,
                "reason": f"+{delta:,} engagements since first seen"}
    if delta >= 400 and mult_raw >= 1.35:
        return {"tier": "growing", "label": "Growing", "delta": delta, "multiplier": mult,
                "reason": f"+{delta:,} engagements ({mult:g}x baseline)"}
    return {"tier": "steady", "label": "Steady", "delta": delta, "multiplier": mult,
            "reason": f"+{delta:,} engagements (within normal pace)" if delta else "Holding steady"}


def coalesce_snapshots(existing: list[dict[str, Any]], incoming: dict[str, Any]) -> list[dict[str, Any]]:
    """Merge a new `{ts, likes, comments, shares, engagements}` point, coalescing readings within 15 minutes."""
    snap = {
        "ts": int(incoming.get("ts") or 0),
        "likes": _nonneg(incoming.get("likes")),
        "comments": _nonneg(incoming.get("comments")),
        "shares": _nonneg(incoming.get("shares")),
    }
    snap["engagements"] = max(_nonneg(incoming.get("engagements")), snap["likes"] + snap["comments"] + snap["shares"])
    pts = sorted([dict(p) for p in (existing or []) if p.get("ts")], key=lambda x: int(x["ts"]))
    if pts and abs(snap["ts"] - int(pts[-1]["ts"])) < COALESCE_MS:
        last = pts[-1]
        pts[-1] = {
            "ts": max(int(last["ts"]), snap["ts"]),
            "likes": max(_nonneg(last.get("likes")), snap["likes"]),
            "comments": max(_nonneg(last.get("comments")), snap["comments"]),
            "shares": max(_nonneg(last.get("shares")), snap["shares"]),
            "engagements": max(_nonneg(last.get("engagements")), snap["engagements"]),
        }
    else:
        pts.append(snap)
    # Enforce monotonic cumulative engagement so deleted-like jitter never creates negative hourly velocity.
    running = 0
    for p in pts:
        running = max(running, _nonneg(p.get("engagements")))
        p["engagements"] = running
    if len(pts) > MAX_SNAPSHOTS:
        pts = [pts[0], *pts[-(MAX_SNAPSHOTS - 1):]]
    return pts


def build_trajectory(published_ms: int | None, snapshots: list[dict[str, Any]], now_ms: int | None = None) -> dict[str, Any]:
    """Build normalized `T+0..T+168` hourly buckets + summary stats from timestamped snapshots."""
    pts = sorted([p for p in (snapshots or []) if p.get("ts")], key=lambda x: int(x["ts"]))
    if not pts:
        return {
            "hours": [],
            "sparkline": [],
            "peak_per_hour": 0,
            "peak_at_hour": 0,
            "velocity_1h": 0,
            "velocity_24h": 0,
            "elapsed_hours": 0,
        }
    first_ts = int(pts[0]["ts"])
    origin = (
        int(published_ms)
        if (published_ms and int(published_ms) <= first_ts + HOUR_MS and first_ts - int(published_ms) < TRACKING_HOURS * HOUR_MS)
        else first_ts
    )
    end_ms = max(int(pts[-1]["ts"]), int(now_ms or pts[-1]["ts"]))
    max_h = min(TRACKING_HOURS, max(0, int((end_ms - origin) // HOUR_MS)))

    # Anchor T+0 at 0 when the post was published well before the first snapshot, else at the first snapshot.
    by_h: dict[int, dict[str, int]] = {}
    if int(pts[0]["ts"]) - origin >= HOUR_MS:
        by_h[0] = {"engagements": 0, "shares_replies": 0, "likes": 0}
    for p in pts:
        h = max(0, min(TRACKING_HOURS, int((int(p["ts"]) - origin) // HOUR_MS)))
        sr = _nonneg(p.get("shares")) + _nonneg(p.get("comments"))
        prev = by_h.get(h)
        if not prev or _nonneg(p.get("engagements")) >= prev["engagements"]:
            by_h[h] = {"engagements": _nonneg(p.get("engagements")), "shares_replies": sr, "likes": _nonneg(p.get("likes"))}

    known_hours = sorted(by_h)
    cum: list[int | None] = [None] * (max_h + 1)
    sr_cum: list[int | None] = [None] * (max_h + 1)
    for h in known_hours:
        if h <= max_h:
            cum[h] = by_h[h]["engagements"]
            sr_cum[h] = by_h[h]["shares_replies"]
    # Interpolate short gaps up to MAX_INTERP_HOURS; carry flat across longer gaps so cumulative stays defined.
    for idx in range(len(known_hours) - 1):
        h0, h1 = known_hours[idx], known_hours[idx + 1]
        if h1 > max_h:
            h1 = max_h
        span = h1 - h0
        if span <= 1:
            continue
        v0, v1 = by_h[h0]["engagements"], by_h[known_hours[idx + 1]]["engagements"]
        s0, s1 = by_h[h0]["shares_replies"], by_h[known_hours[idx + 1]]["shares_replies"]
        for h in range(h0 + 1, h1):
            if span <= MAX_INTERP_HOURS:
                frac = (h - h0) / span
                cum[h] = int(round(v0 + (v1 - v0) * frac))
                sr_cum[h] = int(round(s0 + (s1 - s0) * frac))
            else:
                cum[h] = v0
                sr_cum[h] = s0
    last_known = known_hours[-1]
    for h in range(min(last_known, max_h) + 1, max_h + 1):
        cum[h] = by_h[last_known]["engagements"]
        sr_cum[h] = by_h[last_known]["shares_replies"]
    first_val = by_h[known_hours[0]]["engagements"]
    first_sr = by_h[known_hours[0]]["shares_replies"]
    for h in range(0, min(known_hours[0], max_h + 1)):
        cum[h] = first_val if h == known_hours[0] else 0
        sr_cum[h] = first_sr if h == known_hours[0] else 0

    hours: list[dict[str, Any]] = []
    peak_rate, peak_h = 0, 0
    for h in range(max_h + 1):
        c_now = int(cum[h] or 0)
        c_prev = int(cum[h - 1] or 0) if h > 0 else (0 if int(pts[0]["ts"]) - origin >= HOUR_MS else c_now)
        vel = max(0, c_now - c_prev)
        sr_now = int(sr_cum[h] or 0)
        sr_prev = int(sr_cum[h - 1] or 0) if h > 0 else (0 if int(pts[0]["ts"]) - origin >= HOUR_MS else sr_now)
        if vel > peak_rate:
            peak_rate, peak_h = vel, h
        hours.append({
            "hour": h,
            "label": f"T+{h}h",
            "ts_ms": origin + h * HOUR_MS,
            "cumulative": c_now,
            "hourly": vel,
            "shares_replies": max(0, sr_now - sr_prev),
            "shares_replies_total": sr_now,
        })

    vel_1h = hours[-1]["hourly"] if hours else 0
    if len(hours) >= 2:
        idx_24 = max(0, len(hours) - 25)
        vel_24h = max(0, hours[-1]["cumulative"] - hours[idx_24]["cumulative"])
    else:
        vel_24h = max(0, int(pts[-1]["engagements"]) - int(pts[0]["engagements"]))

    step = max(1, len(hours) // 24) if hours else 1
    spark = [hours[i]["hourly"] for i in range(0, len(hours), step)]
    if hours and (len(hours) - 1) % step != 0:
        spark.append(hours[-1]["hourly"])
    return {
        "hours": hours,
        "sparkline": spark[-28:],
        "peak_per_hour": peak_rate,
        "peak_at_hour": peak_h,
        "velocity_1h": vel_1h,
        "velocity_24h": vel_24h,
        "elapsed_hours": max_h,
    }


# ---------------------------------------------------------------------------
# Public engagement pollers (X + Bluesky, zero credentials)
# ---------------------------------------------------------------------------


def _circuit_open(ctx: "AgentContext", platform: str) -> bool:
    st = (ctx.store.get_kv(HEALTH) or {}).get(platform) or {}
    until = float(st.get("open_until") or 0)
    return until > ctx.now().timestamp()


def _record_poll(ctx: "AgentContext", platform: str, status: str) -> None:
    all_st = dict(ctx.store.get_kv(HEALTH) or {})
    st = dict(all_st.get(platform) or {"ok": 0, "errors": 0, "blocks": 0, "open_until": 0, "last_status": ""})
    now_s = ctx.now().timestamp()
    st["last_status"] = status
    st["last_at"] = ctx.now().isoformat()
    if status == "ok":
        st["ok"] = int(st.get("ok") or 0) + 1
        st["blocks"] = 0
        st["open_until"] = 0
    else:
        st["errors"] = int(st.get("errors") or 0) + 1
        if status in ("rate_limited", "blocked"):
            st["blocks"] = int(st.get("blocks") or 0) + 1
            if st["blocks"] >= CIRCUIT_BLOCKS:
                st["open_until"] = now_s + CIRCUIT_COOLDOWN_S
    all_st[platform] = st
    ctx.store.put_kv(HEALTH, all_st)


def poll_x(post_id: str, *, session: Any = None) -> dict[str, Any]:
    """Fetch public engagement counts for an X status ID via X's embed syndication JSON."""
    import requests

    http = session or requests
    headers = {"User-Agent": xposts.UA, "Accept": "application/json"}
    url = f"{xposts.EMBED}?id={post_id}&lang=en&token={xposts.embed_token(post_id)}"
    try:
        resp = http.get(url, headers=headers, timeout=TIMEOUT_S)
        if resp.status_code != 200:
            resp = http.get(f"{xposts.EMBED}?id={post_id}&lang=en&token=x", headers=headers, timeout=TIMEOUT_S)
    except Exception as exc:  # noqa: BLE001
        return {"status": "network_error", "error": str(exc)[:200]}
    if resp.status_code == 404:
        return {"status": "deleted", "error": "Post was deleted or is private on X."}
    if resp.status_code == 429:
        return {"status": "rate_limited", "error": "X temporarily rate-limited public lookups."}
    if resp.status_code == 403:
        return {"status": "blocked", "error": "X refused the public lookup."}
    if resp.status_code != 200:
        return {"status": "network_error", "error": f"X returned HTTP {resp.status_code}."}
    try:
        data = resp.json()
    except Exception:  # noqa: BLE001
        return {"status": "parse_error", "error": "X returned non-JSON embed data."}
    if not isinstance(data, dict) or not (data.get("id_str") or data.get("text")):
        return {"status": "deleted", "error": "Post is unavailable on X."}
    user = data.get("user") or {}
    author = str(user.get("screen_name") or "").strip()
    likes = _nonneg(data.get("favorite_count"))
    comments = _nonneg(data.get("conversation_count") or data.get("reply_count"))
    shares = _nonneg(data.get("retweet_count")) + _nonneg(data.get("quote_count"))
    published_ms = decode_snowflake_ms(post_id)
    if not published_ms and data.get("created_at"):
        try:
            published_ms = int(datetime.fromisoformat(str(data["created_at"]).replace("Z", "+00:00")).timestamp() * 1000)
        except ValueError:
            published_ms = None
    return {
        "status": "ok",
        "author": author,
        "author_name": str(user.get("name") or author),
        "followers": _nonneg(user.get("followers_count")) or None,
        "text": str(data.get("text") or "").strip()[:800],
        "canonical_url": f"https://x.com/{author or 'i'}/status/{post_id}",
        "published_ms": published_ms,
        "likes": likes,
        "comments": comments,
        "shares": shares,
        "engagements": likes + comments + shares,
    }


def poll_bluesky(actor: str, rkey: str, *, session: Any = None) -> dict[str, Any]:
    """Fetch public engagement counts for a Bluesky post via the public ATProto AppView API."""
    import requests

    http = session or requests
    at_uri = f"at://{actor}/app.bsky.feed.post/{rkey}"
    try:
        resp = http.get(
            "https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread",
            params={"uri": at_uri, "depth": 0},
            headers={"User-Agent": xposts.UA, "Accept": "application/json"},
            timeout=TIMEOUT_S,
        )
    except Exception as exc:  # noqa: BLE001
        return {"status": "network_error", "error": str(exc)[:200]}
    if resp.status_code in (400, 404):
        return {"status": "deleted", "error": "Post was not found on Bluesky."}
    if resp.status_code == 429:
        return {"status": "rate_limited", "error": "Bluesky rate-limited public lookups."}
    if resp.status_code == 403:
        return {"status": "blocked", "error": "Bluesky refused the public lookup."}
    if resp.status_code != 200:
        return {"status": "network_error", "error": f"Bluesky returned HTTP {resp.status_code}."}
    try:
        post = ((resp.json() or {}).get("thread") or {}).get("post") or {}
    except Exception:  # noqa: BLE001
        return {"status": "parse_error", "error": "Bluesky returned unreadable data."}
    if not post:
        return {"status": "deleted", "error": "Post is unavailable on Bluesky."}
    au = post.get("author") or {}
    handle = str(au.get("handle") or actor).strip()
    rec = post.get("record") or {}
    likes = _nonneg(post.get("likeCount"))
    comments = _nonneg(post.get("replyCount"))
    shares = _nonneg(post.get("repostCount")) + _nonneg(post.get("quoteCount"))
    published_ms: int | None = None
    created = rec.get("createdAt") or post.get("indexedAt")
    if created:
        try:
            published_ms = int(datetime.fromisoformat(str(created).replace("Z", "+00:00")).timestamp() * 1000)
        except ValueError:
            published_ms = None
    return {
        "status": "ok",
        "author": handle,
        "author_name": str(au.get("displayName") or handle),
        "followers": None,
        "text": str(rec.get("text") or "").strip()[:800],
        "canonical_url": f"https://bsky.app/profile/{handle}/post/{rkey}",
        "published_ms": published_ms,
        "likes": likes,
        "comments": comments,
        "shares": shares,
        "engagements": likes + comments + shares,
    }


# ---------------------------------------------------------------------------
# Store helpers, case seeding, polling & spike alerts
# ---------------------------------------------------------------------------


def _next_interval_min(published_ms: int | None, now_ms: int, *, tracked_ms: int | None = None) -> int | None:
    """Tiered polling cadence across the 7-day window; None once older than 168h."""
    anchor_ms = published_ms
    if anchor_ms and tracked_ms and (now_ms - anchor_ms) / HOUR_MS > TRACKING_HOURS:
        anchor_ms = tracked_ms
    elif not anchor_ms:
        anchor_ms = tracked_ms
    if not anchor_ms:
        return 30
    age_h = max(0.0, (now_ms - anchor_ms) / HOUR_MS)
    if age_h > TRACKING_HOURS:
        return None
    if age_h < 6:
        return 15
    if age_h < 24:
        return 30
    if age_h < 72:
        return 120
    return 360


def _recompute_doc(doc: dict[str, Any], snaps: list[dict[str, Any]], now_ms: int) -> dict[str, Any]:
    baseline = _nonneg(doc.get("baseline_engagements"))
    if baseline == 0 and snaps:
        baseline = _nonneg(snaps[0].get("engagements"))
        doc["baseline_engagements"] = baseline
    current = _nonneg(snaps[-1].get("engagements")) if snaps else baseline
    likes = _nonneg(snaps[-1].get("likes")) if snaps else _nonneg(doc.get("likes"))
    comments = _nonneg(snaps[-1].get("comments")) if snaps else _nonneg(doc.get("comments"))
    shares = _nonneg(snaps[-1].get("shares")) if snaps else _nonneg(doc.get("shares"))
    traj = build_trajectory(doc.get("published_ms"), snaps, now_ms=now_ms)
    traction = classify_traction(baseline, current)
    doc.update({
        "current_engagements": current,
        "likes": likes,
        "comments": comments,
        "shares": shares,
        "tier": traction["tier"],
        "tier_label": traction["label"],
        "delta_engagements": traction["delta"],
        "multiplier": traction["multiplier"],
        "tier_reason": traction["reason"],
        "peak_per_hour": traj["peak_per_hour"],
        "peak_at_hour": traj["peak_at_hour"],
        "velocity_1h": traj["velocity_1h"],
        "velocity_24h": traj["velocity_24h"],
        "elapsed_hours": traj["elapsed_hours"],
        "sparkline": traj["sparkline"],
        "snapshot_count": len(snaps),
        "updated_at": datetime.fromtimestamp(now_ms / 1000, tz=timezone.utc).isoformat(),
    })
    return doc


def _summary(doc: dict[str, Any], viewer: str = "") -> dict[str, Any]:
    watchers = [str(w).lower() for w in (doc.get("watchers") or []) if w]
    return {
        "key": doc["key"],
        "platform": doc.get("platform") or "x",
        "live_poll": bool(doc.get("live_poll", True)),
        "url": doc.get("canonical_url") or "",
        "author": doc.get("author") or "",
        "author_name": doc.get("author_name") or doc.get("author") or "",
        "followers": doc.get("followers"),
        "text": doc.get("text") or "",
        "case_id": doc.get("case_id") or None,
        "alert_name": doc.get("alert_name") or "",
        "product": doc.get("product") or "",
        "published_at": (datetime.fromtimestamp(doc["published_ms"] / 1000, tz=timezone.utc).isoformat()
                         if doc.get("published_ms") else doc.get("created_at")),
        "last_polled_at": doc.get("last_polled_at"),
        "poll_status": doc.get("poll_status") or "seeded",
        "poll_error": doc.get("poll_error") or "",
        "baseline_engagements": _nonneg(doc.get("baseline_engagements")),
        "current_engagements": _nonneg(doc.get("current_engagements")),
        "likes": _nonneg(doc.get("likes")),
        "comments": _nonneg(doc.get("comments")),
        "shares": _nonneg(doc.get("shares")),
        "delta_engagements": _nonneg(doc.get("delta_engagements")),
        "multiplier": float(doc.get("multiplier") or 1.0),
        "tier": doc.get("tier") or "steady",
        "tier_label": doc.get("tier_label") or "Steady",
        "tier_reason": doc.get("tier_reason") or "Holding steady",
        "peak_per_hour": _nonneg(doc.get("peak_per_hour")),
        "peak_at_hour": _nonneg(doc.get("peak_at_hour")),
        "velocity_1h": _nonneg(doc.get("velocity_1h")),
        "velocity_24h": _nonneg(doc.get("velocity_24h")),
        "elapsed_hours": _nonneg(doc.get("elapsed_hours")),
        "sparkline": list(doc.get("sparkline") or []),
        "snapshot_count": _nonneg(doc.get("snapshot_count")),
        "watched": bool(viewer and viewer.lower() in watchers),
        "watcher_count": len(watchers),
    }


def _case_fields(c: "Case") -> dict[str, Any]:
    first = c.attempts[0] if c.attempts else None
    latest = c.latest
    res = latest.result if latest else None
    a = res.assessment if res else None
    norm = (res.normalized if res else None) or {}
    first_res = first.result if first else None
    first_a = first_res.assessment if first_res else None
    first_norm = (first_res.normalized if first_res else None) or {}
    initial_eng = _nonneg(
        first_a.engagement_total if first_a and first_a.engagement_total is not None else first_norm.get("total_engagement")
    )
    latest_eng = _nonneg(
        a.engagement_total if a and a.engagement_total is not None else norm.get("total_engagement")
    )
    return {
        "post_url": str(norm.get("post_url") or first_norm.get("post_url") or "").strip(),
        "initial_eng": initial_eng or latest_eng,
        "latest_eng": max(initial_eng, latest_eng),
        "received_at": (first.received_at if first else None) or c.created_at,
        "norm": norm,
        "assessment": a,
    }


def _find_matching_case(ctx: "AgentContext", canonical_url: str, guid: str = "") -> "Case | None":
    target = canonical_url.rstrip("/").lower()
    tail = guid.split(":")[-1].lower() if guid else ""
    for c in ctx.store.list_cases(limit=200):
        u = _case_fields(c)["post_url"].rstrip("/").lower()
        if not u:
            continue
        if u == target or (tail and len(tail) >= 10 and tail in u):
            return c
    return None


def sync_from_cases(ctx: "AgentContext", *, limit: int = 120) -> int:
    """Seed or update velocity records from recent alert cases so every alert view has immediate baseline velocity."""
    now_ms = int(ctx.now().timestamp() * 1000)
    cutoff = ctx.now() - timedelta(days=7)
    existing = {d["key"]: d for d in ctx.store.list_docs(POSTS, limit=500) if d.get("key")}
    added = 0
    for c in ctx.store.list_cases(since=cutoff, limit=limit):
        cf = _case_fields(c)
        if not cf["post_url"]:
            continue
        try:
            parsed = parse_post_input(cf["post_url"], allow_other_platforms=True)
        except ValueError:
            continue
        key = parsed["key"]
        eng = cf["latest_eng"]
        base_eng = cf["initial_eng"]
        recv_ms = int((cf["received_at"] or ctx.now()).timestamp() * 1000)
        doc = existing.get(key)
        snap_doc = ctx.store.get_doc(SNAPSHOTS, key) or {"key": key, "points": []}
        pts = list(snap_doc.get("points") or [])
        changed = False
        if doc is None:
            a = cf["assessment"]
            norm = cf["norm"]
            followers = _nonneg(norm.get("followers")) or None
            doc = {
                **parsed,
                "author": parsed["author"] or str(norm.get("author") or "").lstrip("@"),
                "author_name": str(norm.get("author") or parsed["author"] or ""),
                "followers": followers,
                "text": str(norm.get("post_content") or norm.get("summary") or c.alert_name or "")[:600],
                "case_id": c.case_id,
                "alert_name": c.alert_name or "",
                "product": (a.product if a and a.product else c.product) or "",
                "baseline_engagements": base_eng,
                "watchers": [],
                "alerted_tier": "",
                "manual": False,
                "created_at": (cf["received_at"] or ctx.now()).isoformat(),
                "last_polled_at": None,
                "poll_status": "seeded",
                "poll_error": "",
            }
            if base_eng > 0 or eng > 0:
                pts = coalesce_snapshots([], {"ts": recv_ms, "engagements": base_eng or eng})
                if eng > base_eng:
                    upd_ms = int((c.updated_at or ctx.now()).timestamp() * 1000)
                    pts = coalesce_snapshots(pts, {"ts": max(recv_ms + COALESCE_MS, upd_ms), "engagements": eng})
            added += 1
            changed = True
        else:
            if not doc.get("case_id"):
                doc["case_id"] = c.case_id
                doc["alert_name"] = c.alert_name or ""
                doc["product"] = doc.get("product") or c.product or ""
                changed = True
            if eng > _nonneg(doc.get("current_engagements")):
                pts = coalesce_snapshots(pts, {"ts": now_ms, "engagements": eng})
                changed = True
        if changed:
            _recompute_doc(doc, pts, now_ms)
            ctx.store.put_doc(SNAPSHOTS, key, {"key": key, "points": pts})
            ctx.store.put_doc(POSTS, key, doc)
            existing[key] = doc
    return added


def poll_one(ctx: "AgentContext", doc: dict[str, Any], *, force: bool = False, session: Any = None,
             emit_alerts: bool = False) -> dict[str, Any]:
    """Poll one tracked post now, append its snapshot, recompute its 168h curve, and optionally fire spike alerts."""
    now_ms = int(ctx.now().timestamp() * 1000)
    key = doc["key"]
    platform = doc.get("platform") or "x"
    snap_doc = ctx.store.get_doc(SNAPSHOTS, key) or {"key": key, "points": []}
    pts = list(snap_doc.get("points") or [])
    prev_tier = doc.get("tier") or "steady"

    if not doc.get("live_poll"):
        _recompute_doc(doc, pts, now_ms)
        ctx.store.put_doc(POSTS, key, doc)
        return doc
    if not force and _circuit_open(ctx, platform):
        doc["poll_error"] = f"{platform.capitalize()} public lookup paused briefly after repeated blocks."
        ctx.store.put_doc(POSTS, key, doc)
        return doc

    if platform == "x":
        pid = str(doc.get("guid") or key.removeprefix("x_"))
        got = poll_x(pid, session=session)
    elif platform == "bluesky":
        got = poll_bluesky(str(doc.get("author") or ""), str(doc.get("rkey") or ""), session=session)
    else:
        got = {"status": "unsupported", "error": f"Live polling is not supported for {platform}."}

    _record_poll(ctx, platform, got["status"])
    doc["last_polled_at"] = ctx.now().isoformat()
    doc["poll_status"] = got["status"]
    if got["status"] == "ok":
        doc["poll_error"] = ""
        if got.get("author"):
            doc["author"] = got["author"]
        if got.get("author_name"):
            doc["author_name"] = got["author_name"]
        if got.get("followers"):
            doc["followers"] = got["followers"]
        if got.get("text"):
            doc["text"] = got["text"]
        if got.get("canonical_url"):
            doc["canonical_url"] = got["canonical_url"]
        if got.get("published_ms") and not doc.get("published_ms"):
            doc["published_ms"] = got["published_ms"]
        pts = coalesce_snapshots(pts, {
            "ts": now_ms,
            "likes": got["likes"],
            "comments": got["comments"],
            "shares": got["shares"],
            "engagements": got["engagements"],
        })
        ctx.store.put_doc(SNAPSHOTS, key, {"key": key, "points": pts})
    else:
        doc["poll_error"] = got.get("error") or ""

    _recompute_doc(doc, pts, now_ms)
    if emit_alerts:
        _maybe_alert_spike(ctx, doc, prev_tier=prev_tier)
    ctx.store.put_doc(POSTS, key, doc)
    return doc


def _maybe_alert_spike(ctx: "AgentContext", doc: dict[str, Any], *, prev_tier: str) -> None:
    """Emit a bell event and internal Chat notification when a watched or alert-linked post surges."""
    rank = {"steady": 0, "growing": 1, "surging": 2}
    new_tier = doc.get("tier") or "steady"
    already = doc.get("alerted_tier") or "steady"
    if rank.get(new_tier, 0) <= max(rank.get(prev_tier, 0), rank.get(already, 0)):
        return
    watchers = [str(w).strip().lower() for w in (doc.get("watchers") or []) if str(w).strip()]
    if not watchers and not doc.get("case_id"):
        return
    doc["alerted_tier"] = new_tier
    who = f"@{doc['author']}" if doc.get("author") else doc.get("platform", "post").upper()
    summary = (f"{doc['tier_label']} post velocity on {who}: {doc['current_engagements']:,} engagements "
               f"({doc['tier_reason']}; peak {doc['peak_per_hour']:,}/hr at T+{doc['peak_at_hour']}h)")
    ctx.emit(
        PlatformEvent.VELOCITY_SPIKE,
        case_id=doc.get("case_id") or None,
        actor="agent",
        payload={
            "post_key": doc["key"],
            "url": doc.get("canonical_url") or "",
            "tier": new_tier,
            "current_engagements": doc["current_engagements"],
            "delta_engagements": doc["delta_engagements"],
            "peak_per_hour": doc["peak_per_hour"],
            "summary": summary,
        },
    )
    prefix = ctx.config.agent.message_prefix
    case_part = f" · Alert {doc['case_id']}" if doc.get("case_id") else ""
    msg = (f"{prefix} *{doc['tier_label']} velocity*{case_part}\n"
           f"{who}: *{doc['current_engagements']:,}* engagements ({doc['tier_reason']}) · "
           f"peak *{doc['peak_per_hour']:,}/hr* at T+{doc['peak_at_hour']}h\n"
           f"{doc.get('canonical_url') or ''}").strip()
    if watchers:
        ctx.enqueue("dm", msg, recipients=watchers, case_id=doc.get("case_id") or None, source="velocity_spike")
    elif new_tier == "surging" and doc.get("case_id"):
        ctx.enqueue("team", msg, case_id=doc.get("case_id") or None, source="velocity_spike")


def track_post(ctx: "AgentContext", *, url: str = "", case_id: str = "", actor: str = "",
               poll: bool = True, watch: bool = False, session: Any = None) -> dict[str, Any]:
    """Start tracking a post by URL or alert case_id, optionally polling its live counts right away."""
    linked: "Case | None" = ctx.store.get_case(case_id) if case_id else None
    linked_cf = _case_fields(linked) if linked else None
    target_url = url.strip() or (linked_cf["post_url"] if linked_cf else "")
    if not target_url:
        raise ValueError("Enter a post link or choose an alert that has a post link.")
    parsed = parse_post_input(target_url, allow_other_platforms=bool(linked))
    if linked is None:
        linked = _find_matching_case(ctx, parsed["canonical_url"], parsed.get("guid") or "")
        linked_cf = _case_fields(linked) if linked else None
    key = parsed["key"]
    now_ms = int(ctx.now().timestamp() * 1000)
    doc = ctx.store.get_doc(POSTS, key)
    snap_doc = ctx.store.get_doc(SNAPSHOTS, key) or {"key": key, "points": []}
    pts = list(snap_doc.get("points") or [])
    if doc is None:
        base = linked_cf["initial_eng"] if linked_cf else 0
        norm = linked_cf["norm"] if linked_cf else {}
        doc = {
            **parsed,
            "author_name": parsed["author"],
            "followers": _nonneg(norm.get("followers")) or None,
            "text": str(norm.get("post_content") or (linked.alert_name if linked else "") or "")[:600],
            "case_id": linked.case_id if linked else None,
            "alert_name": linked.alert_name if linked else "",
            "product": linked.product if linked else "",
            "baseline_engagements": base,
            "watchers": [actor.lower()] if (watch and actor) else [],
            "alerted_tier": "",
            "manual": True,
            "added_by": actor,
            "created_at": ctx.now().isoformat(),
            "last_polled_at": None,
            "poll_status": "seeded",
            "poll_error": "",
        }
        if base > 0 and linked_cf:
            recv_ms = int((linked_cf["received_at"] or ctx.now()).timestamp() * 1000)
            pts = coalesce_snapshots([], {"ts": recv_ms, "engagements": base})
            ctx.store.put_doc(SNAPSHOTS, key, {"key": key, "points": pts})
    else:
        doc["manual"] = True
        if linked and not doc.get("case_id"):
            doc["case_id"] = linked.case_id
            doc["alert_name"] = linked.alert_name or ""
            doc["product"] = doc.get("product") or linked.product or ""
        if watch and actor and actor.lower() not in [w.lower() for w in (doc.get("watchers") or [])]:
            doc["watchers"] = [*(doc.get("watchers") or []), actor.lower()]

    if poll and doc.get("live_poll"):
        doc = poll_one(ctx, doc, force=True, session=session, emit_alerts=False)
    else:
        _recompute_doc(doc, pts, now_ms)
        ctx.store.put_doc(POSTS, key, doc)
    ctx.audit(actor=actor or "analyst", action="velocity.track", surface="console", target_type="post",
              target_id=key, summary=f"Tracked post velocity for {doc.get('canonical_url') or key}",
              case_id=doc.get("case_id") or None)
    return _summary(doc, viewer=actor)


def set_watch(ctx: "AgentContext", key: str, *, actor: str, watch: bool) -> dict[str, Any]:
    doc = ctx.store.get_doc(POSTS, key)
    if not doc:
        raise KeyError(key)
    who = actor.strip().lower()
    watchers = [str(w).lower() for w in (doc.get("watchers") or []) if w]
    if watch and who and who not in watchers:
        watchers.append(who)
    elif not watch:
        watchers = [w for w in watchers if w != who]
    doc["watchers"] = watchers
    ctx.store.put_doc(POSTS, key, doc)
    ctx.audit(actor=actor, action="velocity.watch" if watch else "velocity.unwatch", surface="console",
              target_type="post", target_id=key,
              summary=f"{'Watching' if watch else 'Stopped watching'} velocity spikes on {doc.get('canonical_url') or key}",
              case_id=doc.get("case_id") or None)
    return _summary(doc, viewer=actor)


def delete_post(ctx: "AgentContext", key: str, *, actor: str) -> None:
    doc = ctx.store.get_doc(POSTS, key)
    if not doc:
        raise KeyError(key)
    ctx.store.delete_doc(POSTS, key)
    ctx.store.delete_doc(SNAPSHOTS, key)
    ctx.audit(actor=actor, action="velocity.delete", surface="console", target_type="post", target_id=key,
              summary=f"Removed {doc.get('canonical_url') or key} from velocity tracking",
              case_id=doc.get("case_id") or None)


def list_posts(ctx: "AgentContext", *, sort: str = "peak", tier: str = "", platform: str = "",
               q: str = "", watched_only: bool = False, viewer: str = "") -> dict[str, Any]:
    sync_from_cases(ctx)
    docs = [d for d in ctx.store.list_docs(POSTS, limit=500) if d.get("key")]
    items = [_summary(d, viewer=viewer) for d in docs]
    counts = {"total": len(items), "surging": 0, "growing": 0, "steady": 0, "peak_today": 0}
    for it in items:
        t = it["tier"] if it["tier"] in ("surging", "growing", "steady") else "steady"
        counts[t] += 1
        if it["peak_per_hour"] > counts["peak_today"]:
            counts["peak_today"] = it["peak_per_hour"]
    if tier:
        items = [i for i in items if i["tier"] == tier]
    if platform:
        items = [i for i in items if i["platform"] == platform.lower()]
    if watched_only:
        items = [i for i in items if i["watched"]]
    if q.strip():
        needle = q.strip().lower()
        items = [i for i in items if needle in f"{i['author']} {i['text']} {i['alert_name']} {i['product']} {i['url']} {i['case_id'] or ''}".lower()]
    key_fn = {
        "peak": lambda x: (x["peak_per_hour"], x["current_engagements"]),
        "velocity_1h": lambda x: (x["velocity_1h"], x["peak_per_hour"]),
        "total": lambda x: (x["current_engagements"], x["peak_per_hour"]),
        "recent": lambda x: (x["published_at"] or "", x["current_engagements"]),
    }.get(sort, lambda x: (x["peak_per_hour"], x["current_engagements"]))
    items.sort(key=key_fn, reverse=True)
    return {
        "posts": items,
        "counts": counts,
        "switch": ctx.flag(SWITCH),
        "health": ctx.store.get_kv(HEALTH) or {},
        "last_run": ctx.store.get_kv(LAST_RUN),
    }


def get_detail(ctx: "AgentContext", key: str, *, viewer: str = "") -> dict[str, Any]:
    doc = ctx.store.get_doc(POSTS, key)
    if not doc:
        raise KeyError(key)
    snaps = list((ctx.store.get_doc(SNAPSHOTS, key) or {}).get("points") or [])
    traj = build_trajectory(doc.get("published_ms"), snaps, now_ms=int(ctx.now().timestamp() * 1000))
    return {
        "post": _summary(doc, viewer=viewer),
        "hours": traj["hours"],
        "snapshots": snaps[-200:],
        "watchers": list(doc.get("watchers") or []),
    }


def compare_posts(ctx: "AgentContext", keys: list[str], *, window_hours: int = 168, viewer: str = "") -> dict[str, Any]:
    win = 24 if window_hours <= 24 else (48 if window_hours <= 48 else TRACKING_HOURS)
    now_ms = int(ctx.now().timestamp() * 1000)
    series: list[dict[str, Any]] = []
    max_len = 0
    for k in keys[:6]:
        doc = ctx.store.get_doc(POSTS, k)
        if not doc:
            continue
        snaps = list((ctx.store.get_doc(SNAPSHOTS, k) or {}).get("points") or [])
        traj = build_trajectory(doc.get("published_ms"), snaps, now_ms=now_ms)
        clipped = [h for h in traj["hours"] if h["hour"] <= win]
        max_len = max(max_len, len(clipped))
        series.append({"post": _summary(doc, viewer=viewer), "hours": clipped})
    return {"window_hours": win, "max_hours": max_len, "series": series}


def lookup_batch(ctx: "AgentContext", *, case_ids: list[str] | None = None, urls: list[str] | None = None,
                 viewer: str = "") -> dict[str, Any]:
    """Batch lookup returning velocity summaries keyed by `case_id` and normalized URL for inline badges."""
    sync_from_cases(ctx, limit=80)
    docs = [d for d in ctx.store.list_docs(POSTS, limit=500) if d.get("key")]
    by_case: dict[str, dict[str, Any]] = {}
    by_url: dict[str, dict[str, Any]] = {}
    by_key: dict[str, dict[str, Any]] = {}
    for d in docs:
        s = _summary(d, viewer=viewer)
        by_key[d["key"]] = s
        if d.get("case_id"):
            by_case[str(d["case_id"])] = s
        if d.get("canonical_url"):
            by_url[str(d["canonical_url"]).rstrip("/").lower()] = s

    out_cases: dict[str, dict[str, Any]] = {}
    for cid in (case_ids or [])[:200]:
        if cid in by_case:
            out_cases[cid] = by_case[cid]

    out_urls: dict[str, dict[str, Any]] = {}
    for raw in (urls or [])[:200]:
        u = str(raw or "").strip()
        if not u:
            continue
        norm = u.rstrip("/").lower()
        if norm in by_url:
            out_urls[u] = by_url[norm]
            continue
        try:
            pk = parse_post_input(u, allow_other_platforms=True)["key"]
            if pk in by_key:
                out_urls[u] = by_key[pk]
        except ValueError:
            continue
    return {"by_case": out_cases, "by_url": out_urls}


def refresh_due(ctx: "AgentContext", *, force_all: bool = False, max_posts: int = 16,
                emit_alerts: bool = False, session: Any = None) -> dict[str, Any]:
    """Poll tracked X/Bluesky posts that are due according to their age tier."""
    sync_from_cases(ctx, limit=80)
    now = ctx.now()
    now_ms = int(now.timestamp() * 1000)
    docs = [d for d in ctx.store.list_docs(POSTS, limit=500) if d.get("key") and d.get("live_poll")]
    due: list[dict[str, Any]] = []
    for d in docs:
        tracked_ms: int | None = None
        if (d.get("manual") or d.get("watchers")) and d.get("created_at"):
            try:
                tracked_ms = int(datetime.fromisoformat(str(d["created_at"]).replace("Z", "+00:00")).timestamp() * 1000)
            except ValueError:
                tracked_ms = None
        cadence = _next_interval_min(d.get("published_ms"), now_ms, tracked_ms=tracked_ms)
        if cadence is None and not force_all:
            continue
        if force_all or not d.get("last_polled_at"):
            due.append(d)
            continue
        try:
            last = datetime.fromisoformat(str(d["last_polled_at"]).replace("Z", "+00:00"))
        except ValueError:
            due.append(d)
            continue
        if now - last >= timedelta(minutes=cadence or 30):
            due.append(d)
    # Newest / surging / watched first.
    due.sort(key=lambda d: (bool(d.get("watchers")), d.get("tier") == "surging", d.get("published_ms") or 0), reverse=True)
    polled, ok_count = 0, 0
    for d in due[:max_posts]:
        updated = poll_one(ctx, d, force=force_all, session=session, emit_alerts=emit_alerts)
        polled += 1
        if updated.get("poll_status") == "ok":
            ok_count += 1
    res = {"ok": True, "polled": polled, "succeeded": ok_count, "at": now.isoformat()}
    ctx.store.put_kv(LAST_RUN, res)
    return res


def run_due(ctx: "AgentContext") -> dict[str, Any]:
    """Once-a-minute maintenance entry point. Does nothing while the `velocity_tracking` switch is OFF."""
    if not ctx.flag(SWITCH):
        return {"ok": True, "off": True}
    try:
        return refresh_due(ctx, force_all=False, max_posts=12, emit_alerts=True)
    except Exception as exc:  # noqa: BLE001
        log.warning("velocity run_due failed", exc_info=True)
        return {"ok": False, "error": str(exc)[:300]}


# ---------------------------------------------------------------------------
# Legacy slrr-tooling GCS import (read-only on GCS, idempotent in Console store)
# ---------------------------------------------------------------------------


def import_legacy_payload(ctx: "AgentContext", payload: dict[str, Any], *, dry_run: bool = True, actor: str = "") -> dict[str, Any]:
    """Import tracked posts + snapshots from `slrr-tooling`'s `tracked_posts.json` structure."""
    raw_posts = payload.get("posts") if isinstance(payload, dict) else None
    if isinstance(raw_posts, dict):
        entries = list(raw_posts.values())
    elif isinstance(raw_posts, list):
        entries = raw_posts
    else:
        entries = []
    now_ms = int(ctx.now().timestamp() * 1000)
    added, updated, skipped = [], [], []
    for item in entries:
        if not isinstance(item, dict):
            continue
        url = str(item.get("url") or item.get("postUrl") or item.get("guid") or "").strip()
        if not url:
            skipped.append({"url": "", "reason": "Missing post URL"})
            continue
        try:
            parsed = parse_post_input(url, allow_other_platforms=True)
        except ValueError as exc:
            skipped.append({"url": url[:120], "reason": str(exc)})
            continue
        key = parsed["key"]
        exists = ctx.store.get_doc(POSTS, key) is not None
        label = {"key": key, "url": parsed["canonical_url"], "author": str(item.get("authorHandle") or item.get("author") or parsed["author"])}
        if exists:
            updated.append(label)
        else:
            added.append(label)
        if dry_run:
            continue
        doc = ctx.store.get_doc(POSTS, key) or {
            **parsed,
            "author": str(item.get("authorHandle") or item.get("author") or parsed["author"]).lstrip("@"),
            "author_name": str(item.get("authorName") or item.get("author") or parsed["author"]),
            "followers": _nonneg(item.get("followers")) or None,
            "text": str(item.get("text") or item.get("snippet") or "")[:600],
            "case_id": None,
            "alert_name": str(item.get("alertName") or ""),
            "product": str(item.get("product") or ""),
            "baseline_engagements": _nonneg(item.get("baselineEngagements") or item.get("initialEngagements")),
            "watchers": [],
            "alerted_tier": "",
            "manual": True,
            "created_at": ctx.now().isoformat(),
            "last_polled_at": item.get("lastPolledAt") or None,
            "poll_status": "imported",
            "poll_error": "",
        }
        snap_doc = ctx.store.get_doc(SNAPSHOTS, key) or {"key": key, "points": []}
        pts = list(snap_doc.get("points") or [])
        for s in (item.get("snapshots") or []):
            if isinstance(s, dict) and s.get("ts"):
                pts = coalesce_snapshots(pts, s)
        linked = _find_matching_case(ctx, parsed["canonical_url"], parsed.get("guid") or "")
        if linked and not doc.get("case_id"):
            doc["case_id"] = linked.case_id
            doc["alert_name"] = doc.get("alert_name") or linked.alert_name or ""
            doc["product"] = doc.get("product") or linked.product or ""
        _recompute_doc(doc, pts, now_ms)
        ctx.store.put_doc(SNAPSHOTS, key, {"key": key, "points": pts})
        ctx.store.put_doc(POSTS, key, doc)
    if not dry_run:
        ctx.audit(actor=actor or "admin", action="velocity.import_legacy", surface="console", target_type="velocity",
                  target_id="legacy_gcs", summary=f"Imported legacy velocity tracker posts: {len(added)} added, {len(updated)} updated")
    return {"dry_run": dry_run, "added": added, "updated": updated, "skipped": skipped}


def import_legacy_gcs(ctx: "AgentContext", *, dry_run: bool = True, actor: str = "",
                      bucket: str = LEGACY_BUCKET, object_key: str = LEGACY_KEY) -> dict[str, Any]:
    """Read `tracked_posts.json` from `slrr-tooling`'s GCS bucket (read-only) and preview or apply import."""
    import urllib.parse
    import google.auth
    from google.auth.transport.requests import AuthorizedSession

    creds, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/devstorage.read_only"])
    sess = AuthorizedSession(creds)
    project = ctx.config.platform.gcp.project or "brand-social-central-data"
    url = f"https://storage.googleapis.com/storage/v1/b/{urllib.parse.quote(bucket, safe='')}/o/{urllib.parse.quote(object_key, safe='')}?alt=media"
    resp = sess.get(url, headers={"x-goog-user-project": project}, timeout=20)
    if resp.status_code == 404:
        return {"dry_run": dry_run, "added": [], "updated": [], "skipped": [], "note": "No legacy tracked_posts.json file was found in Cloud Storage."}
    if resp.status_code == 403:
        raise PermissionError(f"The Console service account does not have Storage Object Viewer access on gs://{bucket}/{object_key} yet.")
    if resp.status_code != 200:
        raise RuntimeError(f"Cloud Storage returned HTTP {resp.status_code} reading legacy velocity posts.")
    data = json.loads(resp.text)
    return import_legacy_payload(ctx, data, dry_run=dry_run, actor=actor)
