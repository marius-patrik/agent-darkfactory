"""Immutable local model registry loader and validator."""

from __future__ import annotations

import json
import os
import uuid
from copy import deepcopy
from pathlib import Path
from typing import Any

import yaml
from jsonschema import FormatChecker, ValidationError, validate

DEFAULT_REGISTRY_PATH = Path(__file__).resolve().parent.parent / "registry" / "models.yaml"
DEFAULT_SCHEMA_PATH = Path(__file__).resolve().parent.parent / "registry" / "schema.json"
DEFAULT_INFERCTL_STATUS_PATH = Path(__file__).resolve().parent.parent / "registry" / "inferctl-engines.yaml"
INFERCTL_READY_STATUSES = {"healthy", "ready", "running", "up", "available"}

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
        self.api_base: str | None = data.get("api_base")
        self.role: str = data["role"]
        self.context_length: int = int(data["context_length"])
        self.quant: str | None = data.get("quant")
        self.gpu: str | None = data.get("gpu")
        self.tensor_parallel: int | None = data.get("tensor_parallel")
        self.configured_enabled: bool = bool(data["enabled"])
        self.enabled: bool = self.configured_enabled
        self.extra: dict[str, Any] = deepcopy(data.get("extra", {}))
        self.inferctl_managed: bool = bool(self.extra.get("inferctl_managed", False))
        if self.api_base is None and not self.inferctl_managed:
            raise RegistryError(f"model {self.id} requires api_base unless inferctl_managed")

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
    def __init__(
        self,
        registry_path: Path | None = None,
        schema_path: Path | None = None,
        inferctl_status_path: Path | None = None,
    ) -> None:
        self.registry_path = registry_path or DEFAULT_REGISTRY_PATH
        self.schema_path = schema_path or DEFAULT_SCHEMA_PATH
        self.inferctl_status_path = inferctl_status_path or Path(
            os.environ.get("GATEWAY_INFERCTL_STATUS_PATH", str(DEFAULT_INFERCTL_STATUS_PATH))
        )
        self._models: dict[str, ModelEntry] = {}
        self._definitions: dict[str, dict[str, Any]] = {}
        self._status_signature: tuple[bool, int, int] | None = None
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
            self._definitions = deepcopy(models_data)
            models = {key: ModelEntry(value) for key, value in self._definitions.items()}
            mismatches = [key for key, entry in models.items() if key != entry.id]
            if mismatches:
                raise RegistryError(f"Registry model keys must match entry ids: {', '.join(mismatches)}")
            self._models = models
        except (KeyError, TypeError) as exc:
            raise RegistryError(f"Invalid model entry: {exc}") from exc
        self.refresh_runtime_status(force=True)

    def refresh_runtime_status(self, *, force: bool = False) -> None:
        signature = self._inferctl_signature()
        if not force and signature == self._status_signature:
            return
        models = {key: ModelEntry(value) for key, value in self._definitions.items()}
        statuses = self._load_inferctl_status()
        for entry in models.values():
            if not entry.inferctl_managed:
                continue
            status = statuses.get(entry.id)
            if status is None:
                entry.api_base = None
                entry.enabled = False
                entry.extra["inferctl"] = {"status": "missing", "available": False}
                continue
            api_base = _optional_string(status.get("api_base"))
            runtime_status = _inferctl_state(status)
            available = bool(api_base) and runtime_status in INFERCTL_READY_STATUSES
            entry.api_base = api_base
            entry.enabled = entry.configured_enabled and available
            entry.extra["inferctl"] = {
                "status": runtime_status,
                "api_base": api_base,
                "available": entry.enabled,
                "source": str(self.inferctl_status_path),
            }
        self._models = models
        self._status_signature = signature

    def _inferctl_signature(self) -> tuple[bool, int, int]:
        try:
            info = self.inferctl_status_path.stat()
            if not self.inferctl_status_path.is_file() or self.inferctl_status_path.is_symlink():
                raise RegistryError("inferctl status path must be a physical file")
            return True, info.st_mtime_ns, info.st_size
        except FileNotFoundError:
            return False, 0, 0

    def _load_inferctl_status(self) -> dict[str, dict[str, Any]]:
        if not self.inferctl_status_path.exists():
            return {}
        with open(self.inferctl_status_path, "r", encoding="utf-8") as f:
            raw = yaml.safe_load(f)
        if not isinstance(raw, dict) or raw.get("schema_version") != "inferctl-local-engines-v1":
            raise RegistryError("inferctl status must use schema_version inferctl-local-engines-v1")
        engines = raw.get("engines")
        if not isinstance(engines, dict):
            raise RegistryError("inferctl status engines must be an object")
        if any(not isinstance(value, dict) for value in engines.values()):
            raise RegistryError("inferctl engine status entries must be objects")
        return {str(key): value for key, value in engines.items()}

    def get(self, model_id: str) -> ModelEntry | None:
        self.refresh_runtime_status()
        return self._models.get(model_id)

    def list_all(self) -> list[ModelEntry]:
        self.refresh_runtime_status()
        return list(self._models.values())

    def list_enabled(self) -> list[ModelEntry]:
        self.refresh_runtime_status()
        return [m for m in self._models.values() if m.enabled]

    def list_by_role(self, role: str) -> list[ModelEntry]:
        self.refresh_runtime_status()
        return [m for m in self._models.values() if m.role == role and m.enabled]


def generate_request_id() -> str:
    return f"agents-req-{uuid.uuid4().hex[:12]}"


def _optional_string(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _inferctl_state(status: dict[str, Any]) -> str:
    healthy = status.get("healthy")
    if isinstance(healthy, bool):
        return "healthy" if healthy else "unhealthy"
    state = _optional_string(status.get("status") or status.get("state"))
    return (state or "unknown").lower()
