"""Regression coverage for the real VS2 Connect, WebSocket, mTLS, and budget surfaces."""

from __future__ import annotations

import asyncio
import json
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient
from protobuf import Oneof
from starlette.websockets import WebSocketDisconnect

from andromeda.v1.common_pb import Fabric, SwitcherAxis, SwitcherScope, SwitcherState, Task
from andromeda.v1.session_frames_pb import ClientFrame, ServerFrame, Status, Switch, UserInput
from andromeda.v1.sessions_pb import CreateSessionRequest
import llm_gateway.main as gateway_main
from llm_gateway.control_plane import SessionControlPlane
from llm_gateway.main import app
from llm_gateway.quota import QuotaTracker
from llm_gateway.registry import ModelRegistry
from llm_gateway.router import Router, RoutingError
from llm_gateway.sessions import DuplicateClientError, SessionHub
from llm_gateway.switchers import SwitcherStore
from llm_gateway.task_routing import TaskRouter, TaskRoutingPolicy
from llm_gateway.trace import TraceLogger


@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.setenv("ANDROMEDA_HOME", str(tmp_path / ".agents"))
    monkeypatch.setenv("GATEWAY_MTLS_MODE", "off")
    with TestClient(app) as value:
        yield value


def test_generated_connect_handler_serves_registry_rpc(client):
    response = client.post(
        "/andromeda.v1.RegistryService/ListModels",
        content="{}",
        headers={"content-type": "application/json"},
    )
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/json")
    assert {model["id"] for model in response.json()["models"]} == {
        "qwen3-8b",
        "coder-32b-awq",
        "qwen2.5-7b-q4",
        "conv-7b-1m",
        "conv-14b-1m",
    }
    health = client.post(
        "/andromeda.v1.HealthService/GetHealth",
        content="{}",
        headers={"content-type": "application/json"},
    )
    assert health.status_code == 200
    assert health.json()["components"][0]["name"] == "gateway"


def test_switcher_update_preserves_unrelated_axes(monkeypatch, tmp_path):
    registry = _registry(tmp_path)
    registry._definitions["alternate-local"] = {
        "id": "alternate-local",
        "provider": "alternate",
        "model": "alternate-local",
        "api_base": "http://127.0.0.1:8002/v1",
        "role": "general",
        "context_length": 4096,
        "enabled": True,
        "cloud": False,
    }
    registry.refresh_runtime_status(force=True)
    monkeypatch.setenv("GATEWAY_CLUSTER_HOSTS", "s001=http://s001:8001")
    store = SwitcherStore(registry)
    before = store.state()
    after = store.set(SwitcherAxis.HOST, "s001", SwitcherScope.GLOBAL)
    assert after.host == "s001"
    assert after.fabric is before.fabric
    assert after.provider == before.provider
    assert after.model == before.model
    assert after.agent == before.agent
    fabrics = {option.value: option.available for option in store.options(SwitcherAxis.FABRIC)}
    assert fabrics == {"local": True, "cluster": True, "cloud": True}

    cluster = store.set(SwitcherAxis.FABRIC, "cluster", SwitcherScope.GLOBAL)
    assert cluster.fabric is Fabric.CLUSTER
    assert cluster.provider == "local"
    assert cluster.model == "cluster-coder"
    assert {option.value for option in store.options(SwitcherAxis.MODEL)} == {"cluster-coder"}

    store.set(SwitcherAxis.FABRIC, "local", SwitcherScope.GLOBAL)
    alternate = store.set(SwitcherAxis.PROVIDER, "alternate", SwitcherScope.GLOBAL)
    assert alternate.provider == "alternate"
    assert alternate.model == "alternate-local"
    assert {option.value for option in store.options(SwitcherAxis.MODEL)} == {"alternate-local"}

    store.set(SwitcherAxis.AGENT, "codex", SwitcherScope.SESSION, "session-a")
    store.set(SwitcherAxis.FABRIC, "cluster", SwitcherScope.PROJECT, "session-a")
    assert store.state("session-a").fabric is Fabric.CLUSTER
    assert store.state("session-a").agent == "codex"
    assert store.state("session-b").fabric is Fabric.CLUSTER
    assert store.state("session-b").agent == "rommie"
    store.set(SwitcherAxis.AGENT, "claude", SwitcherScope.GLOBAL, "session-a")
    assert store.state("session-a").agent == "codex"
    assert store.state("session-b").agent == "claude"


