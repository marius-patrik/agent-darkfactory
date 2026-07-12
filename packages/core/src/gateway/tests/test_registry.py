"""Tests for the immutable local model registry."""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

import pytest
import yaml

from llm_gateway.registry import ModelRegistry, RegistryError


@pytest.fixture
def tmp_registry():
    with tempfile.TemporaryDirectory() as td:
        reg_path = Path(td) / "models.yaml"
        schema_path = Path(td) / "schema.json"
        yield reg_path, schema_path, td


class TestModelRegistry:
    def test_load_valid_registry(self, tmp_registry):
        reg_path, schema_path, _ = tmp_registry
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
                        "model": "qwen8b",
                        "api_base": "http://127.0.0.1:8001/v1",
                        "role": "general",
                        "context_length": 32768,
                        "enabled": True,
                    }
                },
            })
        )
        reg = ModelRegistry(registry_path=reg_path, schema_path=schema_path)
        assert reg.get("qwen8b") is not None
        assert reg.get("qwen8b").context_length == 32768

    def test_load_invalid_registry_raises(self, tmp_registry):
        reg_path, schema_path, _ = tmp_registry
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

    def test_list_by_role(self, tmp_registry):
        reg_path, schema_path, _ = tmp_registry
        schema_path.write_text(json.dumps({"type": "object", "properties": {"schema_version": {"type": "string"}, "models": {"type": "object"}}}))
        reg_path.write_text(yaml.safe_dump({
            "schema_version": "gateway-registry-v1",
            "models": {
                "a": {"id": "a", "provider": "local", "model": "a", "api_base": "http://127.0.0.1:1/v1", "role": "general", "context_length": 1, "enabled": True},
                "b": {"id": "b", "provider": "local", "model": "b", "api_base": "http://127.0.0.1:2/v1", "role": "coding", "context_length": 1, "enabled": True},
            },
        }))
        reg = ModelRegistry(registry_path=reg_path, schema_path=schema_path)
        assert len(reg.list_by_role("general")) == 1
        assert reg.list_by_role("general")[0].id == "a"

    def test_registry_key_must_match_model_id(self, tmp_registry):
        reg_path, schema_path, _ = tmp_registry
        schema_path.write_text(json.dumps({"type": "object", "properties": {"models": {"type": "object"}}}))
        reg_path.write_text(yaml.safe_dump({
            "schema_version": "gateway-registry-v1",
            "models": {
                "canonical-key": {
                    "id": "different-id",
                    "provider": "local",
                    "model": "backend",
                    "api_base": "http://127.0.0.1:1/v1",
                    "role": "general",
                    "context_length": 1,
                    "enabled": True,
                },
            },
        }))
        with pytest.raises(RegistryError, match="keys must match entry ids"):
            ModelRegistry(registry_path=reg_path, schema_path=schema_path)

    def test_default_registry_declares_local_fabric(self):
        """The shipped models.yaml seeds the five local engines."""
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
        }

        # Every shipped model is enabled, local, and bound to a fixed endpoint.
        for m in reg.list_enabled():
            assert m.provider == "local"
            assert m.enabled is True
            assert m.api_base is not None
            assert m.api_base.startswith("http://127.0.0.1:")
            assert m.api_base.endswith("/v1")

        # Every public role alias is served by the immutable source registry.
        general = {m.id for m in reg.list_by_role("general")}
        coding = {m.id for m in reg.list_by_role("coding")}
        conversation = {m.id for m in reg.list_by_role("conversation")}
        judge = {m.id for m in reg.list_by_role("judge")}
        assert general == {"qwen3-8b", "qwen2.5-7b-q4"}
        assert coding == {"coder-32b-awq"}
        assert conversation == {"conv-7b-1m"}
        assert judge == {"conv-14b-1m"}
