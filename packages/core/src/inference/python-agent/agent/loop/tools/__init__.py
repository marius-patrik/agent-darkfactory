"""Tool registry and OpenAI tool schemas for the inference worker."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from agent.loop.tools.inline import bash, edit_file, ls, read_file, write_file

ToolHandler = Callable[[dict[str, Any]], dict[str, Any]]

TOOLS: dict[str, ToolHandler] = {
    "read_file": read_file,
    "write_file": write_file,
    "edit_file": edit_file,
    "ls": ls,
    "bash": bash,
}


def tool_schemas() -> list[dict[str, Any]]:
    """Return OpenAI function tool schemas."""
    return [
        {
            "type": "function",
            "function": {
                "name": "read_file",
                "description": "Read a UTF-8 file from the host.",
                "parameters": _object({"path": {"type": "string"}}, ["path"]),
            },
        },
        {
            "type": "function",
            "function": {
                "name": "write_file",
                "description": "Write UTF-8 content to a host file.",
                "parameters": _object({"path": {"type": "string"}, "content": {"type": "string"}}, ["path", "content"]),
            },
        },
        {
            "type": "function",
            "function": {
                "name": "edit_file",
                "description": "Replace an exact text span in a host file.",
                "parameters": _object(
                    {"path": {"type": "string"}, "old": {"type": "string"}, "new": {"type": "string"}},
                    ["path", "old", "new"],
                ),
            },
        },
        {
            "type": "function",
            "function": {
                "name": "ls",
                "description": "List directory entries.",
                "parameters": _object({"path": {"type": "string", "default": "."}}, []),
            },
        },
        {
            "type": "function",
            "function": {
                "name": "bash",
                "description": "Run a shell command on the host through bash.",
                "parameters": _object(
                    {"command": {"type": "string"}, "timeout": {"type": "number", "default": 120}},
                    ["command"],
                ),
            },
        },
    ]


def _object(properties: dict[str, Any], required: list[str]) -> dict[str, Any]:
    return {"type": "object", "properties": properties, "required": required, "additionalProperties": False}
