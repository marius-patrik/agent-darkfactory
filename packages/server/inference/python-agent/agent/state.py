"""Canonical Agent OS paths for the inference runtime."""

from __future__ import annotations

import os
from pathlib import Path


class AgentStateError(RuntimeError):
    pass


def require_agents_home() -> Path:
    raw = os.environ.get("ANDROMEDA_HOME", "").strip()
    if not raw:
        raise AgentStateError("ANDROMEDA_HOME is required")
    root = Path(raw)
    if not root.is_absolute():
        raise AgentStateError("ANDROMEDA_HOME must be an absolute path")
    return root


def inference_runtime_dir() -> Path:
    return require_agents_home() / "runtime" / "inference"


def inference_runs_dir() -> Path:
    """Return private worker-run storage outside canonical harness sessions."""
    return inference_runtime_dir() / "runs"


def redaction_secrets_dir() -> Path:
    return require_agents_home() / "secrets"


def ensure_private_dir(path: Path) -> Path:
    """Create a runtime directory and enforce private modes below ANDROMEDA_HOME."""
    root = require_agents_home()
    try:
        relative = path.relative_to(root)
    except ValueError as exc:
        raise AgentStateError(f"state path must be below ANDROMEDA_HOME: {path}") from exc
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(root, 0o700)
    current = root
    for part in relative.parts:
        current = current / part
        if current.exists():
            os.chmod(current, 0o700)
    return path
