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
    def test_inferctl_overlay_is_runtime_only_and_refreshes_changed_ports(self, tmp_registry):
        reg_path, schema_path, td = tmp_registry
        schema_path.write_text(json.dumps({"type": "object"}))
        definition = {
            "id": "managed",
            "provider": "local",
            "model": "managed",
            "role": "general",
            "context_length": 1024,
            "enabled": True,
            "extra": {"inferctl_managed": True},
        }
        reg_path.write_text(yaml.safe_dump({"schema_version": "gateway-registry-v1", "models": {"managed": definition}}))
        status_path = Path(td) / "inferctl.yaml"
        status_path.write_text(
            yaml.safe_dump({"schema_version": "inferctl-local-engines-v1", "engines": {"managed": {"status": "healthy", "api_base": "http://127.0.0.1:9101/v1"}}})
        )
        reg = ModelRegistry(reg_path, schema_path, status_path)
        assert reg.get("managed").api_base == "http://127.0.0.1:9101/v1"
        assert "api_base" not in reg._definitions["managed"]

        status_path.write_text(
            yaml.safe_dump({"schema_version": "inferctl-local-engines-v1", "engines": {"managed": {"healthy": True, "api_base": "http://127.0.0.1:9202/v1"}}})
        )
        assert reg.get("managed").api_base == "http://127.0.0.1:9202/v1"
        assert "inferctl" not in reg._definitions["managed"]["extra"]

    def test_inferctl_missing_and_unhealthy_engines_are_unavailable(self, tmp_registry):
        reg_path, schema_path, td = tmp_registry
        schema_path.write_text(json.dumps({"type": "object"}))
        definition = {
            "id": "managed",
            "provider": "local",
            "model": "managed",
            "role": "general",
            "context_length": 1024,
            "enabled": True,
            "extra": {"inferctl_managed": True},
        }
        reg_path.write_text(yaml.safe_dump({"schema_version": "gateway-registry-v1", "models": {"managed": definition}}))
        status_path = Path(td) / "inferctl.yaml"
        reg = ModelRegistry(reg_path, schema_path, status_path)
        assert reg.list_enabled() == []

        status_path.write_text(
            yaml.safe_dump({"schema_version": "inferctl-local-engines-v1", "engines": {"managed": {"status": "unhealthy", "api_base": "http://127.0.0.1:9101/v1"}}})
        )
        assert reg.list_enabled() == []
        assert reg.get("managed").extra["inferctl"]["status"] == "unhealthy"

    def test_malformed_status_disables_managed_models_without_breaking_registry(self, tmp_registry):
        reg_path, schema_path, td = tmp_registry
        schema_path.write_text(json.dumps({"type": "object"}))
        definition = {
            "id": "managed",
            "provider": "local",
            "model": "managed",
            "role": "general",
            "context_length": 1024,
            "enabled": True,
            "extra": {"inferctl_managed": True},
        }
        reg_path.write_text(yaml.safe_dump({"schema_version": "gateway-registry-v1", "models": {"managed": definition}}))
        status_path = Path(td) / "inferctl.yaml"
        status_path.write_text("schema_version: [unterminated\n")
        reg = ModelRegistry(reg_path, schema_path, status_path)
        assert reg.list_enabled() == []
        assert reg.get("managed").extra["inferctl"]["status"] == "malformed"

    def test_malformed_engine_is_isolated_and_invalid_url_is_disabled(self, tmp_registry):
        reg_path, schema_path, td = tmp_registry
        schema_path.write_text(json.dumps({"type": "object"}))

        def managed(model_id):
            return {
                "id": model_id,
                "provider": "local",
                "model": model_id,
                "role": "general",
                "context_length": 1024,
                "enabled": True,
                "extra": {"inferctl_managed": True},
            }

        reg_path.write_text(yaml.safe_dump({
            "schema_version": "gateway-registry-v1",
            "models": {
                model_id: managed(model_id)
                for model_id in ("healthy", "broken", "bad-url", "bad-brackets", "bad-port", "bad-health")
            },
        }))
        status_path = Path(td) / "inferctl.yaml"
        status_path.write_text(yaml.safe_dump({
            "schema_version": "inferctl-local-engines-v1",
            "engines": {
                "healthy": {"status": "healthy", "api_base": "http://127.0.0.1:9101/v1"},
                "broken": "not-an-object",
                "bad-url": {"status": "healthy", "api_base": "file:///tmp/socket"},
                "bad-brackets": {"status": "healthy", "api_base": "http://[::1"},
                "bad-port": {"status": "healthy", "api_base": "http://localhost:not-a-port/v1"},
                "bad-health": {
                    "status": "healthy",
                    "healthy": "false",
                    "api_base": "http://127.0.0.1:9202/v1",
                },
            },
        }))
        reg = ModelRegistry(reg_path, schema_path, status_path)
        assert [entry.id for entry in reg.list_enabled()] == ["healthy"]
        assert reg.get("broken").extra["inferctl"]["status"] == "malformed"
        assert reg.get("bad-url").extra["inferctl"]["status"] == "malformed"
        assert reg.get("bad-brackets").extra["inferctl"]["status"] == "malformed"
        assert reg.get("bad-port").extra["inferctl"]["status"] == "malformed"
        assert reg.get("bad-health").extra["inferctl"]["status"] == "malformed"

    def test_stopped_lifecycle_cannot_be_overridden_by_stale_healthy_flag(self, tmp_registry):
        reg_path, schema_path, td = tmp_registry
        schema_path.write_text(json.dumps({"type": "object"}))
        definition = {
            "id": "managed",
            "provider": "local",
            "model": "managed",
            "role": "general",
            "context_length": 1024,
            "enabled": True,
            "extra": {"inferctl_managed": True},
        }
        reg_path.write_text(yaml.safe_dump({"schema_version": "gateway-registry-v1", "models": {"managed": definition}}))
        status_path = Path(td) / "inferctl.yaml"
        status_path.write_text(yaml.safe_dump({
            "schema_version": "inferctl-local-engines-v1",
            "engines": {
                "managed": {
                    "healthy": True,
                    "status": "stopped",
                    "api_base": "http://127.0.0.1:9101/v1",
                },
            },
        }))
        reg = ModelRegistry(reg_path, schema_path, status_path)
        assert reg.list_enabled() == []
        assert reg.get("managed").extra["inferctl"]["status"] == "stopped"

    def test_runtime_refresh_fails_closed_on_invalid_utf8(self, tmp_registry):
        reg_path, schema_path, td = tmp_registry
        schema_path.write_text(json.dumps({"type": "object"}))
        definition = {
            "id": "managed",
            "provider": "local",
            "model": "managed",
            "role": "general",
            "context_length": 1024,
            "enabled": True,
            "extra": {"inferctl_managed": True},
        }
        reg_path.write_text(yaml.safe_dump({"schema_version": "gateway-registry-v1", "models": {"managed": definition}}))
        status_path = Path(td) / "inferctl.yaml"
        status_path.write_text(yaml.safe_dump({
            "schema_version": "inferctl-local-engines-v1",
            "engines": {"managed": {"status": "healthy", "api_base": "http://127.0.0.1:9101/v1"}},
        }))
        reg = ModelRegistry(reg_path, schema_path, status_path)
        assert [entry.id for entry in reg.list_enabled()] == ["managed"]

        status_path.write_bytes(b"\xff\xfe\x80invalid")
        assert reg.list_enabled() == []
        assert reg.get("managed").extra["inferctl"]["status"] == "malformed"

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

    def test_schema_requires_endpoint_only_for_unmanaged_models(self, tmp_registry):
        gateway_root = Path(__file__).resolve().parents[1]
        schema_path = gateway_root / "registry" / "schema.json"
        reg_path, _, _ = tmp_registry
        base = {
            "id": "model",
            "provider": "local",
            "model": "model",
            "role": "general",
            "context_length": 1024,
            "enabled": True,
        }
        reg_path.write_text(yaml.safe_dump({"schema_version": "gateway-registry-v1", "models": {"model": base}}))
        with pytest.raises(RegistryError, match="api_base"):
            ModelRegistry(reg_path, schema_path)

        managed = {**base, "extra": {"inferctl_managed": True}}
        reg_path.write_text(yaml.safe_dump({"schema_version": "gateway-registry-v1", "models": {"model": managed}}))
        assert ModelRegistry(reg_path, schema_path).get("model").inferctl_managed is True

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

        # Static templates have no live endpoint until inferctl reports one.
        assert reg.list_enabled() == []
        for m in reg.list_all():
            assert m.provider == "local"
            assert m.enabled is False
            assert m.api_base is None
            assert m.inferctl_managed is True

        # Every public role alias is served by the immutable source registry.
        general = {m.id for m in reg.list_by_role("general")}
        coding = {m.id for m in reg.list_by_role("coding")}
        conversation = {m.id for m in reg.list_by_role("conversation")}
        judge = {m.id for m in reg.list_by_role("judge")}
        assert general == set()
        assert coding == set()
        assert conversation == set()
        assert judge == set()
