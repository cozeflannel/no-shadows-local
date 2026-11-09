"""Session fixtures wiring real RuntimeDependencies for pytest -m live."""

from __future__ import annotations

import pytest

from slrr_campaigns.service import RuntimeDependencies, build_runtime


@pytest.fixture(scope="session")
def live_runtime() -> RuntimeDependencies:
    """Instantiate live RuntimeDependencies backed by Secret Manager, GCP, Workspace, and Brandwatch."""
    return build_runtime()