@pytest.mark.asyncio
async def test_create_session_applies_task_and_switcher_seed(tmp_path):
    registry = _registry(tmp_path)
    switchers = SwitcherStore(registry)
    hub = SessionHub("ws://gateway", "gateway")
    control = SessionControlPlane(hub, switchers)
    response = await control.create_session(
        CreateSessionRequest(
            agent="codex",
            title="seeded",
            task=Task(goal="Ship safely", inputs=["run gates"], acceptance="all green", source="test"),
            switcher=SwitcherState(
                fabric=Fabric.LOCAL,
                provider="local",
                model="local-general",
                agent="codex",
            ),
        ),
        None,
    )
    record = hub.get(response.session.id)
    assert record is not None
    assert record.task is not None and record.task.goal == "Ship safely"
    assert record.history[0].frame is not None
    assert record.history[0].frame.field == "session_event"
    assert switchers.state(record.id).model == "local-general"
    assert switchers.state(record.id).agent == "codex"

    empty = await control.create_session(CreateSessionRequest(agent="codex", title="empty"), None)
    empty_record = hub.get(empty.session.id)
    assert empty_record is not None
    assert empty_record.task is None
    assert empty_record.history == []


def test_binary_websocket_relay_supports_multiple_clients(client, monkeypatch):
    monkeypatch.setenv("GATEWAY_WS_MAX_FRAME_BYTES", "invalid")
    monkeypatch.setenv("GATEWAY_WS_REPLAY_TIMEOUT_SECONDS", "invalid")
    monkeypatch.setenv("GATEWAY_WS_SEND_TIMEOUT_SECONDS", "invalid")
    monkeypatch.setenv("GATEWAY_SESSION_HISTORY_FRAMES", "invalid")
    gateway_main.session_hub.create(session_id="relay")
    with client.websocket_connect("/v1/sessions/relay/ws?client_id=a") as first:
        assert ServerFrame.from_binary(first.receive_bytes()).seq == 1
        with client.websocket_connect("/v1/sessions/relay/ws?client_id=b") as second:
            assert ServerFrame.from_binary(second.receive_bytes()).seq == 1
            assert ServerFrame.from_binary(second.receive_bytes()).seq == 2
            assert ServerFrame.from_binary(first.receive_bytes()).seq == 2
            first.send_bytes(ClientFrame(frame=Oneof("user_input", UserInput(text="hello"))).to_binary())
            relayed = ServerFrame.from_binary(second.receive_bytes())
            assert relayed.seq == 3
            assert relayed.frame is not None
            assert relayed.frame.field == "status"
            assert relayed.frame.value.detail == "hello"


def test_websocket_rejects_unsafe_client_id(client):
    gateway_main.session_hub.create(session_id="client-id")
    with pytest.raises(WebSocketDisconnect) as rejected:
        with client.websocket_connect(f"/v1/sessions/client-id/ws?client_id={'x' * 129}"):
            pass
    assert rejected.value.code == 4400


def test_invalid_switch_returns_error_without_dropping_websocket(client):
    gateway_main.session_hub.create(session_id="switch-error")
    with client.websocket_connect("/v1/sessions/switch-error/ws?client_id=requester") as websocket:
        assert ServerFrame.from_binary(websocket.receive_bytes()).seq == 1
        websocket.send_bytes(ClientFrame(frame=Oneof("switch", Switch(value="bad"))).to_binary())
        error = ServerFrame.from_binary(websocket.receive_bytes())
        assert error.frame is not None and error.frame.field == "status"
        assert error.frame.value.state == "switch_error"
        websocket.send_bytes(ClientFrame(frame=Oneof("switch", Switch(value="still-bad"))).to_binary())
        assert ServerFrame.from_binary(websocket.receive_bytes()).frame.value.state == "switch_error"


