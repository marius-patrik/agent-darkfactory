"""Tests for model registry loader, validator, and active-role manager."""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

import pytest
import yaml

from agentos_gateway.registry import ModelRegistry, ActiveRoleManager, ModelEntry, RegistryError


@pytest.fixture
def tmp_registry():
    with tempfile.TemporaryDirectory() as td:
        reg_path = Path(td) / "models.yaml"
        active_path = Path(td) / "active.yaml"
        schema_path = Path(td) / "schema.json"
        yield reg_path, active_path, schema_path, td


class TestModelRegistry:
    def test_load_valid_registry(self, tmp_registry):
        reg_path, _, schema_path, _ = tmp_registry
        schema = {
            "type": "object",
            "required": ["schema_version", "models"],
            "properties": {
                "schema_version": {"type": "string"},
                "models": {"type": "object"},
            },
        }
        schema_path.write_text(json.dumps(schema))
        reg_path.write_text(
            yaml.safe_dump({
                "schema_version": "gateway-registry-v1",
                "models": {
                    "qwen8b": {
                        "id": "qwen8b",
                        "provider": "local",
                        "role": "general",
                        "context_length": 32768,
                        "enabled": True,
                        "cloud": False,
                    }
                },
            })
        )
        reg = ModelRegistry(registry_path=reg_path, schema_path=schema_path)
        assert reg.get("qwen8b") is not None
        assert reg.get("qwen8b").context_length == 32768

    def test_load_invalid_registry_raises(self, tmp_registry):
        reg_path, _, schema_path, _ = tmp_registry
        schema = {
            "type": "object",
            "required": ["schema_version", "models"],
            "properties": {
                "schema_version": {"type": "string"},
                "models": {"type": "object"},
            },
        }
        schema_path.write_text(json.dumps(schema))
        reg_path.write_text(
            yaml.safe_dump({
                "schema_version": "gateway-registry-v1",
                "models": {
                    "bad": {"id": "bad"}  # missing required fields
                },
            })
        )
        with pytest.raises(RegistryError):
            ModelRegistry(registry_path=reg_path, schema_path=schema_path)

    def test_add_and_remove_model(self, tmp_registry):
        reg_path, _, schema_path, _ = tmp_registry
        schema_path.write_text(json.dumps({"type": "object", "properties": {"schema_version": {"type": "string"}, "models": {"type": "object"}}}))
        reg_path.write_text(yaml.safe_dump({"schema_version": "gateway-registry-v1", "models": {}}))
        reg = ModelRegistry(registry_path=reg_path, schema_path=schema_path)
        entry = ModelEntry({
            "id": "test-model",
            "provider": "local",
            "role": "coding",
            "context_length": 4096,
        })
        reg.add(entry)
        assert reg.get("test-model") is not None
        reg.remove("test-model")
        assert reg.get("test-model") is None

    def test_list_by_role(self, tmp_registry):
        reg_path, _, schema_path, _ = tmp_registry
        schema_path.write_text(json.dumps({"type": "object", "properties": {"schema_version": {"type": "string"}, "models": {"type": "object"}}}))
        reg_path.write_text(yaml.safe_dump({
            "schema_version": "gateway-registry-v1",
            "models": {
                "a": {"id": "a", "provider": "local", "role": "general", "context_length": 1},
                "b": {"id": "b", "provider": "local", "role": "coding", "context_length": 1},
            },
        }))
        reg = ModelRegistry(registry_path=reg_path, schema_path=schema_path)
        assert len(reg.list_by_role("general")) == 1
        assert reg.list_by_role("general")[0].id == "a"

    def test_api_key_resolution(self, tmp_registry, monkeypatch):
        reg_path, _, schema_path, _ = tmp_registry
        schema_path.write_text(json.dumps({"type": "object", "properties": {"schema_version": {"type": "string"}, "models": {"type": "object"}}}))
        reg_path.write_text(yaml.safe_dump({
            "schema_version": "gateway-registry-v1",
            "models": {
                "k": {"id": "k", "provider": "litellm-remote", "role": "general", "context_length": 1, "api_key_env": "TEST_KEY"},
            },
        }))
        monkeypatch.setenv("TEST_KEY", "secret123")
        reg = ModelRegistry(registry_path=reg_path, schema_path=schema_path)
        assert reg.get("k").resolve_api_key() == "secret123"

    def test_api_base_can_be_overridden_from_model_env(self, tmp_registry, monkeypatch):
        reg_path, _, schema_path, _ = tmp_registry
        schema_path.write_text(json.dumps({"type": "object", "properties": {"schema_version": {"type": "string"}, "models": {"type": "object"}}}))
        reg_path.write_text(yaml.safe_dump({
            "schema_version": "gateway-registry-v1",
            "models": {
                "coder-32b-awq": {
                    "id": "coder-32b-awq",
                    "provider": "local",
                    "role": "coding",
                    "context_length": 1,
                    "api_base": "http://127.0.0.1:8002/v1",
                },
            },
        }))
        monkeypatch.setenv("GATEWAY_MODEL_CODER_32B_AWQ_API_BASE", "http://local-coder:8000/v1")

        reg = ModelRegistry(registry_path=reg_path, schema_path=schema_path)

        assert reg.get("coder-32b-awq").api_base == "http://local-coder:8000/v1"

    def test_default_registry_declares_vs1_local_fabric(self):
        """The shipped models.yaml seeds the five VS1 local engines (§13 / VS1)."""
        gateway_root = Path(__file__).resolve().parents[1]
        registry_path = gateway_root / "registry" / "models.yaml"
        schema_path = gateway_root / "registry" / "schema.json"

        reg = ModelRegistry(registry_path=registry_path, schema_path=schema_path)

        all_ids = {m.id for m in reg.list_all()}
        assert all_ids == {
            "qwen3-8b",
            "coder-32b-awq",
            "qwen2.5-7b-q4",
            "conv-7b-1m",
            "conv-14b-1m",
            "claude-subscription",
            "codex-subscription",
            "kimi-subscription",
            "agy-subscription",
        }

        # All VS1 models are local, enabled, never-cloud, on loopback api_bases.
        for m in reg.list_enabled():
            assert m.provider == "local"
            assert m.enabled is True
            assert m.cloud is False
            assert m.api_base is not None
            assert m.api_base.startswith("http://127.0.0.1:")
            assert m.api_base.endswith("/v1")

        # Role aliases general/coding/conversation are all served.
        general = {m.id for m in reg.list_by_role("general")}
        coding = {m.id for m in reg.list_by_role("coding")}
        conversation = {m.id for m in reg.list_by_role("conversation")}
        assert general == {"qwen3-8b", "qwen2.5-7b-q4"}
        assert coding == {"coder-32b-awq"}
        assert conversation == {"conv-7b-1m", "conv-14b-1m"}

    def test_default_registry_has_no_reachable_cloud_entry(self):
        """VS1 ships zero enabled cloud models (the never-meter posture)."""
        gateway_root = Path(__file__).resolve().parents[1]
        registry_path = gateway_root / "registry" / "models.yaml"
        schema_path = gateway_root / "registry" / "schema.json"

        reg = ModelRegistry(registry_path=registry_path, schema_path=schema_path)
        clouds = [m for m in reg.list_all() if m.cloud]
        assert {m.extra["oauth_provider"] for m in clouds} == {"claude", "codex", "kimi", "agy"}
        assert all(not m.enabled for m in clouds)

    def test_default_registry_env_override_names_resolve(self, monkeypatch):
        """Each seeded model's GATEWAY_MODEL_<ID>_API_BASE override is honoured."""
        gateway_root = Path(__file__).resolve().parents[1]
        registry_path = gateway_root / "registry" / "models.yaml"
        schema_path = gateway_root / "registry" / "schema.json"

        for model_id in ("qwen3-8b", "coder-32b-awq", "qwen2.5-7b-q4", "conv-7b-1m", "conv-14b-1m"):
            env_model_id = "".join(ch if ch.isalnum() else "_" for ch in model_id).upper()
            monkeypatch.setenv(f"GATEWAY_MODEL_{env_model_id}_API_BASE", f"http://override-{env_model_id}:9000/v1")

        reg = ModelRegistry(registry_path=registry_path, schema_path=schema_path)
        for model_id in ("qwen3-8b", "coder-32b-awq", "qwen2.5-7b-q4", "conv-7b-1m", "conv-14b-1m"):
            env_model_id = "".join(ch if ch.isalnum() else "_" for ch in model_id).upper()
            assert reg.get(model_id) is not None
            assert reg.get(model_id).api_base == f"http://override-{env_model_id}:9000/v1"


