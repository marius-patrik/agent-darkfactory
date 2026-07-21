from __future__ import annotations

from pathlib import Path

import pytest

from agent.loop.session import SessionConfig
from agent.redaction import Redactor
from agent.state import AgentStateError, inference_runs_dir, inference_runtime_dir, require_agents_home


def test_agents_home_is_required_and_absolute(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("ANDROMEDA_HOME", raising=False)
    with pytest.raises(AgentStateError, match="required"):
        require_agents_home()
    monkeypatch.setenv("ANDROMEDA_HOME", "relative/state")
    with pytest.raises(AgentStateError, match="absolute"):
        require_agents_home()


def test_default_inference_state_stays_below_agents_home(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    ANDROMEDA_HOME = tmp_path / ".agents"
    monkeypatch.setenv("ANDROMEDA_HOME", str(ANDROMEDA_HOME))

    SessionConfig(
        session_id="state-test",
        agent_id="agent-os-worker",
        goal="goal",
        task="task",
        acceptance_type="generic",
    )
    assert inference_runs_dir() == ANDROMEDA_HOME / "runtime" / "inference" / "runs"
    assert inference_runtime_dir() == ANDROMEDA_HOME / "runtime" / "inference"

    secrets = ANDROMEDA_HOME / "secrets"
    secrets.mkdir(parents=True)
    (secrets / "test.secret").write_text("secret-value", encoding="utf-8")
    redactor = Redactor.from_secrets_dir()
    assert "secret-value" not in redactor.redact("secret-value")
