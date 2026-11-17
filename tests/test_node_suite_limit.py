"""The Python test that runs the whole Node suite waits up to 900 seconds (the suite takes five to six minutes on a
busy shared machine, so 600 left too little room)."""

from __future__ import annotations

from tests import test_apps_script_bot


def test_the_node_suite_may_take_up_to_900_seconds():
    assert test_apps_script_bot.NODE_SUITE_TIMEOUT == 900
