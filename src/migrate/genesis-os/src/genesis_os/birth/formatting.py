from __future__ import annotations

import json
from datetime import UTC, datetime

from genesis_os.model.prompts import render_prompt
from genesis_os.types import Event, Observation

# Birth curricula use the same action surface as Wake. Keeping this catalog explicit
# prevents nursery examples from teaching hidden actions that do not exist at runtime.
_CORE_TOOLS: tuple[dict[str, object], ...] = (
    {
        "name": "communication.respond",
        "description": "Deliver a message to the user or environment.",
        "input_schema": {
            "type": "object",
            "properties": {"text": {"type": "string", "minLength": 1}},
            "required": ["text"],
            "additionalProperties": False,
        },
    },
    {
        "name": "runtime.yield",
        "description": "End the current wake turn.",
        "input_schema": {
            "type": "object",
            "properties": {"reason": {"type": "string"}},
            "additionalProperties": False,
        },
    },
    {
        "name": "memory.append",
        "description": "Append an explicit autobiographical memory.",
        "input_schema": {
            "type": "object",
            "properties": {
                "content": {"type": "string", "minLength": 1},
                "tags": {"type": "array", "items": {"type": "string"}},
                "importance": {"type": "number", "minimum": 0, "maximum": 1},
                "confidence": {"type": "number", "minimum": 0, "maximum": 1},
            },
            "required": ["content"],
            "additionalProperties": False,
        },
    },
    {
        "name": "memory.search",
        "description": "Search exact autobiographical memory.",
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "minLength": 1},
                "limit": {"type": "integer", "minimum": 1, "maximum": 100},
            },
            "required": ["query"],
            "additionalProperties": False,
        },
    },
    {
        "name": "sleep.request",
        "description": "Request a separately evaluated Sleep transaction.",
        "input_schema": {
            "type": "object",
            "properties": {"reason": {"type": "string"}},
            "additionalProperties": False,
        },
    },
    {
        "name": "tool.list",
        "description": "List installed tools.",
        "input_schema": {"type": "object", "additionalProperties": False},
    },
    {
        "name": "workspace.read",
        "description": "Read a workspace file.",
        "input_schema": {
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": ["path"],
            "additionalProperties": False,
        },
    },
    {
        "name": "workspace.write",
        "description": "Write a workspace file.",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "content": {"type": "string"},
                "append": {"type": "boolean"},
            },
            "required": ["path", "content"],
            "additionalProperties": False,
        },
    },
    {
        "name": "tool.create_workflow",
        "description": "Create a dynamic workflow tool from installed tools.",
        "input_schema": {
            "type": "object",
            "properties": {
                "name": {"type": "string"},
                "description": {"type": "string"},
                "input_schema": {"type": "object"},
                "steps": {"type": "array", "minItems": 1, "items": {"type": "object"}},
            },
            "required": ["name", "description", "input_schema", "steps"],
            "additionalProperties": False,
        },
    },
    {
        "name": "cognition.record",
        "description": "Record a structured transient thought or decomposition in working state.",
        "input_schema": {
            "type": "object",
            "properties": {
                "kind": {
                    "enum": [
                        "note",
                        "goal",
                        "subproblem",
                        "hypothesis",
                        "prediction",
                        "uncertainty",
                        "critique",
                    ]
                },
                "content": {"type": "string", "minLength": 1},
                "confidence": {"type": "number", "minimum": 0, "maximum": 1},
            },
            "required": ["content"],
            "additionalProperties": False,
        },
    },
    {
        "name": "reality.simulate",
        "description": "Sample action-conditional futures from the learned reality model.",
        "input_schema": {
            "type": "object",
            "properties": {
                "state": {"type": "string"},
                "interventions": {
                    "type": "array",
                    "minItems": 1,
                    "items": {"type": "string"},
                },
                "horizon": {"type": "integer", "minimum": 1, "maximum": 256},
                "samples": {"type": "integer", "minimum": 1, "maximum": 1024},
                "seed": {"type": "integer"},
            },
            "required": ["state", "interventions"],
            "additionalProperties": False,
        },
    },
)

CORE_TOOL_CATALOG = "\n".join(
    json.dumps(value, separators=(",", ":"), sort_keys=True) for value in _CORE_TOOLS
)

_NURSERY_TIMESTAMP = datetime(2025, 1, 1, tzinfo=UTC)


def action(tool: str, arguments: dict[str, object]) -> str:
    """Serialize the only legal organism action envelope used by Birth and Sleep."""
    return json.dumps({"tool": tool, "arguments": arguments}, separators=(",", ":"))


def prompt_for(
    content: str,
    *,
    memories: list[Event] | None = None,
    structured: dict[str, object] | None = None,
    source: str = "nursery",
) -> str:
    return render_prompt(
        tool_catalog=CORE_TOOL_CATALOG,
        observation=Observation(
            source=source,
            content=content,
            structured=structured or {},
            timestamp=_NURSERY_TIMESTAMP,
        ),
        memories=memories or [],
    )