class TestActiveRoleManager:
    def test_load_and_set(self, tmp_registry):
        _, active_path, _, _ = tmp_registry
        mgr = ActiveRoleManager(active_path=active_path)
        assert mgr.get("general") is None
        prev = mgr.set("general", "qwen8b")
        assert prev is None
        assert mgr.get("general") == "qwen8b"
        prev2 = mgr.set("general", "other")
        assert prev2 == "qwen8b"

    def test_persistence(self, tmp_registry):
        _, active_path, _, _ = tmp_registry
        mgr = ActiveRoleManager(active_path=active_path)
        mgr.set("coding", "coder-32b-awq")
        # Re-instantiate
        mgr2 = ActiveRoleManager(active_path=active_path)
        assert mgr2.get("coding") == "coder-32b-awq"

    def test_all_roles(self, tmp_registry):
        _, active_path, _, _ = tmp_registry
        mgr = ActiveRoleManager(active_path=active_path)
        mgr.set("general", "a")
        mgr.set("coding", "b")
        assert mgr.all()["general"] == "a"
        assert mgr.all()["coding"] == "b"

    def test_default_active_unpins_roles_for_node_agnostic_routing(self):
        gateway_root = Path(__file__).resolve().parents[1]
        active_path = gateway_root / "registry" / "active.yaml"
        mgr = ActiveRoleManager(active_path=active_path)
        assert mgr.get("general") is None
        assert mgr.get("coding") is None
        assert mgr.get("conversation") is None
        assert mgr.get("judge") is None
        assert mgr.get("embedding") is None
