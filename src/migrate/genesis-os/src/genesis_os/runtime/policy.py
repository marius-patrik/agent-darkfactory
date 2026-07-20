from __future__ import annotations

from typing import Protocol

from genesis_os.types import ToolCall


class ActionPolicy(Protocol):
    @property
    def self_state(self) -> dict[str, object]: ...

    def generate_tool_call(
        self,
        prompt: str,
        *,
        session_id: str,
        max_new_tokens: int,
        temperature: float,
        top_p: float,
        tool_specs: list[dict[str, object]] | None = None,
    ) -> tuple[ToolCall, str]: ...
