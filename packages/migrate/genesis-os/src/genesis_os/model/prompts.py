from __future__ import annotations

import json
from typing import Any

from genesis_os.types import Event, Observation, ToolResult

SYSTEM = """You are a persistent Genesis organism operating through a tool-native AI operating system.
Every external action, message, memory operation, file operation, process, sleep request, or evolution proposal MUST be expressed as exactly one tool call.
Never emit ordinary prose outside the tool call. Emit one compact JSON object with this exact shape:
{"tool":"qualified.tool_name","arguments":{...}}
Use memory.search before making a precise autobiographical claim when the supplied memories are insufficient. Use runtime.yield when no further action is required. Durable weights never change during Wake; sleep.request only asks the harness to begin a separately evaluated Sleep transaction."""


def render_memories(events: list[Event]) -> str:
    if not events:
        return "[]"
    values = [
        {
            "event_id": event.id,
            "sequence": event.sequence,
            "timestamp": event.timestamp.isoformat(),
            "kind": event.kind.value,
            "actor": event.actor.value,
            "payload": event.payload,
            "source": event.source,
        }
        for event in events
    ]
    return json.dumps(values, ensure_ascii=False, separators=(",", ":"))


def render_prompt(
    *,
    tool_catalog: str,
    observation: Observation,
    memories: list[Event],
    prior_result: ToolResult | None = None,
    self_state: dict[str, Any] | None = None,
) -> str:
    result = "null" if prior_result is None else prior_result.model_dump_json()
    state = json.dumps(self_state or {}, ensure_ascii=False, separators=(",", ":"))
    observation_json = observation.model_dump_json()
    return (
        f"SYSTEM:\n{SYSTEM}\n"
        f"TOOLS:\n{tool_catalog}\n"
        f"SELF_STATE:\n{state}\n"
        f"RELEVANT_MEMORY:\n{render_memories(memories)}\n"
        f"OBSERVATION:\n{observation_json}\n"
        f"PREVIOUS_TOOL_RESULT:\n{result}\n"
        "ACTION:\n"
    )
