"""FastAPI gateway application (VS1-minimal).

Routes:
- ``/v1/chat/completions``  OpenAI-format chat (stream + tools), local engines.
- ``/v1/models``            OpenAI-format model list.
- ``/healthz`` / ``/health`` liveness + backend-probe health report.
- ``/host`` ``/fabric`` ``/provider`` ``/model``  the two-axis switcher surface
  (design §06) as REST over the registry. GET lists options, GET ``/state``
  resolves the selection, POST ``/{value}`` sets an axis. The canonical
  contract is the Connect ``SwitcherService`` (proto/rommie/v1/switchers.proto)
  — VS2 aligns these to that protobuf service + cluster-synced state.
- ``/roles/model``          pin the active model for a role (general/coding/
  conversation/judge/embedding).

VS1 reaches LOCAL engines only; cloud entries are disabled and the never-meter
``allow_cloud`` guard stays enforced in the router.
"""

from __future__ import annotations

import time
import os
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse

from agentos_gateway import __version__
from agentos_gateway.schemas import (
    ChatCompletionRequest,
    ModelListResponse,
    ModelInfo,
    HealthResponse,
    RoleSelectRequest,
    RoleSelectResponse,
    SwitcherStateResponse,
    SwitcherOptionsResponse,
    SwitcherOption,
    RouteResolveRequest,
    RouteResolveResponse,
)
from agentos_gateway.registry import ModelRegistry, ActiveRoleManager
from agentos_gateway.router import Router, RoutingError
from agentos_gateway.task_routing import TaskRouter, TaskRoutingError
from agentos_gateway.oauth import OAuthManager
from agentos_gateway.health import HealthChecker
from agentos_gateway.switchers import SwitcherService
from agentos_gateway.trace import TraceLogger

started_at = time.time()
registry: ModelRegistry
active_roles: ActiveRoleManager
tracer: TraceLogger
router: Router
task_router: TaskRouter
health_checker: HealthChecker
switchers: SwitcherService


@asynccontextmanager
async def lifespan(app: FastAPI):
    global registry, active_roles, tracer, router, task_router, health_checker, switchers
    tracer = TraceLogger()
    registry, active_roles = _load_registry(tracer)
    router = Router(registry, active_roles, tracer, oauth=OAuthManager())
    task_router = TaskRouter(registry, quota=router.quota, tracer=tracer)
    health_checker = HealthChecker(registry, active_roles, started_at)
    switchers = SwitcherService(registry, active_roles)
    yield
    await router.close()
    await health_checker.close()
    for component in (active_roles, registry):
        closer = getattr(component, "close", None)
        if closer is not None:
            closer()
    tracer.close()


app = FastAPI(
    title="Agentos Gateway",
    version=__version__,
    lifespan=lifespan,
)


def _load_registry(trace: TraceLogger) -> tuple[ModelRegistry, ActiveRoleManager]:
    dsn = os.environ.get("GATEWAY_PG_DSN")
    if not dsn:
        return ModelRegistry(), ActiveRoleManager()
    try:
        from agentos_gateway.pg_registry import PgActiveRoleManager, PgModelRegistry

        pg_registry = PgModelRegistry(dsn)
        pg_active = PgActiveRoleManager(dsn, pg_loop=pg_registry._pg)
        trace.log(trace_id="gateway-boot", event_type="registry.pg.enabled", extra={"dsn_set": True})
        return pg_registry, pg_active  # type: ignore[return-value]
    except Exception as exc:
        trace.log(
            trace_id="gateway-boot",
            event_type="registry.pg.fallback",
            error=f"{type(exc).__name__}: {exc}",
            extra={"dsn_set": True},
        )
        return ModelRegistry(), ActiveRoleManager()


@app.exception_handler(RoutingError)
async def routing_error_handler(request: Request, exc: RoutingError):
    return JSONResponse(status_code=400, content={"error": {"message": str(exc), "type": "routing_error"}})


@app.post("/v1/chat/completions")
async def chat_completions(body: ChatCompletionRequest):
    messages = [m.model_dump(exclude_none=True) for m in body.messages]

    try:
        result = await router.chat_completion(
            model_id=body.model,
            messages=messages,
            temperature=body.temperature,
            top_p=body.top_p,
            max_tokens=body.max_tokens,
            stream=body.stream,
            stop=body.stop,
            presence_penalty=body.presence_penalty,
            frequency_penalty=body.frequency_penalty,
            tools=body.tools,
            tool_choice=body.tool_choice,
            allow_cloud=body.allow_cloud,
            task_class=body.task_class,
        )
    except RoutingError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Backend error: {exc}") from exc

    if body.stream:
        import json as _json
        async def event_stream() -> AsyncIterator[str]:
            async for chunk in result:  # type: ignore
                yield f"data: {_json.dumps(chunk)}\n\n"
            yield "data: [DONE]\n\n"

        return StreamingResponse(event_stream(), media_type="text/event-stream")

    # Non-streaming: normalize to our schema if possible, else pass through
    if isinstance(result, dict):
        return result
    return result