def test_websocket_mtls_rejects_spoofed_identity_header(monkeypatch, tmp_path):
    monkeypatch.setenv("ANDROMEDA_HOME", str(tmp_path / ".agents"))
    monkeypatch.setenv("GATEWAY_MTLS_MODE", "require")
    monkeypatch.setenv("GATEWAY_MTLS_EDGE_TOKEN", "trusted-edge-secret")
    with TestClient(app) as client:
        gateway_main.session_hub.create(session_id="secure")
        assert client.get("/health", headers={"x-client-cert-verified": "SUCCESS"}).status_code == 401
        with pytest.raises(WebSocketDisconnect) as rejected:
            with client.websocket_connect(
                "/v1/sessions/secure/ws",
                headers={"x-client-cert-verified": "SUCCESS"},
            ):
                pass
        assert rejected.value.code == 4401
        with client.websocket_connect(
            "/v1/sessions/secure/ws?client_id=verified",
            headers={"x-client-cert-verified": "SUCCESS", "x-gateway-edge-token": "trusted-edge-secret"},
        ) as websocket:
            assert ServerFrame.from_binary(websocket.receive_bytes()).seq == 1


def test_websocket_rejects_unknown_session_without_creating_it(client):
    with pytest.raises(WebSocketDisconnect) as rejected:
        with client.websocket_connect("/v1/sessions/not-created/ws"):
            pass
    assert rejected.value.code == 4404
    assert gateway_main.session_hub.get("not-created") is None


@pytest.mark.asyncio
async def test_relay_drops_broken_or_slow_client_without_blocking_healthy_delivery(monkeypatch):
    class Socket:
        def __init__(self, broken: bool = False, slow: bool = False) -> None:
            self.broken = broken
            self.slow = slow
            self.payloads: list[bytes] = []

        async def send_bytes(self, payload: bytes) -> None:
            if self.broken:
                raise RuntimeError("closed")
            if self.slow:
                await asyncio.Event().wait()
            self.payloads.append(payload)

    monkeypatch.setenv("GATEWAY_WS_SEND_TIMEOUT_SECONDS", "0.02")
    hub = SessionHub("ws://gateway", "gateway")
    record = hub.create(session_id="broken-relay")
    broken = Socket(broken=True)
    slow = Socket(slow=True)
    healthy = Socket()
    record.clients = {"broken": broken, "slow": slow, "healthy": healthy}  # type: ignore[dict-item]
    delivered = await asyncio.wait_for(
        hub.publish(record, ServerFrame(frame=Oneof("status", Status(state="running")))),  # type: ignore[arg-type]
        timeout=0.2,
    )
    assert delivered == 1
    assert list(record.clients) == ["healthy"]
    assert len(healthy.payloads) == 3
    detach_frames = [ServerFrame.from_binary(payload) for payload in healthy.payloads[1:]]
    assert all(frame.frame is not None and frame.frame.field == "session_event" for frame in detach_frames)


@pytest.mark.asyncio
async def test_duplicate_client_attach_is_atomic_and_stale_detach_cannot_evict_owner():
    class Socket:
        async def send_bytes(self, payload: bytes) -> None:
            pass

    hub = SessionHub("ws://gateway", "gateway")
    record = hub.create(session_id="duplicate-client")
    owner = Socket()
    duplicate = Socket()
    await hub.attach(record, "shared", owner)  # type: ignore[arg-type]
    with pytest.raises(DuplicateClientError):
        await hub.attach(record, "shared", duplicate)  # type: ignore[arg-type]
    await hub.detach(record, "shared", duplicate)  # type: ignore[arg-type]
    assert record.clients == {"shared": owner}


