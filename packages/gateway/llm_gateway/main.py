"""FastAPI model gateway used by Agent OS.

Routes:
- ``/v1/chat/completions``  OpenAI-format chat (stream + tools), local engines.
- ``/v1/models``            OpenAI-format model list.
- ``/health``              liveness + backend-probe health report.

Only the package-owned local inference registry is accepted.
"""

from __future__ import annotations

import os
import re
import time
import uuid
from contextlib import asynccontextmanager
from typing import AsyncIterator, cast

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, StreamingResponse
from protobuf import Oneof
from connectrpc.errors import ConnectError

from agent_os.v1.common_pb import RunStatus, SwitcherScope
from agent_os.v1.health_connect import HealthServiceASGIApplication
from agent_os.v1.registry_connect import RegistryServiceASGIApplication
from agent_os.v1.session_frames_pb import Attach, ClientFrame, ServerFrame, SessionEvent, SessionEventKind, Status, Switch, SwitchState, UserInput
from agent_os.v1.sessions_connect import SessionServiceASGIApplication
from agent_os.v1.switchers_connect import SwitcherServiceASGIApplication

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
from llm_gateway.control_plane import HealthControlPlane, RegistryControlPlane, SessionControlPlane, SwitcherControlPlane
from llm_gateway.mtls import has_verified_client, mtls_mode, mtls_required
from llm_gateway.sessions import DuplicateClientError, SessionHub
from llm_gateway.switchers import SwitcherStore
from llm_gateway.trace import TraceLogger

started_at = time.time()
registry: ModelRegistry
tracer: TraceLogger
router: Router
task_router: TaskRouter
health_checker: HealthChecker
switcher_store: SwitcherStore
session_hub: SessionHub
registry_control: RegistryControlPlane
session_control: SessionControlPlane
switcher_control: SwitcherControlPlane
health_control: HealthControlPlane

_CLIENT_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")


def _positive_int_env(name: str, default: int) -> int:
    try:
        value = int(os.environ.get(name, str(default)))
    except ValueError:
        return default
    return value if value > 0 else default


@asynccontextmanager
async def lifespan(app: FastAPI):
    global registry, tracer, router, task_router, health_checker
    global switcher_store, session_hub, registry_control, session_control, switcher_control, health_control
    tracer = TraceLogger()
    registry = ModelRegistry()
    router = Router(registry, tracer)
    task_router = TaskRouter(registry, quota=router.quota, tracer=tracer)
    health_checker = HealthChecker(registry, started_at)
    switcher_store = SwitcherStore(registry)
    session_hub = SessionHub(
        os.environ.get("GATEWAY_WS_BASE_URL", "ws://127.0.0.1:8787"),
        os.environ.get("GATEWAY_NODE_ID", "gateway"),
    )
    registry_control = RegistryControlPlane(switcher_store)
    session_control = SessionControlPlane(session_hub, switcher_store)
    switcher_control = SwitcherControlPlane(switcher_store)
    health_control = HealthControlPlane(health_checker, switcher_store, router.quota)
    yield
    await router.close()
    await health_checker.close()
    tracer.close()


app = FastAPI(
    title="Agent OS Gateway",
    version=__version__,
    lifespan=lifespan,
)


@app.middleware("http")
async def mtls_edge_guard(request: Request, call_next):
    verified = has_verified_client(request.headers)
    if mtls_required() and not verified:
        return JSONResponse(
            status_code=401,
            content={"error": {"message": "verified client certificate required", "type": "mtls_required"}},
        )
    response = await call_next(request)
    response.headers["x-agent-os-mtls"] = "verified" if verified else mtls_mode()
    return response


class _RegistryProxy:
    async def list_models(self, request, ctx):
        return await registry_control.list_models(request, ctx)

    async def list_providers(self, request, ctx):
        return await registry_control.list_providers(request, ctx)

    async def list_hosts(self, request, ctx):
        return await registry_control.list_hosts(request, ctx)

    async def list_nodes(self, request, ctx):
        return await registry_control.list_nodes(request, ctx)


class _HealthProxy:
    async def get_health(self, request, ctx):
        return await health_control.get_health(request, ctx)


class _SessionProxy:
    async def create_session(self, request, ctx):
        return await session_control.create_session(request, ctx)

    async def list_sessions(self, request, ctx):
        return await session_control.list_sessions(request, ctx)

    async def attach_session(self, request, ctx):
        return await session_control.attach_session(request, ctx)

    async def fork_session(self, request, ctx):
        return await session_control.fork_session(request, ctx)