@app.get("/v1/models")
async def list_models() -> ModelListResponse:
    models = registry.list_enabled()
    return ModelListResponse(
        data=[ModelInfo(**m.to_openai_dict()) for m in models]
    )


@app.post("/route", response_model=RouteResolveResponse)
async def resolve_route(body: RouteResolveRequest) -> RouteResolveResponse:
    try:
        return RouteResolveResponse(**task_router.resolve(body.task_class, allow_cloud=body.allow_cloud).to_dict())
    except TaskRoutingError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/route/{task_class:path}", response_model=RouteResolveResponse)
async def resolve_route_get(task_class: str, allow_cloud: bool = False) -> RouteResolveResponse:
    try:
        return RouteResolveResponse(**task_router.resolve(task_class, allow_cloud=allow_cloud).to_dict())
    except TaskRoutingError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/healthz")
async def healthz() -> HealthResponse:
    """Liveness + backend-probe health (the canonical health route)."""
    report = await health_checker.check()
    return HealthResponse(**report)


@app.get("/health")
async def health() -> HealthResponse:
    """Alias of /healthz (the salvaged v3 route name, kept for compatibility)."""
    report = await health_checker.check()
    return HealthResponse(**report)


# --- Switcher surface (§06) — REST over the registry -------------------------
# Connect alignment (proto/rommie/v1/switchers.proto SwitcherService) is VS2.

def _options_response(axis: str) -> SwitcherOptionsResponse:
    opts = switchers.list_options(axis)
    return SwitcherOptionsResponse(
        axis=axis,  # type: ignore[arg-type]
        options=[SwitcherOption(**o) for o in opts],
    )


@app.get("/switcher/state")
async def switcher_state() -> SwitcherStateResponse:
    return SwitcherStateResponse(**switchers.get_state())


def _set_axis(axis: str, value: str) -> SwitcherStateResponse:
    try:
        state = switchers.set_axis(axis, value)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return SwitcherStateResponse(**state)


@app.get("/host")
async def list_hosts() -> SwitcherOptionsResponse:
    return _options_response("host")


@app.post("/host/{value}")
async def set_host(value: str) -> SwitcherStateResponse:
    return _set_axis("host", value)


@app.get("/fabric")
async def list_fabrics() -> SwitcherOptionsResponse:
    return _options_response("fabric")


@app.post("/fabric/{value}")
async def set_fabric(value: str) -> SwitcherStateResponse:
    return _set_axis("fabric", value)


@app.get("/provider")
async def list_providers() -> SwitcherOptionsResponse:
    return _options_response("provider")


@app.post("/provider/{value}")
async def set_provider(value: str) -> SwitcherStateResponse:
    return _set_axis("provider", value)


@app.get("/model")
async def list_model_options() -> SwitcherOptionsResponse:
    return _options_response("model")


@app.post("/model/{value}")
async def set_model(value: str) -> SwitcherStateResponse:
    return _set_axis("model", value)


# --- Role-model pinning (the salvaged v3 /model behaviour, kept) -------------
# Distinct from the switcher model axis: this pins the *active model for a role*
# so role-aliased traffic (general/coding/...) resolves to it.

@app.post("/roles/model")
async def select_role_model(body: RoleSelectRequest) -> RoleSelectResponse:
    entry = registry.get(body.model_id)
    if entry is None:
        raise HTTPException(status_code=404, detail=f"Model '{body.model_id}' not found")
    if not entry.enabled:
        raise HTTPException(status_code=400, detail=f"Model '{body.model_id}' is disabled")

    previous = active_roles.set(body.role, body.model_id)
    return RoleSelectResponse(
        role=body.role,
        model_id=body.model_id,
        previous_model_id=previous,
    )


@app.get("/roles/model")
async def get_role_models() -> dict[str, Any]:
    return {
        "active": active_roles.all(),
        "available": {
            role: [m.id for m in registry.list_by_role(role)]
            for role in ("general", "coding", "conversation", "judge", "embedding")
        },
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=4000)
