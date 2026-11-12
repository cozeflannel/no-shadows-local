"""Rate-limit bounds of the Brandwatch client (slrr_campaigns/brandwatch.py), offline.

Nothing here touches the network or really sleeps: httpx runs on a MockTransport, the client's
`time` module is a simulated clock, and the Firestore store is an in-memory ledger that applies
the same cooldown rule as CampaignStore. The simulated clock fails the test if the client sleeps
for longer than ten minutes in total, so an unbounded wait shows up as a failure, not a hang.
"""

from __future__ import annotations

from types import SimpleNamespace

import httpx
import pytest

from slrr_campaigns import brandwatch
from slrr_campaigns.brandwatch import BrandwatchApiError, BrandwatchClient


class SimClock:
    """Stands in for the `time` module inside brandwatch.py."""

    def __init__(self, limit_s: float = 600.0) -> None:
        self.now = 1_000.0
        self.slept = 0.0
        self.limit_s = limit_s

    def monotonic(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.now += seconds
        self.slept += seconds
        if self.slept > self.limit_s:
            raise AssertionError(f"the client slept {self.slept:.0f} s in total: the wait is not bounded")


class Ledger:
    """In-memory lease and rate-limit ledger with CampaignStore's method names and cooldown rule."""

    def __init__(
        self, clock: SimClock, *, lease_free: bool = True, slot_waits: tuple[float, ...] = ()
    ) -> None:
        self.clock = clock
        self.lease_free = lease_free
        self.slot_waits = list(slot_waits)
        self.blocked_until = 0.0

    def acquire_lease(self, *_args, **_kwargs) -> bool:
        return self.lease_free

    def release_lease(self, *_args) -> None:
        return None

    def reserve_brandwatch_slot(self) -> float:
        if self.slot_waits:
            return self.slot_waits.pop(0)
        return max(0.0, self.blocked_until - self.clock.now)

    def update_brandwatch_rate_headers(self, *, retry_after_seconds: float = 0.0, **_headers) -> None:
        if retry_after_seconds > 0:
            self.blocked_until = max(self.blocked_until, self.clock.now + retry_after_seconds)


class Tokens:
    def __init__(self) -> None:
        self.refreshed = 0

    def get_token(self) -> str:
        return "token"

    def refresh_on_unauthorized(self) -> None:
        self.refreshed += 1


class Harness:
    def __init__(self, monkeypatch, responses, **ledger_kwargs) -> None:
        """`responses`: one httpx.Response per call; the last one repeats for any further call."""
        self.clock = SimClock()
        self.store = Ledger(self.clock, **ledger_kwargs)
        self.tokens = Tokens()
        self.calls: list[httpx.Request] = []
        script = list(responses)

        def handler(request: httpx.Request) -> httpx.Response:
            self.calls.append(request)
            return script.pop(0) if len(script) > 1 else script[0]

        def client_factory(**kwargs) -> httpx.Client:
            return httpx.Client(transport=httpx.MockTransport(handler), **kwargs)

        http_layer = SimpleNamespace(Client=client_factory, HTTPError=httpx.HTTPError)
        monkeypatch.setattr(brandwatch, "time", self.clock)
        monkeypatch.setattr(brandwatch, "httpx", http_layer)
        self.client = BrandwatchClient(SimpleNamespace(brandwatch_project_ids=[]), self.store, self.tokens)


def too_many(retry_after: str | None = None) -> httpx.Response:
    return httpx.Response(429, headers={"retry-after": retry_after} if retry_after else {}, text="slow down")


def ok(payload: dict) -> httpx.Response:
    return httpx.Response(200, json=payload)


def test_one_rate_limit_window_is_ridden_out(monkeypatch):
    h = Harness(monkeypatch, [too_many(), ok({"id": 7})])
    assert h.client.get_me() == {"id": 7}
    assert len(h.calls) == 2
    assert h.clock.slept == 60.0, "no Retry-After header: one 60 s window, then the retry"


def test_persistent_429_ends_in_the_error_callers_handle(monkeypatch):
    h = Harness(monkeypatch, [too_many()])
    with pytest.raises(BrandwatchApiError) as err:
        h.client.get_me()
    assert err.value.status_code == 429 and err.value.endpoint == "/me"
    assert len(h.calls) == 3, "two 60 s backoffs, then give up on the third 429"
    assert h.clock.slept == 120.0


def test_retry_after_longer_than_the_budget_fails_without_waiting(monkeypatch):
    h = Harness(monkeypatch, [too_many("3600")])
    with pytest.raises(BrandwatchApiError) as err:
        h.client.get_me()
    assert err.value.status_code == 429
    assert len(h.calls) == 1 and h.clock.slept == 0.0
    assert h.store.blocked_until == h.clock.now + 3600, "the cooldown is still recorded for other workers"

    # The next request finds the shared cooldown and stops in the queue: no HTTP call, no waiting.
    with pytest.raises(BrandwatchApiError) as queued:
        h.client.get_client()
    assert queued.value.status_code == 429 and queued.value.endpoint == "/client"
    assert len(h.calls) == 1 and h.clock.slept == 0.0


def test_queue_wait_inside_the_budget_is_still_waited_out(monkeypatch):
    h = Harness(monkeypatch, [ok({"id": 7})], slot_waits=(50.0, 20.0))
    assert h.client.get_me() == {"id": 7}
    assert len(h.calls) == 1
    assert h.clock.slept == 50.0, "waits in 30 s steps and asks the ledger again after each"


def test_queue_lease_that_never_frees_raises(monkeypatch):
    h = Harness(monkeypatch, [ok({"id": 7})], lease_free=False)
    with pytest.raises(BrandwatchApiError) as err:
        h.client.get_me()
    assert err.value.status_code == 429
    assert h.calls == []
    assert h.clock.slept == brandwatch.MAX_RATE_LIMIT_WAIT_S


def test_401_is_still_retried_exactly_once(monkeypatch):
    h = Harness(monkeypatch, [httpx.Response(401, text="expired"), ok({"id": 7})])
    assert h.client.get_me() == {"id": 7}
    assert h.tokens.refreshed == 1 and len(h.calls) == 2 and h.clock.slept == 0.0

    denied = Harness(monkeypatch, [httpx.Response(401, text="expired")])
    with pytest.raises(BrandwatchApiError) as err:
        denied.client.get_me()
    assert err.value.status_code == 401 and len(denied.calls) == 2
