"""Tests for health endpoint and probes."""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

import pytest

from agentos_gateway.registry import ModelRegistry, ActiveRoleManager
from agentos_gateway.health import HealthChecker


@pytest.fixture
def health_fixture():
    with tempfile.TemporaryDirectory() as td:
        reg_path = Path(td) / "models.yaml"
        active_path = Path(td) / "active.yaml"
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
                    "api_base": "http://localhost:59999/v1",
                    "role": "general",
                    "context_length": 100,
                    "enabled": True,
                    "cloud": False,
                },
            },
        }))
        reg = ModelRegistry(registry_path=reg_path, schema_path=schema_path)
        active = ActiveRoleManager(active_path=active_path)
        checker = HealthChecker(reg, active, started_at=0.0)
        yield checker, reg, active


class TestHealthCheck:
    async def test_returns_report(self, health_fixture):
        checker, _, _ = health_fixture
        report = await checker.check()
        assert "status" in report
        assert "git_sha" in report
        assert "image_tag" in report
        assert "build_time" in report
        assert "node_id" in report
        assert "models_registered" in report
        assert report["models_registered"] == 1

    async def test_unhealthy_when_all_down(self, health_fixture):
        checker, _, _ = health_fixture
        report = await checker.check()
        # The offline model will fail the probe
        assert report["status"] == "unhealthy"
        assert report["models_healthy"] == 0

    async def test_roles_configured(self, health_fixture):
        checker, _, active = health_fixture
        active.set("general", "offline")
        report = await checker.check()
        assert report["roles_configured"] == 1
