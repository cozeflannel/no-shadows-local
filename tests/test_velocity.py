"""Tests for native post velocity & 7-day trajectory tracking (`triage_agent/velocity.py` + `/api/velocity`)."""

from __future__ import annotations

from typing import Any

import pytest

from test_console_api import ADMIN, IM, VIEWER, api, console_ctx, seeded  # noqa: F401 - fixtures
from triage_agent import velocity
from triage_agent.events import PlatformEvent


class _Resp:
    def __init__(self, status_code: int, body: dict[str, Any] | None = None):
        self.status_code = status_code
        self._body = body or {}

    def json(self) -> dict[str, Any]:
        return self._body


class _FakeHttp:
    def __init__(self, handler):
        self.handler = handler
        self.urls: list[str] = []

    def get(self, url: str, **kwargs: Any) -> _Resp:
        self.urls.append(url)
        return self.handler(url, kwargs)


def test_snowflake_decode_and_ssrf_safe_parser():
    # Known X Snowflake ID -> deterministic UTC epoch ms >= TWITTER_EPOCH_MS
    ms = velocity.decode_snowflake_ms("1860000000000000000")
    assert ms is not None and ms > velocity.TWITTER_EPOCH_MS

    x = velocity.parse_post_input("https://x.com/Google/status/1860000000000000000?s=20")
    assert x["key"] == "x_1860000000000000000" and x["platform"] == "x" and x["live_poll"] is True
    assert x["author"] == "Google" and x["published_ms"] == ms

    bsky = velocity.parse_post_input("https://bsky.app/profile/alice.bsky.social/post/3lbxyz123")
    assert bsky["platform"] == "bluesky" and bsky["live_poll"] is True and bsky["author"] == "alice.bsky.social"

    # SSRF / disallowed hosts, ports, credentials, schemes are rejected.
    for bad in (
        "http://169.254.169.254/latest/meta-data",
        "https://evil.example.com/Google/status/1860000000000000000",
        "https://user:pass@evil.test/Google/status/1860000000000000000",
        "https://x.com:8443/Google/status/1860000000000000000",
        "file:///etc/passwd",
    ):
        with pytest.raises(ValueError):
            velocity.parse_post_input(bad, allow_other_platforms=True)


def test_coalesce_snapshots_trajectory_and_traction_tiers():
    t0 = 1_700_000_000_000
    pts: list[dict[str, Any]] = []
    # Two readings 5 minutes apart coalesce into one monotonic reading.
    pts = velocity.coalesce_snapshots(pts, {"ts": t0 + 3600_000, "likes": 120, "comments": 30, "shares": 50})
    pts = velocity.coalesce_snapshots(pts, {"ts": t0 + 3600_000 + 300_000, "likes": 150, "comments": 40, "shares": 60})
    assert len(pts) == 1 and pts[0]["engagements"] == 250

    # Add a huge T+3h jump -> surging traction + clear peak hour.
    pts = velocity.coalesce_snapshots(pts, {"ts": t0 + 3 * 3600_000, "likes": 8000, "comments": 1500, "shares": 2500})
    traj = velocity.build_trajectory(t0, pts, now_ms=t0 + 4 * 3600_000)
    assert len(traj["hours"]) == 5  # T+0..T+4
    assert traj["peak_per_hour"] > 4000 and traj["peak_at_hour"] in (2, 3)

    assert velocity.classify_traction(200, 260)["tier"] == "steady"
    assert velocity.classify_traction(500, 1600)["tier"] == "growing"
    assert velocity.classify_traction(400, 12000)["tier"] == "surging"