@pytest.mark.asyncio
async def test_attach_replay_is_an_atomic_boundary_before_live_delivery():
    class BlockingSocket:
        def __init__(self) -> None:
            self.started = asyncio.Event()
            self.release = asyncio.Event()
            self.sequences: list[int] = []

        async def send_bytes(self, payload: bytes) -> None:
            frame = ServerFrame.from_binary(payload)
            if not self.sequences:
                self.started.set()
                await self.release.wait()
            self.sequences.append(frame.seq)

    hub = SessionHub("ws://gateway", "gateway")
    record = hub.create(session_id="ordered-replay")
    await hub.publish(record, ServerFrame(frame=Oneof("status", Status(state="history"))))  # type: ignore[arg-type]
    socket = BlockingSocket()
    attach = asyncio.create_task(hub.attach(record, "late-client", socket))  # type: ignore[arg-type]
    await socket.started.wait()
    live = asyncio.create_task(
        hub.publish(record, ServerFrame(frame=Oneof("status", Status(state="live"))))  # type: ignore[arg-type]
    )
    await asyncio.sleep(0)
    assert live.done() is False
    socket.release.set()
    await asyncio.gather(attach, live)
    assert socket.sequences == sorted(socket.sequences)
    assert socket.sequences[:2] == [1, 2]


@pytest.mark.asyncio
async def test_attach_replay_uses_one_total_deadline(monkeypatch):
    class SlowSocket:
        async def send_bytes(self, payload: bytes) -> None:
            await asyncio.Event().wait()

    monkeypatch.setenv("GATEWAY_WS_REPLAY_TIMEOUT_SECONDS", "0.02")
    monkeypatch.setenv("GATEWAY_WS_SEND_TIMEOUT_SECONDS", "1")
    hub = SessionHub("ws://gateway", "gateway")
    record = hub.create(session_id="bounded-replay")
    await hub.publish(record, ServerFrame(frame=Oneof("status", Status(state="one"))))  # type: ignore[arg-type]
    await hub.publish(record, ServerFrame(frame=Oneof("status", Status(state="two"))))  # type: ignore[arg-type]
    with pytest.raises(TimeoutError):
        await asyncio.wait_for(hub.attach(record, "slow", SlowSocket()), timeout=0.2)  # type: ignore[arg-type]
    assert "slow" not in record.clients
    await asyncio.wait_for(
        hub.publish(record, ServerFrame(frame=Oneof("status", Status(state="after-timeout")))),  # type: ignore[arg-type]
        timeout=0.2,
    )


