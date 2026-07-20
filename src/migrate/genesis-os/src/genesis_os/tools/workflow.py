from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from genesis_os.tools.context import ToolContext
from genesis_os.tools.spec import ToolSpec, WorkflowDefinition
from genesis_os.types import ToolCall

_TEMPLATE = re.compile(r"^\$\{([^}]+)\}$")


def _lookup(path: str, scope: dict[str, Any]) -> Any:
    current: Any = scope
    for part in path.split("."):
        if isinstance(current, dict) and part in current:
            current = current[part]
        elif isinstance(current, list) and part.isdigit() and int(part) < len(current):
            current = current[int(part)]
        else:
            raise KeyError(f"Workflow template path does not exist: {path}")
    return current


def _resolve(value: Any, scope: dict[str, Any]) -> Any:
    if isinstance(value, str):
        match = _TEMPLATE.fullmatch(value)
        if match:
            return _lookup(match.group(1), scope)
        return value
    if isinstance(value, list):
        return [_resolve(item, scope) for item in value]
    if isinstance(value, dict):
        return {key: _resolve(item, scope) for key, item in value.items()}
    return value


@dataclass(slots=True)
class WorkflowTool:
    spec: ToolSpec
    definition: WorkflowDefinition

    async def invoke(self, context: ToolContext, arguments: dict[str, Any]) -> dict[str, Any]:
        if len(context.call_stack) >= 16:
            raise RecursionError("Maximum nested tool depth exceeded")
        kernel = context.services.get("tool_kernel")
        if kernel is None:
            raise RuntimeError("Workflow tool requires tool_kernel service")
        scope: dict[str, Any] = {"input": arguments, "steps": {}}
        for step in self.definition.steps:
            resolved = _resolve(step.arguments, scope)
            result = await kernel.invoke(context, ToolCall(tool=step.tool, arguments=resolved))
            scope["steps"][step.id] = result.model_dump(mode="json")
            if not result.ok and not step.continue_on_error:
                raise RuntimeError(f"Workflow step {step.id} failed: {result.error}")
        return _resolve(self.definition.output, scope)
