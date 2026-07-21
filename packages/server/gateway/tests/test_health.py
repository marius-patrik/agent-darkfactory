"""Tests for health endpoint and probes."""

from __future__ import annotations

import json
import tempfile
from importlib.metadata import version
from pathlib import Path

import pytest

from llm_gateway.registry import ModelRegistry
from llm_gateway.health import HealthChecker


@pytest.fixture
def health_fixture():
    with tempfile.TemporaryDirectory() as td:
        reg_path = Path(td) / "models.yaml"
        schema_path = Path(td) / "schema.json"
        schema_path.write_text(json.dumps({
            "type": "object",
            "properties": {
                "schema_version": {"type": "string"},
                "models": {"type": "object"},
            },
        }))
        reg_path.write_text(json.dumps({
            "schema_version": "gateway-registry-v1",
            "models": {
                "offline": {
                    "id": "offline",
                    "provider": "local",
                    "model": "offline",
                    "api_base": "http://localhost:59999/v1",
                    "role": "general",
                    "context_length": 100,
                    "enabled": True,
                },
            },
        }))
        reg = ModelRegistry(registry_path=reg_path, schema_path=schema_path)
        checker = HealthChecker(reg, started_at=0.0)
        yield checker, reg


class TestHealthCheck:
    async def test_returns_report(self, health_fixture):
        checker, _ = health_fixture
        report = await checker.check()
        assert "status" in report
        assert "git_sha" in report
        assert "build_time" in report
        assert "node_id" in report
        assert "models_registered" in report
        assert report["models_registered"] == 1

    async def test_unhealthy_when_all_down(self, health_fixture):
        checker, _ = health_fixture
        report = await checker.check()
        # The offline model will fail the probe
        assert report["status"] == "unhealthy"
        assert report["models_healthy"] == 0

    async def test_roles_available(self, health_fixture):
        checker, _ = health_fixture
        report = await checker.check()
        assert report["roles_available"] == 1

    async def test_uses_package_version_and_reads_build_environment(self, health_fixture, monkeypatch):
        checker, _ = health_fixture
        monkeypatch.setenv("ANDROMEDA_GIT_SHA", "abc123")
        monkeypatch.setenv("ANDROMEDA_BUILD_TIME", "2026-07-10T12:00:00Z")
        monkeypatch.setenv("ANDROMEDA_NODE_ID", "node-test")
        report = await checker.check()
        assert report["version"] == version("agent-os-gateway")
        assert report["git_sha"] == "abc123"
        assert report["build_time"] == "2026-07-10T12:00:00Z"
        assert report["node_id"] == "node-test"
