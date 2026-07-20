from __future__ import annotations

import asyncio

from genesis_os.config import RuntimeSettings
from genesis_os.runtime.wake import WakeRuntime
from genesis_os.types import ToolCall


class UnusedPolicy:
    def __init__(self) -> None:
        self.self_state = {"mode": "test"}

    def generate_tool_call(self, *args, **kwargs):  # pragma: no cover - direct tool tests only
        raise AssertionError("model policy should not be called")


def test_dynamic_workflow_tool_is_installed_and_audited(tmp_path):
    runtime = WakeRuntime(workspace=tmp_path, policy=UnusedPolicy())
    created = asyncio.run(
        runtime.invoke_tool(
            ToolCall(
                tool="tool.create_workflow",
                arguments={
                    "name": "notes.write_and_read",
                    "description": "Write and read a note.",
                    "input_schema": {
                        "type": "object",
                        "properties": {
                            "path": {"type": "string"},
                            "content": {"type": "string"},
                        },
                        "required": ["path", "content"],
                        "additionalProperties": False,
                    },
                    "steps": [
                        {
                            "id": "write",
                            "tool": "workspace.write",
                            "arguments": {
                                "path": "${input.path}",
                                "content": "${input.content}",
                            },
                        },
                        {
                            "id": "read",
                            "tool": "workspace.read",
                            "arguments": {"path": "${input.path}"},
                        },
                    ],
                    "output": {"content": "${steps.read.output.content}"},
                },
            )
        )
    )
    assert created.ok, created.error
    result = asyncio.run(
        runtime.invoke_tool(
            ToolCall(
                tool="notes.write_and_read",
                arguments={"path": "notes/a.txt", "content": "hello"},
            )
        )
    )
    assert result.ok, result.error
    assert result.output == {"content": "hello"}
    assert runtime.ledger.verify()[0]
    assert runtime.ledger.latest_sequence() >= 8  # create + workflow + two nested calls


def test_python_tool_requires_explicit_policy_and_passes_disposable_tests(tmp_path):
    denied = WakeRuntime(workspace=tmp_path / "denied", policy=UnusedPolicy())
    call = ToolCall(
        tool="tool.create_python",
        arguments={
            "name": "math.add",
            "description": "Add two integers.",
            "input_schema": {
                "type": "object",
                "properties": {"a": {"type": "integer"}, "b": {"type": "integer"}},
                "required": ["a", "b"],
                "additionalProperties": False,
            },
            "source": "def run(arguments, context):\n    return {'sum': arguments['a'] + arguments['b']}\n",
            "tests": [{"input": {"a": 2, "b": 3}, "expected": {"sum": 5}}],
        },
    )
    denied_result = asyncio.run(denied.invoke_tool(call))
    assert not denied_result.ok
    assert "not granted" in (denied_result.error or "")

    allowed = WakeRuntime(
        workspace=tmp_path / "allowed",
        policy=UnusedPolicy(),
        settings=RuntimeSettings(allow_python_tools=True),
    )
    created = asyncio.run(allowed.invoke_tool(call))
    assert created.ok, created.error
    result = asyncio.run(
        allowed.invoke_tool(ToolCall(tool="math.add", arguments={"a": 7, "b": 11}))
    )
    assert result.ok, result.error
    assert result.output == {"sum": 18}
