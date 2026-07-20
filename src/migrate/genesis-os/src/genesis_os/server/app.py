from __future__ import annotations

import asyncio
import os
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, Field

from genesis_os.config import RuntimeSettings, WorkspacePaths
from genesis_os.integrations import AndromedaBridge, AndromedaEvent
from genesis_os.runtime.factory import load_runtime
from genesis_os.sleep import SleepProgram, SleepSpec
from genesis_os.storage import LineageStore
from genesis_os.types import Observation, ToolCall
from genesis_os.version import __version__


class ObserveRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    content: str
    source: str = "user"
    session_id: str | None = None
    structured: dict[str, Any] = Field(default_factory=dict)


class InvokeToolRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    tool: str
    arguments: dict[str, Any] = Field(default_factory=dict)
    session_id: str | None = None


class SleepRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    spec: SleepSpec | None = None


def create_app(
    *,
    workspace: str | Path,
    lineage_id: str,
    device: str = "cpu",
    settings: RuntimeSettings | None = None,
) -> FastAPI:
    paths = WorkspacePaths.from_root(workspace)
    paths.ensure()
    runtime = load_runtime(workspace, lineage_id=lineage_id, device=device, settings=settings)
    app = FastAPI(
        title="Genesis OS",
        version=__version__,
        description="Tool-native persistent organism runtime and lifecycle API.",
    )
    origins = [
        value.strip() for value in os.getenv("GENESIS_CORS_ORIGINS", "").split(",") if value.strip()
    ]
    if origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=origins,
            allow_credentials=True,
            allow_methods=["*"],
            allow_headers=["*"],
        )
    app.state.runtime = runtime
    app.state.workspace = str(paths.root)
    app.state.lineage_id = lineage_id
    app.state.device = device
    app.state.settings = settings
    app.state.runtime_lock = asyncio.Lock()

    async def authorize(authorization: str | None = Header(default=None)) -> None:
        expected = os.getenv("GENESIS_API_TOKEN")
        if not expected:
            return
        if authorization != f"Bearer {expected}":
            raise HTTPException(status_code=401, detail="Invalid Genesis API token")

    @app.get("/health")
    async def health(_: None = Depends(authorize)) -> dict[str, Any]:
        current = LineageStore(paths.lineages).current(lineage_id)
        return {
            "status": "ok",
            "version": __version__,
            "lineage_id": lineage_id,
            "release_id": current.release_id,
            "latest_sequence": app.state.runtime.ledger.latest_sequence(),
        }

    @app.get("/v1/tools")
    async def tools(_: None = Depends(authorize)) -> dict[str, Any]:
        app.state.runtime.registry.refresh_dynamic()
        return {"tools": app.state.runtime.registry.specs()}

    @app.post("/v1/tools/invoke")
    async def invoke_tool(
        request: InvokeToolRequest, _: None = Depends(authorize)
    ) -> dict[str, Any]:
        result = await app.state.runtime.invoke_tool(
            ToolCall(tool=request.tool, arguments=request.arguments),
            session_id=request.session_id,
        )
        return result.model_dump(mode="json")

    @app.post("/v1/observe")
    async def observe(request: ObserveRequest, _: None = Depends(authorize)) -> dict[str, Any]:
        async with app.state.runtime_lock:
            result = await app.state.runtime.observe(
                Observation(
                    source=request.source,
                    content=request.content,
                    structured=request.structured,
                ),
                session_id=request.session_id,
            )
        return {
            "session_id": result.session_id,
            "messages": result.messages,
            "tool_results": [value.model_dump(mode="json") for value in result.tool_results],
            "yielded": result.yielded,
            "sleep_requested": result.sleep_requested,
            "final_sequence": result.final_sequence,
        }

    @app.post("/v1/andromeda/events")
    async def andromeda_event(
        event: AndromedaEvent, _: None = Depends(authorize)
    ) -> dict[str, Any]:
        async with app.state.runtime_lock:
            result = await AndromedaBridge(app.state.runtime).accept(event)
        return {
            "session_id": result.session_id,
            "messages": result.messages,
            "tool_results": [value.model_dump(mode="json") for value in result.tool_results],
            "yielded": result.yielded,
            "sleep_requested": result.sleep_requested,
            "final_sequence": result.final_sequence,
        }

    @app.get("/v1/events")
    async def events(
        after_sequence: int = Query(default=0, ge=0),
        limit: int = Query(default=200, ge=1, le=5000),
        _: None = Depends(authorize),
    ) -> dict[str, Any]:
        values = app.state.runtime.ledger.events(after_sequence=after_sequence, limit=limit)
        return {"events": [value.model_dump(mode="json") for value in values]}

    @app.post("/v1/sleep")
    async def sleep(request: SleepRequest, _: None = Depends(authorize)) -> dict[str, Any]:
        async with app.state.runtime_lock:
            result = await asyncio.to_thread(
                SleepProgram(paths.root).run,
                lineage_id,
                request.spec,
            )
            if result.promoted:
                app.state.runtime = load_runtime(
                    paths.root,
                    lineage_id=lineage_id,
                    device=device,
                    settings=settings,
                )
        return result.model_dump(mode="json")

    @app.websocket("/v1/events/ws")
    async def event_stream(websocket: WebSocket) -> None:
        token = websocket.query_params.get("token")
        expected = os.getenv("GENESIS_API_TOKEN")
        if expected and token != expected:
            await websocket.close(code=4401)
            return
        await websocket.accept()
        cursor = int(websocket.query_params.get("after_sequence", "0"))
        try:
            while True:
                values = app.state.runtime.ledger.events(after_sequence=cursor, limit=500)
                for event in values:
                    await websocket.send_json(event.model_dump(mode="json"))
                    cursor = event.sequence
                await asyncio.sleep(0.25)
        except WebSocketDisconnect:
            return

    return app
