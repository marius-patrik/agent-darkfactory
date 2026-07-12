"""Canonical Agent OS state paths used by the gateway."""

from __future__ import annotations

import os
from pathlib import Path


class AgentStateError(RuntimeError):
    pass


def require_agents_home() -> Path:
    raw = os.environ.get("AGENTS_HOME", "").strip()
    if not raw:
        raise AgentStateError("AGENTS_HOME is required")
    root = Path(raw)
    if not root.is_absolute():
        raise AgentStateError("AGENTS_HOME must be an absolute path")
    return root


def gateway_runtime_dir() -> Path:
    return require_agents_home() / "runtime" / "gateway"
