"""The Apps Script Burson QA bot (apps-script-chat-bot/): its Node test suite, Generated.gs freshness, and parsing
parity with the Python engine on the same alerts (the bot's rules are a port of triage_agent/qa)."""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from scripts import build_apps_script
from tests.conftest import GOOD_ALERT, TEST_BSG_ROWS
from tests.test_production_artifacts import BURSON_ALERT_1_P1_AIO, BURSON_ALERT_2_P2_MAPS, BURSON_ALERT_3_P0_PARIS
from triage_agent.brand_safety_groups import apply_brand_safety_groups
from triage_agent.config import load_config
from triage_agent.qa import parser
from triage_agent.qa.record_key import normalize_url

ROOT = Path(__file__).resolve().parents[1]
BOT = ROOT / "apps-script-chat-bot"
NODE = shutil.which("node")
needs_node = pytest.mark.skipif(NODE is None, reason="node is not installed")

# Fields both parsers must read the same way.
PARITY_FIELDS = [
    "priority", "product", "social_network", "exposure_tag", "engagement_level", "total_engagement", "kof", "kof_lists",
    "risk_tags", "issue_name", "issue_status", "author", "followers", "post_url",
]


@needs_node
def test_node_suite_passes():
    result = subprocess.run([NODE, str(BOT / "test" / "run_tests.js")], capture_output=True, text=True, timeout=120)
    assert result.returncode == 0, result.stdout[-4000:] + result.stderr[-2000:]
    assert "FAIL" not in result.stdout


def test_generated_gs_is_up_to_date():
    assert build_apps_script.main(["--check"]) == 0, "run: python -m scripts.build_apps_script"


def _js_fixtures() -> dict[str, str]:
    script = f"process.stdout.write(JSON.stringify(require({json.dumps(str(BOT / 'test' / 'fixtures.js'))})))"
    return json.loads(subprocess.run([NODE, "-e", script], capture_output=True, text=True, check=True).stdout)


@needs_node
def test_parsing_matches_the_python_engine(ctx):
    texts = {
        "aio": BURSON_ALERT_1_P1_AIO, "maps": BURSON_ALERT_2_P2_MAPS, "paris": BURSON_ALERT_3_P0_PARIS,
        "placeholder_template": GOOD_ALERT,
        **{f"js_{k}": v for k, v in _js_fixtures().items()},
    }
    names = list(texts)
    payload = {"texts": [texts[n] for n in names], "bsg_rows": [list(r) for r in TEST_BSG_ROWS]}
    result = subprocess.run([NODE, str(BOT / "test" / "parse_cli.js")], input=json.dumps(payload),
                            capture_output=True, text=True, timeout=60, check=True)
    js = dict(zip(names, json.loads(result.stdout)))
    config = load_config()
    apply_brand_safety_groups(config, TEST_BSG_ROWS)
    for name in names:
        py = parser.parse(config, texts[name]).fields
        assert js[name]["detected"], name
        for field in PARITY_FIELDS:
            assert js[name]["fields"].get(field) == py.get(field), f"{name}.{field}: js={js[name]['fields'].get(field)!r} py={py.get(field)!r}"
        assert js[name]["record_key"] == normalize_url(py.get("post_url")), name

    # Verify escalation & recipient routing parity on real Burson V3 alerts
    from datetime import datetime, timezone
    from triage_agent.qa.pipeline import run_qa
    from triage_agent.routing import plan_recipients
    now = datetime(2026, 10, 12, 12, 0, tzinfo=timezone.utc)
    for name in ("aio", "maps", "paris"):
        py_parsed = parser.parse(config, texts[name])
        py_res = run_qa(ctx, py_parsed, source="burson_chat", received_at=now)
        assessment = py_res.assessment
        py_plan = plan_recipients(config, assessment, text=texts[name])
        assert js[name]["escalated"] == assessment.alertable, name
        assert js[name]["track"] == str(assessment.track), name
        assert js[name]["to"] == py_plan.to, name
        assert js[name]["cc"] == py_plan.cc, name



