"""Tests for model registry loader, validator, and active-role manager."""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

import pytest
import yaml

from agents.packages.gateway.gateway.registry import ModelRegistry, ActiveRoleManager, ModelEntry, RegistryError


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
                        "provider": "vllm",
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
            "provider": "llama.cpp",
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
                "a": {"id": "a", "provider": "vllm", "role": "general", "context_length": 1},
                "b": {"id": "b", "provider": "vllm", "role": "coding", "context_length": 1},
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
                "qwen-coder-s001": {
                    "id": "qwen-coder-s001",
                    "provider": "vllm",
                    "role": "coding",
                    "context_length": 1,
                    "api_base": "http://s001:8001/v1",
                },
            },
        }))
        monkeypatch.setenv("GATEWAY_MODEL_QWEN_CODER_S001_API_BASE", "http://local-coder:8000/v1")

        reg = ModelRegistry(registry_path=reg_path, schema_path=schema_path)

        assert reg.get("qwen-coder-s001").api_base == "http://local-coder:8000/v1"

    def test_default_registry_declares_cluster_inference_fabric(self):
        gateway_root = Path(__file__).resolve().parents[1]
        registry_path = gateway_root / "registry" / "models.yaml"
        schema_path = gateway_root / "registry" / "schema.json"

        reg = ModelRegistry(registry_path=registry_path, schema_path=schema_path)

        general = reg.list_by_role("general")
        judge = reg.list_by_role("judge")
        coding = reg.list_by_role("coding")

        assert {m.id for m in general} >= {"local-reasoner-s001", "local-reasoner-s002"}
        assert {m.provider for m in general} == {"llama.cpp"}
        assert all(m.gpu == "cpu-ram-offload" for m in general)

        assert {m.id for m in judge} >= {"local-judge-s001", "local-judge-s002"}
        assert {m.provider for m in judge} == {"llama.cpp"}
        assert all(m.gpu == "cpu-ram-offload" for m in judge)

        gpu_coders = [m for m in coding if m.provider == "vllm" and m.enabled]
        assert {m.id for m in gpu_coders} == {"qwen-coder-s001", "qwen-coder-s002"}
        assert {m.gpu for m in gpu_coders} == {"s001-rtx3090", "s002-rtx3090"}
        assert all(not m.cloud for m in gpu_coders)

    def test_default_registry_env_override_names_match_cluster_compose(self):
        repo_root = Path(__file__).resolve().parents[3]
        compose = (repo_root / "packages" / "deploy" / "docker-compose.cluster.yml").read_text(encoding="utf-8")
        gateway_root = Path(__file__).resolve().parents[1]
        registry_path = gateway_root / "registry" / "models.yaml"
        schema_path = gateway_root / "registry" / "schema.json"

        reg = ModelRegistry(registry_path=registry_path, schema_path=schema_path)
        for model_id in (
            "local-reasoner-s001",
            "local-reasoner-s002",
            "local-judge-s001",
            "local-judge-s002",
            "qwen-coder-s001",
            "qwen-coder-s002",
            "nvcf-burst-coder",
        ):
            env_model_id = "".join(ch if ch.isalnum() else "_" for ch in model_id).upper()
            assert f"GATEWAY_MODEL_{env_model_id}_API_BASE=" in compose
            assert reg.get(model_id) is not None


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
        mgr.set("coding", "qwen-coder-27b")
        # Re-instantiate
        mgr2 = ActiveRoleManager(active_path=active_path)
        assert mgr2.get("coding") == "qwen-coder-27b"

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
        assert mgr.get("judge") is None
        assert mgr.get("embedding") is None
