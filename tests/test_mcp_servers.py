"""Automated stdio protocol and V8 tool regression test for custom SLRR MCP servers (`mcp/`)."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
NODE = shutil.which("node")


@pytest.mark.skipif(NODE is None, reason="node is not installed")
def test_custom_mcp_servers_stdio_suite():
    result = subprocess.run(
        [NODE, str(ROOT / "mcp" / "test_mcp_servers.js")],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert result.returncode == 0, result.stdout + "\n" + result.stderr
    assert "slrr-dev-pipeline passed" in result.stdout
    assert "slrr-live-ops passed" in result.stdout
