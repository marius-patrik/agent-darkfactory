"""Immutable local model registry loader and validator."""

from __future__ import annotations

import json
import uuid
from pathlib import Path
from typing import Any

import yaml
from jsonschema import FormatChecker, ValidationError, validate

DEFAULT_REGISTRY_PATH = Path(__file__).resolve().parent.parent / "registry" / "models.yaml"
DEFAULT_SCHEMA_PATH = Path(__file__).resolve().parent.parent / "registry" / "schema.json"

# The public role aliases a request may target (resolved by Router._resolve_role).
# Embedding is hidden until a supported embedding model is registered.
ROLE_NAMES = ("general", "coding", "conversation", "judge")


class RegistryError(Exception):
    pass


class ModelEntry:
    def __init__(self, data: dict[str, Any]) -> None:
        self.id: str = data["id"]
        self.name: str = data.get("name", self.id)
        self.provider: str = data["provider"]
        self.model: str = data["model"]
        self.api_base: str = data["api_base"]
        self.role: str = data["role"]
        self.context_length: int = int(data["context_length"])
        self.quant: str | None = data.get("quant")
        self.gpu: str | None = data.get("gpu")
        self.tensor_parallel: int | None = data.get("tensor_parallel")
        self.enabled: bool = bool(data["enabled"])

    def to_openai_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "object": "model",
            "created": 0,
            "owned_by": "agent-os",
            "role": self.role,
            "context_length": self.context_length,
        }


class ModelRegistry:
    def __init__(self, registry_path: Path | None = None, schema_path: Path | None = None) -> None:
        self.registry_path = registry_path or DEFAULT_REGISTRY_PATH
        self.schema_path = schema_path or DEFAULT_SCHEMA_PATH
        self._models: dict[str, ModelEntry] = {}
        self._schema: dict[str, Any] | None = None
        self.load()

    def _load_schema(self) -> dict[str, Any]:
        if not self.schema_path.exists():
            raise RegistryError(f"Registry schema not found: {self.schema_path}")
        with open(self.schema_path, "r", encoding="utf-8") as f:
            return json.load(f)

    def load(self) -> None:
        if not self.registry_path.exists():
            raise RegistryError(f"Registry file not found: {self.registry_path}")

        with open(self.registry_path, "r", encoding="utf-8") as f:
            raw = yaml.safe_load(f)

        if raw is None:
            raise RegistryError("Registry file is empty")
        if not isinstance(raw, dict):
            raise RegistryError("Registry must be a YAML object")

        schema = self._load_schema()
        try:
            validate(instance=raw, schema=schema, format_checker=FormatChecker())
        except ValidationError as exc:
            raise RegistryError(f"Registry validation failed: {exc.message}") from exc

        models_data = raw.get("models", {})
        try:
            if not isinstance(models_data, dict):
                raise RegistryError("models must be an object")
            models = {key: ModelEntry(value) for key, value in models_data.items()}
            mismatches = [key for key, entry in models.items() if key != entry.id]
            if mismatches:
                raise RegistryError(f"Registry model keys must match entry ids: {', '.join(mismatches)}")
            self._models = models
        except (KeyError, TypeError) as exc:
            raise RegistryError(f"Invalid model entry: {exc}") from exc

    def get(self, model_id: str) -> ModelEntry | None:
        return self._models.get(model_id)

    def list_all(self) -> list[ModelEntry]:
        return list(self._models.values())

    def list_enabled(self) -> list[ModelEntry]:
        return [m for m in self._models.values() if m.enabled]

    def list_by_role(self, role: str) -> list[ModelEntry]:
        return [m for m in self._models.values() if m.role == role and m.enabled]


def generate_request_id() -> str:
    return f"agents-req-{uuid.uuid4().hex[:12]}"
