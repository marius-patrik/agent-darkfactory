"""App-level smoke tests over the FastAPI TestClient (uses the shipped registry).

No live engines are needed: /health returns HTTP 200 with the health report
even when the local engines are unreachable (status='unhealthy' but the route
serves).
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from llm_gateway.main import app


@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.setenv("AGENTS_HOME", str(tmp_path / ".agents"))
    with TestClient(app) as c:
        yield c


def test_app_imports():
    # The import at module top already exercised this; assert the app object.
    assert app.title == "Agent OS Gateway"


def test_health_returns_200(client):
    resp = client.get("/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] in ("healthy", "degraded", "unhealthy")
    assert body["models_registered"] == 5
    assert "details" in body


def test_models_lists_five_local_engines(client):
    resp = client.get("/v1/models")
    assert resp.status_code == 200
    ids = {m["id"] for m in resp.json()["data"]}
    assert ids == {"qwen3-8b", "coder-32b-awq", "qwen2.5-7b-q4", "conv-7b-1m", "conv-14b-1m"}
    assert all(model["context_length"] > 0 for model in resp.json()["data"])
    assert {model["role"] for model in resp.json()["data"]} == {"general", "coding", "conversation", "judge"}


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


def test_chat_completions_rejects_unknown_model(client):
    resp = client.post("/v1/chat/completions", json={
        "model": "does-not-exist",
        "messages": [{"role": "user", "content": "hi"}],
    })
    # resolve_model raises RoutingError -> 400 (handled).
    assert resp.status_code == 400
