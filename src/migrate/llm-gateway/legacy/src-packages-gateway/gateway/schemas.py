"""Pydantic schemas for the gateway API."""

from typing import Any, Literal
from pydantic import BaseModel, Field


class ChatMessage(BaseModel):
    role: Literal["system", "user", "assistant", "tool"]
    content: str | None = None
    name: str | None = None
    tool_calls: list[dict[str, Any]] | None = None
    tool_call_id: str | None = None


class ChatCompletionRequest(BaseModel):
    model: str
    messages: list[ChatMessage]
    temperature: float | None = Field(default=0.7, ge=0.0, le=2.0)
    top_p: float | None = Field(default=1.0, ge=0.0, le=1.0)
    max_tokens: int | None = Field(default=None, ge=1)
    stream: bool = False
    stop: str | list[str] | None = None
    presence_penalty: float | None = Field(default=0.0, ge=-2.0, le=2.0)
    frequency_penalty: float | None = Field(default=0.0, ge=-2.0, le=2.0)
    tools: list[dict[str, Any]] | None = None
    tool_choice: str | dict[str, Any] | None = None
    # Agents-platform extension: explicit cloud opt-in
    allow_cloud: bool = Field(default=False, description="Allow routing to cloud models")


class ChatCompletionChoice(BaseModel):
    index: int = 0
    message: ChatMessage
    finish_reason: str | None = "stop"
    logprobs: dict[str, Any] | None = None


class ChatCompletionResponse(BaseModel):
    id: str
    object: str = "chat.completion"
    created: int
    model: str
    choices: list[ChatCompletionChoice]
    usage: dict[str, int] | None = None
    agents_gateway: dict[str, Any] | None = None


class ModelInfo(BaseModel):
    id: str
    object: str = "model"
    created: int = 0
    owned_by: str = "agents"


class ModelListResponse(BaseModel):
    object: str = "list"
    data: list[ModelInfo]


class HealthResponse(BaseModel):
    status: Literal["healthy", "degraded", "unhealthy"]
    version: str
    git_sha: str = ""
    image_tag: str = ""
    build_time: str = ""
    node_id: str = ""
    uptime_seconds: float
    models_registered: int
    models_healthy: int
    roles_configured: int


class RoleSelectRequest(BaseModel):
    role: Literal["general", "coding", "judge", "embedding"]
    model_id: str


class RoleSelectResponse(BaseModel):
    role: str
    model_id: str
    previous_model_id: str | None


class TraceEvent(BaseModel):
    trace_id: str
    timestamp: str
    event_type: str
    model_id: str | None = None
    role: str | None = None
    requested_model: str | None = None
    requested_role: str | None = None
    resolved_model_id: str | None = None
    provider: str | None = None
    backend_type: str | None = None
    backend_api_base: str | None = None
    backend_node_id: str | None = None
    served_model: str | None = None
    resource_class: str | None = None
    allow_cloud: bool | None = None
    cloud: bool | None = None
    response_status: str | None = None
    http_status: int | None = None
    duration_ms: float | None = None
    tokens_in: int | None = None
    tokens_out: int | None = None
    fallback_used: bool = False
    fallback_to: str | None = None
    error: str | None = None
    request_id: str | None = None
