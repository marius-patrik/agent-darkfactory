from __future__ import annotations

import re
from enum import StrEnum
from typing import Any

from pydantic import Field, field_validator

from genesis_os.types import FrozenModel

_TOOL_NAME = re.compile(r"^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$")


class ToolKind(StrEnum):
    BUILTIN = "builtin"
    WORKFLOW = "workflow"
    PYTHON = "python"


class Capability(StrEnum):
    EMIT_MESSAGE = "emit.message"
    MEMORY_READ = "memory.read"
    MEMORY_WRITE = "memory.write"
    WORKSPACE_READ = "workspace.read"
    WORKSPACE_WRITE = "workspace.write"
    PROCESS_EXECUTE = "process.execute"
    NETWORK_ACCESS = "network.access"
    SLEEP_REQUEST = "sleep.request"
    EVOLUTION_PROPOSE = "evolution.propose"
    TOOL_INSTALL = "tool.install"
    CODE_EXECUTE = "code.execute"


class ToolSpec(FrozenModel):
    name: str
    version: str = "1.0.0"
    description: str
    input_schema: dict[str, Any] = Field(
        default_factory=lambda: {"type": "object", "additionalProperties": False}
    )
    output_schema: dict[str, Any] = Field(default_factory=lambda: {"type": "object"})
    capabilities: frozenset[Capability] = Field(default_factory=frozenset)
    kind: ToolKind = ToolKind.BUILTIN
    timeout_seconds: float = Field(default=15.0, gt=0.0, le=3600.0)
    deterministic: bool = False
    tags: tuple[str, ...] = ()

    @field_validator("name")
    @classmethod
    def validate_name(cls, value: str) -> str:
        if not _TOOL_NAME.fullmatch(value):
            raise ValueError(
                "tool names must be dot-qualified lowercase identifiers, e.g. memory.search"
            )
        return value


class WorkflowStep(FrozenModel):
    id: str
    tool: str
    arguments: dict[str, Any] = Field(default_factory=dict)
    continue_on_error: bool = False


class WorkflowDefinition(FrozenModel):
    steps: tuple[WorkflowStep, ...]
    output: dict[str, Any] = Field(default_factory=dict)


class DynamicToolManifest(FrozenModel):
    spec: ToolSpec
    workflow: WorkflowDefinition | None = None
    entrypoint: str | None = None
    tests: tuple[dict[str, Any], ...] = ()

    @field_validator("workflow")
    @classmethod
    def workflow_matches_kind(cls, value: WorkflowDefinition | None) -> WorkflowDefinition | None:
        return value
