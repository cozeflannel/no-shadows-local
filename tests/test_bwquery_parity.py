"""The Console's Boolean converter against the temp check app's own, query by query.

tests/parity/bwquery.json holds what the app's converter (tempcheck-app/lib/bwquery.js) makes of a few hundred queries:
how each is read, its plan and report, its SQL condition and parameters, the plan each kind of table is asked, and
which of a hundred posts match. It is written by tests/parity/make_bwquery.js, which runs the app's own code. Here
triage_agent/bwquery.py is asked the same and has to give the same answers.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

import pytest

from triage_agent import bwquery, tempcheck

APP = json.loads((Path(__file__).parent / "parity" / "bwquery.json").read_text(encoding="utf-8"))
STARTED = {"t_from": 0, "t_to": 0, "lim": 0}  # what a table's statement already holds when the condition is written


def sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def matches(plan: dict[str, Any]) -> str:
    return "".join("1" if bwquery.evaluate(plan, post) else "0" for post in APP["posts"])


def name(case: dict[str, Any]) -> str:
    return (case["query"][:60] or "(empty)").replace("\n", " ")


def test_the_columns_and_the_sites_are_the_apps():
    assert set(tempcheck.COLS.values()) == set(APP["cols"].values())
    assert bwquery.SITE_PLATFORM == APP["sitePlatform"] and bwquery.PLATFORM_SITE == APP["platformSite"]
    assert list(bwquery.PLATFORM_SITE) == list(APP["platformSite"]), "the filter form offers them in this order"


@pytest.mark.parametrize("case", APP["queries"], ids=name)
def test_a_query_is_read_as_the_app_reads_it(case: dict[str, Any]):
    warnings: list[str] = []
    read = bwquery.parse(case["query"], warnings)
    assert bwquery.show(read.tree, 400) == case["shown"]
    assert (read.implicit, read.mixed, read.hoisted) == (case["implicit"], case["mixed"], case["hoisted"])
    assert warnings == case["readWarnings"]


@pytest.mark.parametrize("case", APP["queries"], ids=name)
def test_a_query_becomes_the_plan_and_the_report_the_app_gives(case: dict[str, Any]):
    conv = bwquery.convert(case["query"])
    assert (conv.ok, conv.error) == (case["ok"], case["error"])
    assert conv.report == case["report"]
    assert conv.plan == case["plan"]


@pytest.mark.parametrize("case", [c for c in APP["queries"] if c["ok"]], ids=name)
def test_a_plan_is_written_as_the_apps_sql_and_cut_for_a_table_as_the_app_cuts_it(case: dict[str, Any]):
    plan = bwquery.convert(case["query"]).plan
    params: dict[str, Any] = dict(STARTED)
    assert bwquery.to_sql(plan, tempcheck.COLS, params) == case["sql"]
    assert list(params)[:3] == list(STARTED) and {k: v for k, v in params.items() if k not in STARTED} == case["params"]
    assert list(params)[3:] == list(case["params"]), "the parameters are named in the order the app names them"
    assert sha(bwquery.to_sql(plan, tempcheck.COLS, {})) == case["sqlAloneSha"]
    assert sorted(bwquery.fields_of(plan)) == sorted(case["fields"])
    for has, theirs in zip(APP["has"], case["pruned"]):
        cut, removed = bwquery.prune(plan, set(has))
        assert removed == theirs["removed"], f"columns {has}"
        assert cut == (plan if theirs["plan"] == "same" else theirs["plan"]), f"columns {has}"


@pytest.mark.parametrize("case", [c for c in APP["queries"] if c["ok"]], ids=name)
def test_a_plan_matches_the_posts_the_apps_plan_matches(case: dict[str, Any]):
    mine, theirs = matches(bwquery.convert(case["query"]).plan), case["matches"]
    wrong = [APP["posts"][i] for i in range(len(theirs)) if mine[i] != theirs[i]]
    assert not wrong, f"{len(wrong)} posts answered differently, the first: {wrong[0]}"


def written(recipe: dict[str, Any]) -> str:
    """A long query from its recipe, as make_bwquery.js writes it."""
    words = lambda stem, n: " OR ".join(f"{stem}{i}" for i in range(n))  # noqa: E731
    return f"({words(*recipe['left'])}) NEAR/{recipe['near']} ({words(*recipe['right'])})" if recipe.get("near") else words(*recipe["left"])


@pytest.mark.parametrize("case", APP["long"], ids=lambda c: c["recipe"]["name"])
def test_a_long_query_is_handled_as_the_app_handles_it(case: dict[str, Any]):
    conv = bwquery.convert(written(case["recipe"]))
    assert (conv.ok, conv.error) == (case["ok"], case["error"])
    assert (conv.report["summary"], conv.report["notes"], conv.report["warnings"]) == (case["summary"], case["notes"], case["warnings"])
    if not case["ok"]:
        return
    assert (conv.plan["k"], len(conv.plan.get("kids") or [])) == (case["planKind"], case["planKids"])
    params: dict[str, Any] = dict(STARTED)
    sql = bwquery.to_sql(conv.plan, tempcheck.COLS, params)
    asked = {k: v for k, v in params.items() if k not in STARTED}
    assert (len(sql), sha(sql)) == (case["sqlLength"], case["sqlSha"])
    assert sha(json.dumps(asked, separators=(",", ":"), ensure_ascii=False)) == case["paramsSha"]
    assert matches(conv.plan) == case["matches"]


@pytest.mark.parametrize("case", APP["filters"], ids=lambda c: json.dumps(c["filters"])[:60])
def test_the_filter_form_is_written_as_the_query_the_app_writes(case: dict[str, Any]):
    form = dict(case["filters"] or {})
    if "minFollowers" in form:  # the Console's form names this field min_followers
        form["min_followers"] = form.pop("minFollowers")
    assert bwquery.from_filters(form if case["filters"] is not None else None) == case["query"]


def test_a_pattern_the_converter_writes_never_matches_differently_at_the_end_of_a_line():
    """Python's `$` also matches before a last line break and JavaScript's does not: the app's answer is the one kept."""
    plan = bwquery.convert("author:someone").plan
    assert bwquery.evaluate(plan, {"author": "@someone"}) and not bwquery.evaluate(plan, {"author": "@someone\n"})
