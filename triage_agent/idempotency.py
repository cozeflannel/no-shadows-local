"""Exactly-once handling of Studio deliveries.

Each entry operation (triage_message, record_reaction, converse, ingest_email) caches its response
under an idempotency key, so a repeated delivery replays the first answer. Studio retries a step
that timed out while the first attempt may still be running; the atomic claim makes the retry wait
for that answer instead of posting or drafting a second time.

    cached = ctx.store.get_idempotent(key) or claim_or_wait(ctx, key)
    if cached:
        return replay(cached)
    try:
        ...  # process, then ctx.store.put_idempotent(key, …)
    finally:
        release(ctx, key)
"""

import logging
import time

from .operations import RetryableError

log = logging.getLogger(__name__)

CLAIM_TTL_S = 120  # longer than any single operation; a crashed attempt's claim expires after this
WAIT_S = 20.0  # how long an overlapping delivery waits for the first one's answer
POLL_S = 0.5


def claim_or_wait(ctx, key: str) -> dict | None:
    """None: this call now owns `key` (call release() when done). A dict: the response another
    delivery stored meanwhile. Raises RetryableError if the other delivery is still running after
    WAIT_S (Studio retries the step; by then the answer is cached)."""
    claim = getattr(ctx.store, "claim_idempotent", None)
    if claim is None or claim(key, ttl_s=CLAIM_TTL_S):
        return None
    deadline = time.monotonic() + WAIT_S
    while time.monotonic() < deadline:
        time.sleep(POLL_S)
        cached = ctx.store.get_idempotent(key)
        if cached:
            return cached
        if claim(key, ttl_s=CLAIM_TTL_S):  # the other attempt ended without caching (e.g. a retryable failure)
            return None
    raise RetryableError("An earlier delivery of this message is still being processed; retrying.")


def release(ctx, key: str) -> None:
    rel = getattr(ctx.store, "release_idempotent", None)
    if rel is None:
        return
    try:
        rel(key)
    except Exception as exc:  # noqa: BLE001 - the claim expires on its own
        log.warning("could not release idempotency claim %s: %s", key, exc)
