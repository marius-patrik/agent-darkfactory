"""Permission gate for worker tool calls."""

from __future__ import annotations

from enum import Enum


class PermissionMode(str, Enum):
    """Canonical ``agent_os.v1.PermissionMode`` names used by the loop."""

    plan = "plan"
    ask = "ask"
    auto_accept_edits = "auto_accept_edits"
    full_auto = "full_auto"


def approve(mode: PermissionMode, tool_name: str, args: dict[str, object]) -> bool:
    """Return True when a tool call is approved.

    Read-only tools remain available in plan mode. Ask mode fails closed until
    an owning harness supplies approval. Auto-accept-edits permits reads and
    file edits, while full-auto permits every registered local tool.
    """
    if mode == PermissionMode.full_auto:
        return True
    if mode == PermissionMode.auto_accept_edits:
        return tool_name in {"read_file", "ls", "write_file", "edit_file"}
    if mode == PermissionMode.plan:
        return tool_name in {"read_file", "ls"}
    return False
