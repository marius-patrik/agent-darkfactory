"""FastAPI model gateway used by Agent OS.

Routes:
- ``/v1/chat/completions``  OpenAI-format chat (stream + tools), local engines.
- ``/v1/models``            OpenAI-format model list.
- ``/health``              liveness + backend-probe health report.

Only the package-owned local inference registry is accepted.
"""

from __future__ import annotations

import time
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse

from llm_gateway import __version__
from llm_gateway.schemas import (
    ChatCompletionRequest,
    ModelListResponse,
    ModelInfo,
    HealthResponse,
    RouteResolveRequest,
    RouteResolveResponse,
)
from llm_gateway.registry import ModelRegistry
from llm_gateway.router import Router, RoutingError
from llm_gateway.task_routing import TaskRouter, TaskRoutingError
from llm_gateway.health import HealthChecker
from llm_gateway.trace import TraceLogger

started_at = time.time()
registry: ModelRegistry
tracer: TraceLogger
router: Router
task_router: TaskRouter
health_checker: HealthChecker


@asynccontextmanager
async def lifespan(app: FastAPI):
    global registry, tracer, router, task_router, health_checker
    tracer = TraceLogger()
    registry = ModelRegistry()
    router = Router(registry, tracer)
    task_router = TaskRouter(registry, quota=router.quota, tracer=tracer)
    health_checker = HealthChecker(registry, started_at)
    yield
    await router.close()
    await health_checker.close()
    tracer.close()


app = FastAPI(
    title="Agent OS Gateway",
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
        return RouteResolveResponse(**task_router.resolve(body.task_class).to_dict())
    except TaskRoutingError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/route/{task_class:path}", response_model=RouteResolveResponse)
async def resolve_route_get(task_class: str) -> RouteResolveResponse:
    try:
        return RouteResolveResponse(**task_router.resolve(task_class).to_dict())
    except TaskRoutingError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/health")
async def health() -> HealthResponse:
    """Liveness and backend-probe health."""
    report = await health_checker.check()
    return HealthResponse(**report)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8787)
