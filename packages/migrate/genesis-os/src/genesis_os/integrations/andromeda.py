from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from genesis_os.runtime import WakeResult, WakeRuntime
from genesis_os.types import Observation


class AndromedaEvent(BaseModel):
    """Deliberately minimal integration contract; it does not assume Andromeda internals."""

    model_config = ConfigDict(extra="allow")

    type: str
    content: str
    session_id: str | None = None
    source: str = "andromeda"
    metadata: dict[str, Any] = Field(default_factory=dict)


class AndromedaBridge:
    def __init__(self, runtime: WakeRuntime) -> None:
        self.runtime = runtime

    async def accept(self, event: AndromedaEvent) -> WakeResult:
        return await self.runtime.observe(
            Observation(
                source=event.source,
                content=event.content,
                structured={"andromeda_type": event.type, **event.metadata},
            ),
            session_id=event.session_id,
        )
