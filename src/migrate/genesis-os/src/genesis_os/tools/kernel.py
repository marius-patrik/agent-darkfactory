from __future__ import annotations

import asyncio
import time

from jsonschema import Draft202012Validator

from genesis_os.tools.context import ToolContext
from genesis_os.tools.policy import ToolPolicy
from genesis_os.tools.registry import ToolRegistry
from genesis_os.types import Actor, EventDraft, EventKind, ToolCall, ToolResult


class ToolKernel:
    """The only execution path for organism actions."""

    def __init__(self, registry: ToolRegistry, policy: ToolPolicy) -> None:
        self.registry = registry
        self.policy = policy

    async def invoke(self, context: ToolContext, call: ToolCall) -> ToolResult:
        started = time.perf_counter()
        call_event = context.ledger.append(
            EventDraft(
                kind=EventKind.TOOL_CALL,
                actor=Actor.ORGANISM,
                payload=call.model_dump(mode="json"),
                session_id=context.session_id,
                correlation_id=call.id,
                importance=0.65,
                source="tool_kernel",
            )
        )
        try:
            tool = self.registry.get(call.tool)
            self.policy.check(tool.spec)
            Draft202012Validator(tool.spec.input_schema).validate(call.arguments)
            if call.tool in context.call_stack:
                raise RecursionError(f"Recursive tool cycle detected: {call.tool}")
            context.call_stack.append(call.tool)
            context.services["tool_kernel"] = self
            try:
                output = await asyncio.wait_for(
                    tool.invoke(context, call.arguments), timeout=tool.spec.timeout_seconds
                )
            finally:
                context.call_stack.pop()
            if not isinstance(output, dict):
                raise TypeError(
                    f"Tool {call.tool} returned {type(output).__name__}; expected object"
                )
            Draft202012Validator(tool.spec.output_schema).validate(output)
            result = ToolResult(
                call_id=call.id,
                tool=call.tool,
                ok=True,
                output=output,
                duration_ms=(time.perf_counter() - started) * 1000,
            )
        except Exception as error:
            result = ToolResult(
                call_id=call.id,
                tool=call.tool,
                ok=False,
                error=f"{type(error).__name__}: {error}",
                duration_ms=(time.perf_counter() - started) * 1000,
            )
        context.ledger.append(
            EventDraft(
                kind=EventKind.TOOL_RESULT,
                actor=Actor.TOOL,
                payload=result.model_dump(mode="json"),
                session_id=context.session_id,
                causation_id=call_event.id,
                correlation_id=call.id,
                importance=0.65 if result.ok else 0.9,
                source="tool_kernel",
            )
        )
        return result
