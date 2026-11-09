"""Atomic idempotency claims: an overlapping Studio retry never posts or drafts twice."""

import threading
import time

import pytest

from conftest import GOOD_ALERT, make_message
from triage_agent import idempotency
from triage_agent.operations import handle


@pytest.fixture
def fast_wait(monkeypatch):
    monkeypatch.setattr(idempotency, "WAIT_S", 0.3)
    monkeypatch.setattr(idempotency, "POLL_S", 0.01)


def test_store_claims_are_atomic_and_expire(ctx):
    store = ctx.store
    assert store.claim_idempotent("k1") is True
    assert store.claim_idempotent("k1") is False  # live claim held by another delivery
    store.release_idempotent("k1")
    assert store.claim_idempotent("k1") is True
    assert store.claim_idempotent("k1", ttl_s=0) is True  # a stale claim (crashed attempt) can be taken over


def test_store_claim_is_exclusive_under_threads(ctx):
    wins = []
    barrier = threading.Barrier(8)

    def worker():
        barrier.wait()
        wins.append(ctx.store.claim_idempotent("race"))

    threads = [threading.Thread(target=worker) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert wins.count(True) == 1


def test_overlapping_delivery_is_retried_not_duplicated(ctx, fast_wait):
    msg = make_message(GOOD_ALERT, message_id="burson-overlap")
    ctx.store.claim_idempotent("msg:burson-overlap")  # the first delivery is still running
    resp = handle({"op": "triage_message", "payload": {"message": msg}}, ctx)
    assert resp.ok is False and resp.retryable is True  # Studio retries the step later
    assert ctx.store.list_cases() == []  # nothing was triaged, posted or drafted twice
    ctx.store.release_idempotent("msg:burson-overlap")
    first = handle({"op": "triage_message", "payload": {"message": msg}}, ctx)
    assert first.ok and first.outputs["has_clean"] == "yes"
    again = handle({"op": "triage_message", "payload": {"message": msg}}, ctx)
    assert again.data.get("duplicate") is True and again.outputs["clean_text"] == first.outputs["clean_text"]
    assert len(ctx.store.list_cases()) == 1


def test_waiting_delivery_returns_the_first_answer(ctx, monkeypatch):
    monkeypatch.setattr(idempotency, "WAIT_S", 5.0)
    monkeypatch.setattr(idempotency, "POLL_S", 0.02)
    key = "msg:burson-wait"
    ctx.store.claim_idempotent(key)

    def first_attempt_finishes():
        time.sleep(0.2)
        ctx.store.put_idempotent(key, {"outputs": {"summary": "TRG-9 PASS", "case_id": "TRG-9"}, "data": {"case_id": "TRG-9"}})
        ctx.store.release_idempotent(key)

    threading.Thread(target=first_attempt_finishes).start()
    resp = handle({"op": "triage_message", "payload": {"message": make_message(GOOD_ALERT, message_id="burson-wait")}}, ctx)
    assert resp.ok and resp.outputs["case_id"] == "TRG-9" and resp.data["duplicate"] is True
    assert ctx.store.list_cases() == []


def test_claim_released_after_failures(ctx, fake_llm):
    def boom(call):
        raise RuntimeError("Gemini down")

    fake_llm.on("triage.assess", boom)
    msg = make_message(GOOD_ALERT, message_id="burson-fails")
    handle({"op": "triage_message", "payload": {"message": msg}}, ctx)
    assert ctx.store.claim_idempotent("msg:burson-fails") is True  # not left claimed by the failed attempt
