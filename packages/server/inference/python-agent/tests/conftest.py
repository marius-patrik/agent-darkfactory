from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def isolated_agents_home(monkeypatch: pytest.MonkeyPatch, tmp_path):
    """Keep every inference test off the personal Agent OS state root."""
    monkeypatch.setenv("ANDROMEDA_HOME", str(tmp_path / ".andromeda"))
