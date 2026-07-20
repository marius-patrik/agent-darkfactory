from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any, Protocol

from genesis_os.tools.context import ToolContext
from genesis_os.tools.spec import ToolSpec


class Tool(Protocol):
    spec: ToolSpec

    async def invoke(self, context: ToolContext, arguments: dict[str, Any]) -> dict[str, Any]: ...


@dataclass(slots=True)
class CallableTool:
    spec: ToolSpec
    handler: Callable[[ToolContext, dict[str, Any]], Awaitable[dict[str, Any]]]

    async def invoke(self, context: ToolContext, arguments: dict[str, Any]) -> dict[str, Any]:
        return await self.handler(context, arguments)
