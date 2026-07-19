from __future__ import annotations

from datetime import UTC, datetime
from enum import StrEnum
from typing import Any
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field


def utc_now() -> datetime:
    return datetime.now(UTC)


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid4().hex}"


class FrozenModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class EventKind(StrEnum):
    OBSERVATION = "observation"
    TOOL_CALL = "tool_call"
    TOOL_RESULT = "tool_result"
    MESSAGE = "message"
    MEMORY = "memory"
    STATE = "state"
    SLEEP_REQUEST = "sleep_request"
    SLEEP_STARTED = "sleep_started"
    SLEEP_COMPLETED = "sleep_completed"
    TRAINING = "training"
    EVALUATION = "evaluation"
    PROMOTION = "promotion"
    BIRTH = "birth"
    EVOLUTION = "evolution"
    ERROR = "error"


class Actor(StrEnum):
    USER = "user"
    ORGANISM = "organism"
    TOOL = "tool"
    HARNESS = "harness"
    ENVIRONMENT = "environment"


class EventDraft(FrozenModel):
    kind: EventKind
    actor: Actor
    payload: dict[str, Any] = Field(default_factory=dict)
    session_id: str
    causation_id: str | None = None
    correlation_id: str | None = None
    importance: float = Field(default=0.5, ge=0.0, le=1.0)
    source: str | None = None


class Event(FrozenModel):
    id: str
    sequence: int
    timestamp: datetime
    kind: EventKind
    actor: Actor
    payload: dict[str, Any]
    session_id: str
    causation_id: str | None
    correlation_id: str | None
    importance: float
    source: str | None
    previous_hash: str
    event_hash: str


class ToolCall(FrozenModel):
    id: str = Field(default_factory=lambda: new_id("call"))
    tool: str
    arguments: dict[str, Any] = Field(default_factory=dict)


class ToolResult(FrozenModel):
    call_id: str
    tool: str
    ok: bool
    output: dict[str, Any] = Field(default_factory=dict)
    error: str | None = None
    duration_ms: float = 0.0


class Observation(FrozenModel):
    source: str
    content: str
    structured: dict[str, Any] = Field(default_factory=dict)
    timestamp: datetime = Field(default_factory=utc_now)


class Message(FrozenModel):
    role: str
    content: str
    timestamp: datetime = Field(default_factory=utc_now)


class TrainingExample(FrozenModel):
    id: str = Field(default_factory=lambda: new_id("example"))
    prompt: str
    target: str
    task: str
    provenance: dict[str, Any] = Field(default_factory=dict)
    weight: float = Field(default=1.0, gt=0.0)
    next_context: str | None = None
    outcome: float | None = None


class EvaluationResult(FrozenModel):
    suite: str
    metrics: dict[str, float]
    passed: bool
    failures: list[str] = Field(default_factory=list)
    details: dict[str, Any] = Field(default_factory=dict)


class CheckpointRef(FrozenModel):
    lineage_id: str
    release_id: str
    path: str
    model_hash: str
    genome_hash: str
    parent_release_id: str | None = None


class BirthCertificate(FrozenModel):
    birth_id: str
    lineage_id: str
    release: CheckpointRef
    started_at: datetime
    completed_at: datetime
    spec_hash: str
    curriculum_hash: str
    seed: int
    metrics: dict[str, float]
    provenance: dict[str, Any] = Field(default_factory=dict)
