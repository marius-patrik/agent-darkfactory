"""Tests for the two-axis switcher surface (host + fabric/provider/model, §06)."""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

import pytest

from agentos_gateway.registry import ModelRegistry, ActiveRoleManager
from agentos_gateway.switchers import SwitcherService


@pytest.fixture
def switcher_fixture():
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
                "gen-a": {"id": "gen-a", "provider": "local", "api_base": "http://127.0.0.1:8001/v1", "role": "general", "context_length": 1, "enabled": True, "cloud": False},
                "code-a": {"id": "code-a", "provider": "local", "api_base": "http://127.0.0.1:8002/v1", "role": "coding", "context_length": 1, "enabled": True, "cloud": False},
                "conv-a": {"id": "conv-a", "provider": "local", "api_base": "http://127.0.0.1:8004/v1", "role": "conversation", "context_length": 1, "enabled": True, "cloud": False},
                "cloud-x": {"id": "cloud-x", "provider": "litellm-remote", "api_base": "http://127.0.0.1:9000/v1", "role": "general", "context_length": 1, "enabled": False, "cloud": True},
            },
        }))
        reg = ModelRegistry(registry_path=reg_path, schema_path=schema_path)
        active = ActiveRoleManager(active_path=active_path)
        yield SwitcherService(reg, active), reg, active


class TestSwitcherState:
    def test_default_state_local_fabric(self, switcher_fixture):
        svc, _, _ = switcher_fixture
        state = svc.get_state()
        assert state["fabric"] == "local"
        assert state["host"] == "gateway"
        assert state["scope_source"] == "global"


class TestSwitcherOptions:
    def test_fabric_options_only_local_available(self, switcher_fixture):
        svc, _, _ = switcher_fixture
        opts = {o["value"]: o for o in svc.list_options("fabric")}
        assert opts["local"]["available"] is True
        assert opts["cluster"]["available"] is False
        assert opts["cloud"]["available"] is False

    def test_cloud_fabric_availability_flips_with_enabled_cloud_entry(self, switcher_fixture):
        svc, reg, _ = switcher_fixture
        opts = {o["value"]: o for o in svc.list_options("fabric")}
        assert opts["cloud"]["available"] is False
        cloud = reg.get("cloud-x")
        cloud.enabled = True
        opts = {o["value"]: o for o in svc.list_options("fabric")}
        assert opts["cloud"]["available"] is True

    def test_host_options_only_gateway_available(self, switcher_fixture):
        svc, _, _ = switcher_fixture
        opts = {o["value"]: o for o in svc.list_options("host")}
        assert opts["gateway"]["available"] is True
        assert opts["s001"]["available"] is False

    def test_provider_options_are_local_only(self, switcher_fixture):
        svc, _, _ = switcher_fixture
        values = {o["value"] for o in svc.list_options("provider")}
        # The disabled cloud provider is excluded; only enabled non-cloud.
        assert values == {"local"}

    def test_provider_options_use_enabled_cloud_oauth_providers_for_cloud_fabric(self, switcher_fixture):
        svc, reg, _ = switcher_fixture
        cloud = reg.get("cloud-x")
        cloud.enabled = True
        cloud.extra["oauth_provider"] = "claude"
        svc.set_axis("fabric", "cloud")
        values = {o["value"] for o in svc.list_options("provider")}
        assert values == {"claude"}

    def test_model_options_include_models_and_role_aliases(self, switcher_fixture):
        svc, _, _ = switcher_fixture
        opts = {o["value"]: o for o in svc.list_options("model")}
        # Concrete enabled non-cloud models present (including conv-a), cloud absent.
        assert "gen-a" in opts and "code-a" in opts and "conv-a" in opts
        assert "cloud-x" not in opts
        # Public role aliases per §01 G1: general/coding/judge/embedding only.
        # 'conversation' is an INTERNAL role; conv-* models are reachable by
        # model ID but 'conversation' is NOT a public switcher alias until VS2
        # ratifies it in the proto contract (§06 SW3). See switchers.py comment.
        assert opts["general"]["available"] is True
        assert opts["coding"]["available"] is True
        assert "conversation" not in opts  # internal role, not a public alias
        assert opts["judge"]["available"] is False
        assert opts["embedding"]["available"] is False


class TestSwitcherSet:
    def test_set_fabric_local(self, switcher_fixture):
        svc, _, _ = switcher_fixture
        state = svc.set_axis("fabric", "local")
        assert state["fabric"] == "local"

    def test_set_invalid_value_rejected(self, switcher_fixture):
        svc, _, _ = switcher_fixture
        with pytest.raises(ValueError):
            svc.set_axis("fabric", "warp")

    def test_set_unknown_axis_rejected(self, switcher_fixture):
        svc, _, _ = switcher_fixture
        with pytest.raises(ValueError):
            svc.set_axis("agent", "rommie")

    def test_set_model_pins_role(self, switcher_fixture):
        svc, _, active = switcher_fixture
        state = svc.set_axis("model", "code-a")
        assert state["model"] == "code-a"
        # Setting a concrete model pins it for its role.
        assert active.get("coding") == "code-a"
