"""App-level smoke tests over the FastAPI TestClient (uses the shipped registry).

No live engines are needed: /health returns HTTP 200 with the health report
even when the local engines are unreachable (status='unhealthy' but the route
serves).
"""

from __future__ import annotations

from pathlib import Path

import pytest
import yaml
from fastapi.testclient import TestClient

from llm_gateway.main import app


@pytest.fixture
def source_models():
    registry_path = Path(__file__).resolve().parents[1] / "registry" / "models.yaml"
    raw = yaml.safe_load(registry_path.read_text())
    return raw["models"]


@pytest.fixture
def client(monkeypatch, tmp_path, source_models):
    monkeypatch.setenv("ANDROMEDA_HOME", str(tmp_path / ".andromeda"))
    status_path = tmp_path / "inferctl-engines.yaml"
    status_path.write_text(
        "schema_version: inferctl-local-engines-v1\nengines:\n"
        + "".join(
            f"  {model}: {{status: healthy, api_base: 'http://127.0.0.1:{8001 + index}/v1'}}\n"
            for index, model in enumerate(source_models)
        )
    )
    monkeypatch.setenv("GATEWAY_INFERCTL_STATUS_PATH", str(status_path))
    with TestClient(app) as c:
        yield c


def test_app_imports():
    # The import at module top already exercised this; assert the app object.
    assert app.title == "Agent OS Gateway"


def test_health_returns_200(client, source_models):
    resp = client.get("/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] in ("healthy", "degraded", "unhealthy")
    assert body["models_registered"] == len(source_models)
    assert "details" in body


def test_models_match_the_source_registry(client, source_models):
    resp = client.get("/v1/models")
    assert resp.status_code == 200
    ids = {m["id"] for m in resp.json()["data"]}
    assert ids == set(source_models)
    assert all(model["context_length"] > 0 for model in resp.json()["data"])
    assert {model["role"] for model in resp.json()["data"]} == {
        definition["role"] for definition in source_models.values()
    }


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
