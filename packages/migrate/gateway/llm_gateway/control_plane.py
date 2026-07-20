"""Concrete implementations for the generated Agent OS Connect services."""

from __future__ import annotations

import os
from typing import Any

from agent_os.v1.common_pb import Usage
from agent_os.v1.health_pb import ComponentHealth, GetHealthRequest, GetHealthResponse
from agent_os.v1.registry_pb import (
    ListHostsRequest,
    ListHostsResponse,
    ListModelsRequest,
    ListModelsResponse,
    ListNodesRequest,
    ListNodesResponse,
    ListProvidersRequest,
    ListProvidersResponse,
)
from agent_os.v1.sessions_pb import (
    AttachSessionRequest,
    AttachSessionResponse,
    CreateSessionRequest,
    CreateSessionResponse,
    ForkSessionRequest,
    ForkSessionResponse,
    ListSessionsRequest,
    ListSessionsResponse,
)
from agent_os.v1.switchers_pb import (
    GetSwitcherStateRequest,
    GetSwitcherStateResponse,
    ListSwitcherOptionsRequest,
    ListSwitcherOptionsResponse,
    SetSwitcherRequest,
    SetSwitcherResponse,
)
from connectrpc.code import Code
from connectrpc.errors import ConnectError

from llm_gateway.sessions import SessionHub
from llm_gateway.switchers import SwitcherStore


class HealthControlPlane:
    def __init__(self, checker: Any, switchers: SwitcherStore, quota: Any) -> None:
        self.checker = checker
        self.switchers = switchers
        self.quota = quota

    async def get_health(self, request: GetHealthRequest, ctx: Any) -> GetHealthResponse:
        report = await self.checker.check()
        snapshot = self.quota.snapshot()
        state = {"healthy": "ok", "degraded": "degraded", "unhealthy": "down"}.get(report["status"], "down")
        components = [ComponentHealth(name="gateway", state=state, detail="runtime health aggregate")]
        components.extend(
            ComponentHealth(name=name, state="ok" if healthy else "down", detail="model backend")
            for name, healthy in sorted(report.get("details", {}).items())
        )
        nodes = self.switchers.nodes()
        require_all = os.environ.get("GATEWAY_REQUIRE_ALL_NODES", "false").strip().lower() in {"1", "true", "yes"}
        return GetHealthResponse(
            paused=require_all and any(not node.online for node in nodes),
            nodes=nodes,
            components=components,
            usage=Usage(
                input_tokens=0,
                output_tokens=sum(int(state.get("tokens", 0)) for state in snapshot.values()),
                degraded_to_local=any(bool(state.get("exhausted")) for state in snapshot.values()),
            ),
        )


class RegistryControlPlane:
    def __init__(self, switchers: SwitcherStore) -> None:
        self.switchers = switchers

    async def list_models(self, request: ListModelsRequest, ctx: Any) -> ListModelsResponse:
        models = self.switchers.models()
        if request.fabric.value:
            models = [model for model in models if model.fabric == request.fabric]
        if request.provider_id:
            models = [model for model in models if model.provider_id == request.provider_id]
        if request.role:
            models = [model for model in models if model.role == request.role]
        return ListModelsResponse(models=models)

    async def list_providers(self, request: ListProvidersRequest, ctx: Any) -> ListProvidersResponse:
        providers = self.switchers.providers()
        if request.fabric.value:
            providers = [provider for provider in providers if provider.fabric == request.fabric]
        return ListProvidersResponse(providers=providers)

    async def list_hosts(self, request: ListHostsRequest, ctx: Any) -> ListHostsResponse:
        return ListHostsResponse(hosts=self.switchers.hosts())

    async def list_nodes(self, request: ListNodesRequest, ctx: Any) -> ListNodesResponse:
        return ListNodesResponse(nodes=self.switchers.nodes())


class SessionControlPlane:
    def __init__(self, sessions: SessionHub, switchers: SwitcherStore) -> None:
        self.sessions = sessions
        self.switchers = switchers

    async def create_session(self, request: CreateSessionRequest, ctx: Any) -> CreateSessionResponse:
        record = self.sessions.create(agent=request.agent, title=request.title)
        try:
            if request.switcher is not None:
                self.switchers.seed_session(record.id, request.switcher)
            if request.task is not None:
                await self.sessions.seed_task(record, request.task)
        except Exception:
            self.switchers.clear_session(record.id)
            self.sessions.discard(record.id)
            raise
        return CreateSessionResponse(session=record.message(), attach=self.sessions.attach_info(record))

    async def list_sessions(self, request: ListSessionsRequest, ctx: Any) -> ListSessionsResponse:
        return ListSessionsResponse(sessions=[record.message() for record in self.sessions.list(request.filter, request.live_only)])

    async def attach_session(self, request: AttachSessionRequest, ctx: Any) -> AttachSessionResponse:
        record = self.sessions.get(request.session_id)
        if record is None:
            raise ConnectError(Code.NOT_FOUND, f"session {request.session_id!r} not found")
        return AttachSessionResponse(attach=self.sessions.attach_info(record))

    async def fork_session(self, request: ForkSessionRequest, ctx: Any) -> ForkSessionResponse:
        try:
            record = self.sessions.fork(request.session_id, request.title, request.at_turn_id)
        except KeyError as exc:
            raise ConnectError(Code.NOT_FOUND, f"session {request.session_id!r} not found") from exc
        except ValueError as exc:
            raise ConnectError(Code.INVALID_ARGUMENT, str(exc)) from exc
        return ForkSessionResponse(session=record.message(), attach=self.sessions.attach_info(record))


class SwitcherControlPlane:
    def __init__(self, switchers: SwitcherStore) -> None:
        self.switchers = switchers

    async def get_switcher_state(self, request: GetSwitcherStateRequest, ctx: Any) -> GetSwitcherStateResponse:
        return GetSwitcherStateResponse(state=self.switchers.state(request.session_id))

    async def set_switcher(self, request: SetSwitcherRequest, ctx: Any) -> SetSwitcherResponse:
        state = self.switchers.set(request.axis, request.value, request.scope, request.session_id)
        return SetSwitcherResponse(state=state)

    async def list_switcher_options(self, request: ListSwitcherOptionsRequest, ctx: Any) -> ListSwitcherOptionsResponse:
        return ListSwitcherOptionsResponse(options=self.switchers.options(request.axis, request.session_id))