def test_durable_budget_exhaustion_degrades_cloud_to_local(monkeypatch, tmp_path):
    registry = _registry(tmp_path)
    registry._definitions = {"cluster-general": _cluster_general(), **registry._definitions}
    registry.refresh_runtime_status(force=True)
    budget_path = tmp_path / "credits.json"
    budget_path.write_text(
        json.dumps(
            {
                "providers": {
                    "claude": {
                        "requests": 1,
                        "tokensIn": 8,
                        "tokensOut": 4,
                        "budget": {"maxTokens": 12},
                    }
                }
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("ANDROMEDA_CREDITS", str(budget_path))
    tracer = TraceLogger(trace_dir=tmp_path / "traces")
    router = Router(registry, tracer, quota=QuotaTracker())
    try:
        assert router.resolve_model("cloud-general", allow_cloud=True).id == "local-general"
    finally:
        tracer.close()


@pytest.mark.asyncio
async def test_role_alias_trace_reports_cloud_to_local_degrade(tmp_path):
    registry = _registry(tmp_path)
    registry._definitions = {
        "cloud-general": registry._definitions["cloud-general"],
        "local-general": registry._definitions["local-general"],
    }
    registry.refresh_runtime_status(force=True)
    tracer = TraceLogger(trace_dir=tmp_path / "traces")
    router = Router(registry, tracer, quota=QuotaTracker())
    router._via_http = AsyncMock(  # type: ignore[method-assign]
        return_value={
            "choices": [{"message": {"role": "assistant", "content": "ok"}}],
            "usage": {"completion_tokens": 1},
        }
    )
    try:
        result = await router.chat_completion("general", [{"role": "user", "content": "hi"}])
        assert result["llm_gateway"]["resolved_model_id"] == "local-general"
        assert result["llm_gateway"]["degraded_to_local"] is True
    finally:
        await router.close()
        tracer.close()


def test_task_cloud_fallback_skips_cluster_and_selects_local(tmp_path):
    registry = _registry(tmp_path)
    registry._definitions = {"cluster-general": _cluster_general(), **registry._definitions}
    registry.refresh_runtime_status(force=True)
    policy_path = tmp_path / "routing.yaml"
    policy_path.write_text(
        "schema_version: gateway-routing-v1\nclasses:\n  fallback:\n    candidates:\n"
        "      - {provider: claude, model_id: cloud-general}\n"
        "      - {provider: local, model_id: cluster-general}\n"
        "      - {provider: local, model_id: local-general}\n",
        encoding="utf-8",
    )
    route = TaskRouter(registry, policy=TaskRoutingPolicy(policy_path)).resolve("fallback")
    assert route.model_id == "local-general"
    statuses = {item["model_id"]: item["unavailable_reason"] for item in route.candidates}
    assert statuses["cluster-general"] == "local_fallback_required"


def test_cloud_route_requires_opt_in_and_fails_closed_on_bad_budget(monkeypatch, tmp_path):
    registry = _registry(tmp_path)
    tracer = TraceLogger(trace_dir=tmp_path / "traces")
    router = Router(registry, tracer, quota=QuotaTracker())
    try:
        assert router.resolve_model("cloud-general").id == "local-general"
        assert router.resolve_model("cloud-general", allow_cloud=True).id == "cloud-general"
        budget_path = tmp_path / "bad-credits.json"
        budget_path.write_text("not-json", encoding="utf-8")
        monkeypatch.setenv("GATEWAY_BUDGETS_PATH", str(budget_path))
        assert router.resolve_model("cloud-general", allow_cloud=True).id == "local-general"
    finally:
        tracer.close()


def test_configured_budget_authority_fails_closed_for_bad_root_or_missing_provider(monkeypatch, tmp_path):
    budget_path = tmp_path / "credits.json"
    monkeypatch.setenv("GATEWAY_BUDGETS_PATH", str(budget_path))
    quota = QuotaTracker()
    budget_path.write_text("[]", encoding="utf-8")
    assert quota.is_exhausted("claude") is True
    budget_path.write_text(json.dumps({"providers": {}}), encoding="utf-8")
    assert quota.is_exhausted("claude") is True


def test_cloud_fallback_never_selects_disabled_local_model(tmp_path):
    registry = _registry(tmp_path)
    registry._definitions["local-general"]["enabled"] = False
    registry.refresh_runtime_status(force=True)
    tracer = TraceLogger(trace_dir=tmp_path / "traces")
    router = Router(registry, tracer, quota=QuotaTracker())
    try:
        with pytest.raises(RoutingError, match="no local fallback"):
            router.resolve_model("cloud-general", allow_cloud=False)
    finally:
        tracer.close()


def _cluster_general() -> dict[str, object]:
    return {
        "id": "cluster-general",
        "provider": "local",
        "model": "cluster-general",
        "api_base": "http://s002:8001/v1",
        "role": "general",
        "context_length": 4096,
        "enabled": True,
        "extra": {"node_id": "s002"},
    }


def _registry(tmp_path) -> ModelRegistry:
    registry_path = tmp_path / "models.yaml"
    schema_path = tmp_path / "schema.json"
    schema_path.write_text(json.dumps({"type": "object"}), encoding="utf-8")
    registry_path.write_text(
        json.dumps(
            {
                "schema_version": "gateway-registry-v1",
                "models": {
                    "local-general": {
                        "id": "local-general",
                        "provider": "local",
                        "model": "local-general",
                        "api_base": "http://127.0.0.1:8001/v1",
                        "role": "general",
                        "context_length": 4096,
                        "enabled": True,
                    },
                    "cluster-coder": {
                        "id": "cluster-coder",
                        "provider": "local",
                        "model": "cluster-coder",
                        "api_base": "http://s001:8001/v1",
                        "role": "coding",
                        "context_length": 4096,
                        "enabled": True,
                        "extra": {"node_id": "s001"},
                    },
                    "cloud-general": {
                        "id": "cloud-general",
                        "provider": "claude",
                        "model": "claude-sonnet",
                        "api_base": "https://cloud.invalid/v1",
                        "role": "general",
                        "context_length": 4096,
                        "enabled": True,
                        "cloud": True,
                    },
                },
            }
        ),
        encoding="utf-8",
    )
    return ModelRegistry(registry_path, schema_path, tmp_path / "missing-inferctl.yaml")