def test_switch_defaults_off_and_poller_plus_spike_alerts_respect_safety(api, monkeypatch):
    from datetime import timedelta

    # Switch MUST default OFF (AGENTS.md invariant #2).
    assert api.ctx.config.platform.flags.velocity_tracking is False
    assert velocity.run_due(api.ctx) == {"ok": True, "off": True}

    calls = {"likes": 300}
    pid = str(((int(api.ctx.now().timestamp() * 1000) - velocity.TWITTER_EPOCH_MS) << 22) | 1)
    url = f"https://x.com/roadwatcher/status/{pid}"
    fake_http = _FakeHttp(lambda u, kw: _Resp(200, {
        "id_str": pid,
        "text": "Gemini app test post",
        "favorite_count": calls["likes"],
        "conversation_count": 40,
        "retweet_count": 60,
        "user": {"screen_name": "roadwatcher", "name": "Road Watcher", "followers_count": 42000},
    }))
    real_poll_x = velocity.poll_x
    monkeypatch.setattr(velocity, "poll_x", lambda post_id, session=None: real_poll_x(post_id, session=fake_http))

    # Track post via API (analyst on-demand check works even while background switch is OFF).
    res = api.post("/api/velocity/track", {"url": url, "watch": True}, user=IM)
    assert res.status_code == 200
    post = res.json()["post"]
    assert post["key"] == f"x_{pid}"
    assert post["current_engagements"] == 400 and post["watched"] is True and post["tier"] == "steady"

    # Batch lookup returns it by URL.
    looked = api.post("/api/velocity/lookup", {"urls": [url]}, user=VIEWER)
    assert looked.status_code == 200
    assert url in looked.json()["by_url"]

    # Turn velocity_tracking ON, advance clock, jump engagements by +12,000 -> emits velocity.spike + internal DM outbox (never Burson).
    flags = {**api.ctx.config.platform.flags.model_dump(mode="json"), "velocity_tracking": True}
    assert api.put("/api/platform/flags", {"value": flags, "note": "enable velocity"}).status_code == 200
    later = api.ctx.now() + timedelta(hours=2)
    monkeypatch.setattr(api.ctx, "now", lambda: later)
    calls["likes"] = 12_500
    ran = velocity.run_due(api.ctx)
    assert ran["ok"] is True and ran["polled"] >= 1

    detail = api.get(f"/api/velocity/posts/{post['key']}", user=VIEWER).json()
    assert detail["post"]["tier"] == "surging"
    hot = api.ctx.events.query(types=[PlatformEvent.VELOCITY_SPIKE])
    assert len(hot) == 1 and hot[0].payload["post_key"] == post["key"]
    queued = [i for i in api.ctx.store.list_outbox(undelivered_only=True, limit=50) if i.source == "velocity_spike"]
    assert len(queued) == 1 and queued[0].target == "dm" and IM in queued[0].recipients
    assert all(i.target != "burson" for i in queued)


def test_compare_and_legacy_import_endpoints(api):
    p1 = velocity.track_post(api.ctx, url="https://x.com/alice/status/1860000000000000010", actor=IM, poll=False)
    p2 = velocity.track_post(api.ctx, url="https://bsky.app/profile/bob.bsky.social/post/3lbaaa111", actor=IM, poll=False)
    cmp_res = api.get(f"/api/velocity/compare?keys={p1['key']},{p2['key']}&window=48", user=VIEWER)
    assert cmp_res.status_code == 200 and len(cmp_res.json()["series"]) == 2

    legacy = {
        "posts": {
            "1860000000000000099": {
                "url": "https://x.com/reporter/status/1860000000000000099",
                "authorHandle": "reporter",
                "text": "Imported post from slrr-tooling",
                "baselineEngagements": 250,
                "snapshots": [
                    {"ts": 1_730_000_000_000, "likes": 200, "comments": 20, "shares": 30, "engagements": 250},
                    {"ts": 1_730_000_000_000 + 7200_000, "likes": 1400, "comments": 150, "shares": 300, "engagements": 1850},
                ],
            }
        }
    }
    dry = api.post("/api/velocity/import-legacy", {"dry_run": True, "payload": legacy}, user=ADMIN)
    assert dry.status_code == 200 and len(dry.json()["added"]) == 1
    applied = api.post("/api/velocity/import-legacy", {"dry_run": False, "payload": legacy}, user=ADMIN)
    assert applied.status_code == 200 and len(applied.json()["added"]) == 1
    imported = api.get("/api/velocity/posts/x_1860000000000000099", user=VIEWER)
    assert imported.status_code == 200 and imported.json()["post"]["tier"] == "growing"
