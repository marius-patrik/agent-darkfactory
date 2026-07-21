"""Canonical runtime-state path tests for the gateway."""

from __future__ import annotations

import os
import stat

from llm_gateway.trace import TraceLogger


def test_default_trace_state_is_below_agents_home(monkeypatch, tmp_path):
    ANDROMEDA_HOME = tmp_path / ".agents"
    monkeypatch.setenv("ANDROMEDA_HOME", str(ANDROMEDA_HOME))
    tracer = TraceLogger()
    try:
        assert tracer.trace_dir == ANDROMEDA_HOME / "runtime" / "gateway" / "traces"
        if os.name != "nt":
            trace_file = next(tracer.trace_dir.glob("gateway-*.jsonl"))
            assert stat.S_IMODE(tracer.trace_dir.stat().st_mode) == 0o700
            assert stat.S_IMODE(trace_file.stat().st_mode) == 0o600
    finally:
        tracer.close()
