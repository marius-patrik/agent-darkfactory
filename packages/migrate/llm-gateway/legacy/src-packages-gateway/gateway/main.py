"""FastAPI gateway application."""

from __future__ import annotations

import time
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse

from agents.packages.gateway.gateway import __version__
from agents.packages.gateway.gateway.schemas import (
    ChatCompletionRequest,
    ChatCompletionResponse,
    ChatCompletionChoice,
    ChatMessage,
    ModelListResponse,
    ModelInfo,
    HealthResponse,
    RoleSelectRequest,
    RoleSelectResponse,
)
from agents.packages.gateway.gateway.registry import ModelRegistry, ActiveRoleManager
from agents.packages.gateway.gateway.router import Router, RoutingError
from agents.packages.gateway.gateway.health import HealthChecker
from agents.packages.gateway.gateway.trace import TraceLogger

started_at = time.time()
registry: ModelRegistry
active_roles: ActiveRoleManager
tracer: TraceLogger
router: Router
health_checker: HealthChecker


@asynccontextmanager
async def lifespan(app: FastAPI):
    global registry, active_roles, tracer, router, health_checker
    registry = ModelRegistry()
    active_roles = ActiveRoleManager()
    tracer = TraceLogger()
    router = Router(registry, active_roles, tracer)
    health_checker = HealthChecker(registry, active_roles, started_at)
    yield
    await router.close()
    await health_checker.close()
    tracer.close()


app = FastAPI(
    title="Agents LLM Gateway",
    version=__version__,
    lifespan=lifespan,
)


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


@app.get("/health")
async def health() -> HealthResponse:
    report = await health_checker.check()
    return HealthResponse(**report)


@app.post("/model")
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


@app.get("/model")
async def get_role_models() -> dict[str, Any]:
    return {
        "active": active_roles.all(),
        "available": {
            role: [m.id for m in registry.list_by_role(role)]
            for role in ("general", "coding", "judge", "embedding")
        },
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=4000)
