"""Model registry loader, validator, and active-role manager."""

from __future__ import annotations

import json
import os
import uuid
from pathlib import Path
from typing import Any

import yaml
from jsonschema import validate, ValidationError

DEFAULT_REGISTRY_PATH = Path(os.environ.get("GATEWAY_REGISTRY_PATH", Path(__file__).resolve().parent.parent / "registry" / "models.yaml"))
DEFAULT_ACTIVE_PATH = Path(os.environ.get("GATEWAY_ACTIVE_PATH", Path(__file__).resolve().parent.parent / "registry" / "active.yaml"))
DEFAULT_SCHEMA_PATH = Path(os.environ.get("GATEWAY_SCHEMA_PATH", Path(__file__).resolve().parent.parent / "registry" / "schema.json"))


class RegistryError(Exception):
    pass


class ModelEntry:
    def __init__(self, data: dict[str, Any]) -> None:
        self.id: str = data["id"]
        self.name: str = data.get("name", self.id)
        self.provider: str = data["provider"]
        self.model: str = data.get("model", self.id)
        self.api_base: str | None = _env_override(self.id, "API_BASE") or data.get("api_base")
        self.api_key: str | None = data.get("api_key")
        self.api_key_env: str | None = data.get("api_key_env")
        self.role: str = data.get("role", "general")
        self.context_length: int = int(data.get("context_length", 32768))
        self.quant: str | None = data.get("quant")
        self.gpu: str | None = data.get("gpu")
        self.tensor_parallel: int | None = data.get("tensor_parallel")
        self.fallback_model: str | None = data.get("fallback_model")
        self.enabled: bool = bool(data.get("enabled", True))
        self.cloud: bool = bool(data.get("cloud", False))
        self.extra: dict[str, Any] = data.get("extra", {})

    def resolve_api_key(self) -> str | None:
        if self.api_key:
            return self.api_key
        if self.api_key_env:
            return os.environ.get(self.api_key_env)
        return None

    def to_openai_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "object": "model",
            "created": 0,
            "owned_by": "agents",
        }


class ModelRegistry:
    def __init__(self, registry_path: Path | None = None, schema_path: Path | None = None) -> None:
        self.registry_path = registry_path or DEFAULT_REGISTRY_PATH
        self.schema_path = schema_path or DEFAULT_SCHEMA_PATH
        self._models: dict[str, ModelEntry] = {}
        self._schema: dict[str, Any] | None = None
        self.load()

    def _load_schema(self) -> dict[str, Any] | None:
        if not self.schema_path.exists():
            return None
        with open(self.schema_path, "r", encoding="utf-8") as f:
            return json.load(f)

    def load(self) -> None:
        if not self.registry_path.exists():
            raise RegistryError(f"Registry file not found: {self.registry_path}")

        with open(self.registry_path, "r", encoding="utf-8") as f:
            raw = yaml.safe_load(f)

        if raw is None:
            raise RegistryError("Registry file is empty")

        schema = self._load_schema()
        if schema is not None:
            try:
                validate(instance=raw, schema=schema)
            except ValidationError as exc:
                raise RegistryError(f"Registry validation failed: {exc.message}") from exc

        models_data = raw.get("models", {})
        try:
            if isinstance(models_data, list):
                self._models = {m["id"]: ModelEntry(m) for m in models_data}
            elif isinstance(models_data, dict):
                self._models = {k: ModelEntry(v) for k, v in models_data.items()}
            else:
                raise RegistryError("models must be a list or dict")
        except (KeyError, TypeError) as exc:
            raise RegistryError(f"Invalid model entry: {exc}") from exc

    def save(self) -> None:
        payload = {
            "schema_version": "gateway-registry-v1",
            "models": {},
        }
        for mid, entry in self._models.items():
            payload["models"][mid] = {
                "id": entry.id,
                "name": entry.name,
                "provider": entry.provider,
                "model": entry.model,
                "api_base": entry.api_base,
                "api_key": entry.api_key,
                "api_key_env": entry.api_key_env,
                "role": entry.role,
                "context_length": entry.context_length,
                "quant": entry.quant,
                "gpu": entry.gpu,
                "tensor_parallel": entry.tensor_parallel,
                "fallback_model": entry.fallback_model,
                "enabled": entry.enabled,
                "cloud": entry.cloud,
                "extra": entry.extra,
            }
            # Strip None values for cleanliness
            payload["models"][mid] = {k: v for k, v in payload["models"][mid].items() if v is not None}

        self.registry_path.parent.mkdir(parents=True, exist_ok=True)
        with open(self.registry_path, "w", encoding="utf-8") as f:
            yaml.safe_dump(payload, f, sort_keys=False, allow_unicode=True)

    def get(self, model_id: str) -> ModelEntry | None:
        return self._models.get(model_id)

    def list_all(self) -> list[ModelEntry]:
        return list(self._models.values())

    def list_enabled(self) -> list[ModelEntry]:
        return [m for m in self._models.values() if m.enabled]

    def list_by_role(self, role: str) -> list[ModelEntry]:
        return [m for m in self._models.values() if m.role == role and m.enabled]

    def add(self, entry: ModelEntry) -> None:
        self._models[entry.id] = entry
        self.save()

    def remove(self, model_id: str) -> bool:
        if model_id in self._models:
            del self._models[model_id]
            self.save()
            return True
        return False

    def update(self, model_id: str, fields: dict[str, Any]) -> ModelEntry | None:
        entry = self._models.get(model_id)
        if entry is None:
            return None
        for k, v in fields.items():
            if hasattr(entry, k):
                setattr(entry, k, v)
        self.save()
        return entry


class ActiveRoleManager:
    def __init__(self, active_path: Path | None = None) -> None:
        self.active_path = active_path or DEFAULT_ACTIVE_PATH
        self._active: dict[str, str | None] = {}
        self.load()

    def load(self) -> None:
        if not self.active_path.exists():
            self._active = {
                "general": None,
                "coding": None,
                "judge": None,
                "embedding": None,
            }
            self.save()
            return

        with open(self.active_path, "r", encoding="utf-8") as f:
            raw = yaml.safe_load(f)

        if raw is None:
            self._active = {}
        else:
            self._active = raw.get("active", {})

    def save(self) -> None:
        self.active_path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "schema_version": "gateway-active-v1",
            "active": self._active,
        }
        with open(self.active_path, "w", encoding="utf-8") as f:
            yaml.safe_dump(payload, f, sort_keys=False, allow_unicode=True)

    def get(self, role: str) -> str | None:
        return self._active.get(role)

    def set(self, role: str, model_id: str | None) -> str | None:
        previous = self._active.get(role)
        self._active[role] = model_id
        self.save()
        return previous

    def all(self) -> dict[str, str | None]:
        return dict(self._active)


def generate_request_id() -> str:
    return f"agents-req-{uuid.uuid4().hex[:12]}"


def _env_override(model_id: str, field: str) -> str | None:
    env_name = f"GATEWAY_MODEL_{_env_model_id(model_id)}_{field}"
    value = os.environ.get(env_name)
    if value is None or value.strip() == "":
        return None
    return value


def _env_model_id(model_id: str) -> str:
    return "".join(ch if ch.isalnum() else "_" for ch in model_id).upper()