class _SwitcherProxy:
    async def get_switcher_state(self, request, ctx):
        return await switcher_control.get_switcher_state(request, ctx)

    async def set_switcher(self, request, ctx):
        return await switcher_control.set_switcher(request, ctx)

    async def list_switcher_options(self, request, ctx):
        return await switcher_control.list_switcher_options(request, ctx)


for connect_app in (
    HealthServiceASGIApplication(_HealthProxy(), read_max_bytes=1024 * 1024),
    RegistryServiceASGIApplication(_RegistryProxy(), read_max_bytes=1024 * 1024),
    SessionServiceASGIApplication(_SessionProxy(), read_max_bytes=1024 * 1024),
    SwitcherServiceASGIApplication(_SwitcherProxy(), read_max_bytes=1024 * 1024),
):
    app.mount(connect_app.path, connect_app)


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


@app.get("/health")
async def health() -> HealthResponse:
    """Liveness and backend-probe health."""
    report = await health_checker.check()
    return HealthResponse(**report)


@app.websocket("/v1/sessions/{session_id}/ws")
async def session_websocket(websocket: WebSocket, session_id: str) -> None:
    """Carry the generated binary ClientFrame/ServerFrame contract over WS."""
    if mtls_required() and not has_verified_client(websocket.headers):
        await websocket.close(code=4401, reason="verified client certificate required")
        return
    requested_client_id = websocket.query_params.get("client_id")
    client_id = requested_client_id or f"client-{uuid.uuid4().hex[:12]}"
    if requested_client_id is not None and not _CLIENT_ID.fullmatch(requested_client_id):
        await websocket.close(code=4400, reason="client_id must be 1-128 safe identifier characters")
        return
    record = session_hub.get(session_id)
    if record is None:
        await websocket.close(code=4404, reason="session does not exist")
        return
    await websocket.accept()
    attached = False
    try:
        try:
            await session_hub.attach(record, client_id, websocket)
            attached = True
        except DuplicateClientError:
            await websocket.close(code=4409, reason="client_id is already attached")
            return
        except TimeoutError:
            await websocket.close(code=1013, reason="session replay deadline exceeded")
            return
        while True:
            raw = await websocket.receive_bytes()
            if len(raw) > _positive_int_env("GATEWAY_WS_MAX_FRAME_BYTES", 1024 * 1024):
                await websocket.close(code=1009, reason="client frame exceeds configured limit")
                return
            try:
                frame = ClientFrame.from_binary(raw)
            except Exception:
                await websocket.close(code=1003, reason="invalid protobuf client frame")
                return
            if frame.frame is None:
                await websocket.close(code=1003, reason="client frame payload required")
                return
            field = frame.frame.field
            value = frame.frame.value
            if field == "user_input":
                user_input = cast(UserInput, value)
                outgoing = ServerFrame(frame=Oneof("status", Status(state="input", detail=user_input.text, run_status=RunStatus.RUNNING)))  # type: ignore[arg-type]
            elif field == "switch":
                switch = cast(Switch, value)
                try:
                    state = switcher_store.set(switch.axis, switch.value, SwitcherScope.SESSION, session_id)
                    event = SessionEvent(kind=SessionEventKind.SWITCH, payload=Oneof("switch", SwitchState(state=state)))  # type: ignore[arg-type]
                    outgoing = ServerFrame(frame=Oneof("session_event", event))  # type: ignore[arg-type]
                except (ConnectError, ValueError) as exc:
                    error_frame = ServerFrame(
                        frame=Oneof("status", Status(state="switch_error", detail=str(exc), run_status=RunStatus.FAILED))  # type: ignore[arg-type]
                    )
                    await websocket.send_bytes(error_frame.to_binary())
                    continue
            elif field == "interrupt":
                outgoing = ServerFrame(frame=Oneof("status", Status(state="interrupted", run_status=RunStatus.PAUSED)))  # type: ignore[arg-type]
            elif field == "approval_response":
                outgoing = ServerFrame(frame=Oneof("status", Status(state="approval_received", run_status=RunStatus.RUNNING)))  # type: ignore[arg-type]
            elif field == "attach":
                if cast(Attach, value).action == "detach":
                    return
                continue
            else:
                await websocket.close(code=1003, reason="unsupported client frame")
                return
            await session_hub.publish(record, outgoing, exclude=client_id)
    except WebSocketDisconnect:
        pass
    finally:
        if attached:
            await session_hub.detach(record, client_id, websocket)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8787)
