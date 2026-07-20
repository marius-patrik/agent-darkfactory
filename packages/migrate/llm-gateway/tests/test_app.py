"""App-level smoke tests over the FastAPI TestClient (uses the shipped registry).

No live engines are needed: /healthz returns HTTP 200 with the health report
even when the local engines are unreachable (status='unhealthy' but the route
serves), and the switcher endpoints read the registry only.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from agentos_gateway.main import app, _load_registry
from agentos_gateway.registry import ActiveRoleManager, ModelRegistry
from agentos_gateway.trace import TraceLogger


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


def test_app_imports():
    # The import at module top already exercised this; assert the app object.
    assert app.title == "Agentos Gateway"


def test_pg_registry_import_failure_falls_back(monkeypatch, tmp_path):
    monkeypatch.setenv("GATEWAY_PG_DSN", "postgres://unreachable")

    def fail_import(name, *args, **kwargs):
        if name == "agentos_gateway.pg_registry":
            raise ImportError("forced missing asyncpg path")
        return real_import(name, *args, **kwargs)

    real_import = __import__
    monkeypatch.setattr("builtins.__import__", fail_import)
    tracer = TraceLogger(trace_dir=tmp_path / "traces")
    try:
        registry, active = _load_registry(tracer)
        assert isinstance(registry, ModelRegistry)
        assert isinstance(active, ActiveRoleManager)
    finally:
        tracer.close()


def test_healthz_returns_200(client):
    resp = client.get("/healthz")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] in ("healthy", "degraded", "unhealthy")
    assert body["models_registered"] == 9
    assert "details" in body


def test_health_alias_returns_200(client):
    resp = client.get("/health")
    assert resp.status_code == 200


def test_models_lists_five_local_engines(client):
    resp = client.get("/v1/models")
    assert resp.status_code == 200
    ids = {m["id"] for m in resp.json()["data"]}
    assert ids == {"qwen3-8b", "coder-32b-awq", "qwen2.5-7b-q4", "conv-7b-1m", "conv-14b-1m"}


def test_route_resolve_returns_task_class_model(client):
    resp = client.post("/route", json={"task_class": "standard-impl"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["task_class"] == "standard-impl"
    assert body["provider"] == "local"
    assert body["model_id"] == "qwen3-8b"
    assert body["params"]["model_reasoning_effort"] == "medium"


def test_route_resolve_path_supports_slash_class(client):
    resp = client.get("/route/judgment/orchestration")
    assert resp.status_code == 200
    assert resp.json()["task_class"] == "judgment/orchestration"


def test_switcher_state_defaults_local(client):
    resp = client.get("/switcher/state")
    assert resp.status_code == 200
    state = resp.json()
    assert state["fabric"] == "local"
    assert state["host"] == "gateway"


def test_fabric_options(client):
    resp = client.get("/fabric")
    assert resp.status_code == 200
    opts = {o["value"]: o for o in resp.json()["options"]}
    assert opts["local"]["available"] is True
    assert opts["cloud"]["available"] is False


def test_host_provider_model_option_endpoints(client):
    for axis in ("host", "provider", "model"):
        resp = client.get(f"/{axis}")
        assert resp.status_code == 200
        assert resp.json()["axis"] == axis
        assert isinstance(resp.json()["options"], list)


def test_set_fabric(client):
    resp = client.post("/fabric/local")
    assert resp.status_code == 200
    assert resp.json()["fabric"] == "local"


def test_set_invalid_fabric_rejected(client):
    resp = client.post("/fabric/warp")
    assert resp.status_code == 400


def test_chat_completions_rejects_unknown_model(client):
    resp = client.post("/v1/chat/completions", json={
        "model": "does-not-exist",
        "messages": [{"role": "user", "content": "hi"}],
    })
    # resolve_model raises RoutingError -> 400 (handled).
    assert resp.status_code == 400


def test_chat_completions_rejects_cloud_without_optin(client):
    # No enabled cloud model exists in VS1, but the guard semantics still hold:
    # an unknown/disabled model is rejected, never silently metered.
    resp = client.post("/v1/chat/completions", json={
        "model": "claude-sonnet-4",
        "messages": [{"role": "user", "content": "hi"}],
        "allow_cloud": True,
    })
    assert resp.status_code == 400
