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
    # Rommie extension: explicit cloud opt-in. Defaults to False — the
    # never-meter guard (router.resolve_model) rejects cloud models unless a
    # request opts in. In VS1 no cloud model is reachable (all disabled).
    allow_cloud: bool = Field(default=False, description="Allow routing to cloud models")
    task_class: str | None = Field(default=None, description="Optional task class for route accounting")


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
    agentos_gateway: dict[str, Any] | None = None


class ModelInfo(BaseModel):
    id: str
    object: str = "model"
    created: int = 0
    owned_by: str = "rommie"


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
    details: dict[str, bool] = {}


class RoleSelectRequest(BaseModel):
    role: Literal["general", "coding", "conversation", "judge", "embedding"]
    model_id: str


class RoleSelectResponse(BaseModel):
    role: str
    model_id: str
    previous_model_id: str | None


# --- Switcher surface (design §06; REST over the registry — VS1) -------------
# The two-axis switcher (host + fabric/provider/model). VS1 exposes a REST form
# over the registry; the Connect/protobuf SwitcherService (proto/rommie/v1/
# switchers.proto) is the VS2 alignment — see docs/gateway.md.

SwitcherAxis = Literal["host", "fabric", "provider", "model"]


class SwitcherOption(BaseModel):
    value: str
    label: str = ""
    available: bool = True
    unavailable_reason: str | None = None


class SwitcherOptionsResponse(BaseModel):
    axis: SwitcherAxis
    options: list[SwitcherOption]


class SwitcherStateResponse(BaseModel):
    # The fully-resolved selection. VS1 resolves the global default only
    # (session/project scope is VS2). ``scope_source`` records which layer
    # supplied the value (always "global" in VS1).
    host: str | None = None
    fabric: str | None = None
    provider: str | None = None
    model: str | None = None
    scope_source: str = "global"


class SwitcherSetRequest(BaseModel):
    value: str


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


class RouteResolveRequest(BaseModel):
    task_class: str = Field(description="Task class, for example mechanical or standard-impl")
    allow_cloud: bool = Field(default=False, description="Allow enabled cloud candidates")


class RouteCandidateInfo(BaseModel):
    provider: str
    model_id: str
    available: bool
    unavailable_reason: str | None = None
    params: dict[str, Any] = Field(default_factory=dict)


class RouteResolveResponse(BaseModel):
    task_class: str
    provider: str
    model_id: str
    model: str
    params: dict[str, Any]
    fallback_model_ids: list[str]
    budget_cap_tokens: int | None = None
    budget_cap_cost_usd: float | None = None
    candidates: list[RouteCandidateInfo]
