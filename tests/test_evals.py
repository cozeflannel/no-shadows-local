"""Offline golden-set evals must all match the IM decision (regression guard for the rules)."""

from evals.run_evals import evaluate_case, load_cases


def test_golden_set_offline():
    results = [evaluate_case(c, i, live=False) for i, c in enumerate(load_cases(), start=1)]
    failures = {r["id"]: r["failures"] for r in results if not r["ok"]}
    assert not failures, failures
    assert len(results) >= 20
